// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IERC20Permit} from "./interfaces/IERC20Permit.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";

/// @title PatronVault v1
/// @notice One deposit, many creators. A member parks USDC once; the vault lends it through an
///         ERC-4626 yield source and streams only the yield to the creators the member routes it to.
///
///         The promise, word for word:
///           We never spend your deposit. Only the interest it earns is paid out.
///           Withdraw the deposit any time.
///
///         Rules this code enforces:
///           1. No owner, no pause, no upgrade. Every parameter is a constructor argument.
///           2. Every member's position is isolated: their own shares, their own principal, their own
///              yield. One member's payouts never come out of another member's position.
///           3. settle() is permissionless and pays creators from yield shares only. Principal shares
///              (the shares it takes to redeem the principal, rounded up) are never burned by a payout.
///           4. Nothing is owed against principal. If the yield cannot cover a route, the unpaid part is
///              forgiven and the member is flagged unfunded until a later settle is covered again.
///           5. Only the member's own transaction creates, changes or removes a route.
///           6. Unrouted yield is either the member's to claim (yieldSink unset) or, in principal-only mode
///              (yieldSink set), stays in the position as a buffer for the member's routes and goes to those
///              creators when the member leaves. The member never receives yield in that mode.
///           7. The protocol fee is a fixed share of what reaches a creator, set once at deployment and capped
///              at MAX_FEE_BPS. It is never taken from a member's principal and never from unpaid amounts.
///
///         What this code cannot promise: the yield source. If the source loses money, every share
///         holder loses pro rata, this vault included. The source is chosen once, at deployment,
///         against the published screening rules, and cannot be changed afterwards.
contract PatronVault {
    // ─────────────────────────────── config (immutable) ───────────────────────────────

    IERC20 public immutable asset; // the deposit token (USDC on Base)
    IERC4626 public immutable source; // the yield source, an ERC-4626 vault whose asset() is `asset`
    uint256 public immutable minDeposit; // a member's principal is 0 (left) or at least this
    uint256 public immutable period; // the time unit for route amounts, e.g. 30 days
    bytes32 public immutable termsHash; // keccak256 of the exact member terms text; join() must quote it
    uint256 public immutable maxTotalPrincipal; // cap on all principal held, 0 = no cap (pilot sizing)
    uint256 public immutable joinDeadline; // no join() at or after this timestamp, 0 = no deadline (pilot window)
    /// @notice Principal-only mode when set: members cannot claim yield; on leave, unrouted yield goes to the
    ///         member's routes pro rata, or to this address when the member has no routes. 0 = members keep yield.
    address public immutable yieldSink;
    /// @notice Share of every creator payment kept as protocol fee, in basis points; 0 = none. Never above MAX_FEE_BPS.
    uint256 public immutable feeBps;
    /// @notice Where collected fees go. collectFees() is permissionless.
    address public immutable feeRecipient;

    uint256 public constant MAX_ROUTES = 16;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%: the most any PatronVault can ever take
    /// @dev A settle whose yield covers at least this share of what is owed keeps the member funded.
    uint256 public constant FUNDED_BPS = 9_500;

    // ─────────────────────────────── state ───────────────────────────────

    struct Member {
        uint128 principal; // asset units the member is owed back; only the member's own calls change it
        uint128 shares; // source shares held for this member
        uint64 joinedAt;
        uint64 lastSettled;
        bool funded; // the last settle was covered by yield (see FUNDED_BPS)
    }

    struct Route {
        address creator;
        uint96 amountPerPeriod; // asset units per `period`
        uint256 carry; // accrued but unpaid, in asset units * seconds; carry / period is owed now
    }

    struct RouteInput {
        address creator;
        uint96 amountPerPeriod;
    }

    mapping(address => Member) internal _members;
    mapping(address => Route[]) internal _routes;

    /// @notice Source shares set aside as protocol fee, not yet collected. Not part of any member's position.
    uint256 public feeShares;

    /// @notice creator => smallest amountPerPeriod the creator accepts on new or changed routes (0 = any)
    mapping(address => uint256) public creatorMin;
    /// @notice creator => lifetime asset units received through this vault
    mapping(address => uint256) public creatorPaid;

    uint256 public totalPrincipal;
    uint256 public memberCount;

    uint256 private _lock = 1;

    // ─────────────────────────────── events ───────────────────────────────

    event Joined(address indexed member, uint256 principal, uint256 shares, bytes32 termsHash);
    event Deposited(address indexed member, uint256 amount, uint256 principal);
    event Withdrawn(address indexed member, uint256 requested, uint256 received, uint256 principal);
    event YieldClaimed(address indexed member, uint256 amount);
    event Left(address indexed member, uint256 principal, uint256 received);
    event RouteSet(address indexed member, address indexed creator, uint256 amountPerPeriod);
    event Settled(address indexed member, uint256 owed, uint256 fromYield, uint256 paid, bool funded);
    event CreatorPaid(address indexed creator, address indexed member, uint256 amount);
    event CreatorUnpaid(address indexed creator, address indexed member, uint256 amount);
    event CreatorForgiven(address indexed creator, address indexed member, uint256 amount);
    event YieldForwarded(address indexed to, address indexed member, uint256 amount);
    event FeeAccrued(address indexed member, address indexed creator, uint256 amount);
    event FeesCollected(address indexed to, uint256 amount);
    event CreatorMinSet(address indexed creator, uint256 amountPerPeriod);

    // ─────────────────────────────── errors ───────────────────────────────

    error BadTerms();
    error AlreadyMember();
    error NotMember();
    error BelowMinimum();
    error ExceedsPrincipal();
    error ExceedsYield();
    error TooManyRoutes();
    error BelowCreatorMinimum();
    error ZeroAddress();
    error SelfRoute();
    error OwedButIlliquid();
    error CapReached();
    error JoinClosed();
    error YieldNotClaimable();
    error FeeTooHigh();
    error NoFees();
    error Reentrancy();
    error TransferFailed();
    error Overflow();

    // ─────────────────────────────── constructor ───────────────────────────────

    constructor(
        IERC4626 source_,
        uint256 minDeposit_,
        uint256 period_,
        bytes32 termsHash_,
        uint256 maxTotalPrincipal_,
        uint256 joinDeadline_,
        address yieldSink_,
        uint256 feeBps_,
        address feeRecipient_
    ) {
        if (address(source_) == address(0)) revert ZeroAddress();
        if (period_ == 0 || termsHash_ == bytes32(0)) revert BadTerms();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ != 0 && feeRecipient_ == address(0)) revert ZeroAddress();
        address asset_ = source_.asset();
        if (asset_ == address(0)) revert ZeroAddress();
        source = source_;
        asset = IERC20(asset_);
        minDeposit = minDeposit_;
        period = period_;
        termsHash = termsHash_;
        maxTotalPrincipal = maxTotalPrincipal_;
        joinDeadline = joinDeadline_;
        yieldSink = yieldSink_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        // One approval, forever. The vault never holds `asset` between transactions, so the
        // allowance only ever covers what deposit() hands to the source in the same call.
        _call(abi.encodeWithSelector(IERC20.approve.selector, address(source_), type(uint256).max));
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─────────────────────────────── member actions ───────────────────────────────

    /// @notice Join with an initial deposit. `terms` must equal `termsHash`; the transaction is the consent record.
    function join(uint256 amount, bytes32 terms) external nonReentrant {
        _join(amount, terms);
    }

    /// @notice Join and set routes in one transaction.
    function joinAndRoute(uint256 amount, bytes32 terms, RouteInput[] calldata routes) external nonReentrant {
        _join(amount, terms);
        _applyRoutes(msg.sender, routes);
    }

    /// @notice Join in one transaction with no prior approve: a USDC permit (ERC-7597 bytes signature, so an
    ///         EOA's ECDSA signature or a smart wallet's EIP-1271 one). If someone front-runs the permit, the
    ///         allowance is already there and the join still goes through.
    function joinWithPermit(
        uint256 amount,
        bytes32 terms,
        uint256 deadline,
        bytes calldata signature,
        RouteInput[] calldata routes
    ) external nonReentrant {
        try IERC20Permit(address(asset)).permit(msg.sender, address(this), amount, deadline, signature) {} catch {}
        _join(amount, terms);
        _applyRoutes(msg.sender, routes);
    }

    function _join(uint256 amount, bytes32 terms) internal {
        if (terms != termsHash) revert BadTerms();
        if (joinDeadline != 0 && block.timestamp >= joinDeadline) revert JoinClosed();
        Member storage m = _members[msg.sender];
        if (m.principal != 0) revert AlreadyMember();
        if (amount == 0 || amount < minDeposit) revert BelowMinimum();
        _checkCap(amount);

        uint256 shares = _pullAndDeposit(msg.sender, amount);
        m.principal = _u128(amount);
        m.shares = _u128(shares);
        m.joinedAt = uint64(block.timestamp); // forge-lint: disable-line(unsafe-typecast)
        m.lastSettled = uint64(block.timestamp); // forge-lint: disable-line(unsafe-typecast)
        m.funded = true;
        totalPrincipal += amount;
        memberCount += 1;
        emit Joined(msg.sender, amount, shares, terms);
    }

    /// @notice Add to the deposit. Routes are settled first, so yield earned so far is attributed before the base grows.
    function deposit(uint256 amount) external nonReentrant {
        Member storage m = _requireMember(msg.sender);
        if (amount == 0) revert BelowMinimum();
        _checkCap(amount);
        _settle(msg.sender, m);
        uint256 shares = _pullAndDeposit(msg.sender, amount);
        m.principal = _u128(m.principal + amount);
        m.shares = _u128(m.shares + shares);
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, m.principal);
    }

    /// @notice Take part of the deposit back. What remains must be 0 or at least `minDeposit`; 0 is the same as leave().
    ///         Yield is left in place. In a shortfall (the source lost money) the member takes their own loss, pro rata.
    function withdraw(uint256 amount) external nonReentrant {
        Member storage m = _requireMember(msg.sender);
        if (amount == 0) revert BelowMinimum();
        if (amount > m.principal) revert ExceedsPrincipal();
        uint256 remaining = m.principal - amount;
        if (remaining != 0 && remaining < minDeposit) revert BelowMinimum();
        _settle(msg.sender, m);
        if (remaining == 0) {
            _leave(msg.sender, m);
            return;
        }

        uint256 shares = m.shares;
        uint256 burn;
        if (shares >= source.previewWithdraw(m.principal)) {
            // Healthy: burn what `amount` costs, but never dip into the shares that back the remaining principal.
            burn = source.previewWithdraw(amount);
            uint256 maxBurn = shares - source.previewWithdraw(remaining);
            if (burn > maxBurn) burn = maxBurn;
        } else {
            // Shortfall: the position is worth less than principal. Pro rata, so the shortfall ratio never worsens.
            burn = (shares * amount) / m.principal;
        }
        m.principal = _u128(remaining);
        totalPrincipal -= amount;
        uint256 received = burn == 0 ? 0 : source.redeem(burn, msg.sender, address(this));
        m.shares = _u128(shares - burn);
        emit Withdrawn(msg.sender, amount, received, remaining);
    }

    /// @notice Claim yield that no route is owed. Routes are settled first. Reverts in principal-only mode.
    function claimYield(uint256 amount) external nonReentrant {
        if (yieldSink != address(0)) revert YieldNotClaimable();
        Member storage m = _requireMember(msg.sender);
        _settle(msg.sender, m);
        if (amount == 0 || amount > _claimable(msg.sender, m)) revert ExceedsYield();
        uint256 burned = source.withdraw(amount, msg.sender, address(this));
        m.shares = _u128(m.shares - burned);
        emit YieldClaimed(msg.sender, amount);
    }

    /// @notice Leave: settle, then redeem the position to the member and clear all routes. In principal-only
    ///         mode the unrouted yield goes to the member's routes first (or to yieldSink with no routes).
    function leave() external nonReentrant {
        Member storage m = _requireMember(msg.sender);
        _settle(msg.sender, m);
        _leave(msg.sender, m);
    }

    /// @notice Create, change or remove (amountPerPeriod = 0) a route. Routes are settled first, so a creator
    ///         is paid up to the second the route changes. Removing a route the source could not pay yet
    ///         (liquidity held back, see _settle) reverts until the source can pay it; a route whose creator
    ///         cannot receive the token is removable, and what it was owed is forgiven.
    function setRoute(address creator, uint96 amountPerPeriod) external nonReentrant {
        Member storage m = _requireMember(msg.sender);
        _settle(msg.sender, m);
        _setRoute(msg.sender, creator, amountPerPeriod);
    }

    /// @notice Several routes in one transaction, settled once. Each entry follows setRoute's rules.
    function setRoutes(RouteInput[] calldata routes) external nonReentrant {
        Member storage m = _requireMember(msg.sender);
        _settle(msg.sender, m);
        _applyRoutes(msg.sender, routes);
    }

    function _applyRoutes(address member, RouteInput[] calldata routes) internal {
        for (uint256 i = 0; i < routes.length; i++) {
            _setRoute(member, routes[i].creator, routes[i].amountPerPeriod);
        }
    }

    function _setRoute(address member, address creator, uint96 amountPerPeriod) internal {
        if (creator == address(0)) revert ZeroAddress();
        if (creator == member) revert SelfRoute();
        Route[] storage rs = _routes[member];
        uint256 n = rs.length;
        for (uint256 i = 0; i < n; i++) {
            if (rs[i].creator != creator) continue;
            if (amountPerPeriod == 0) {
                // Still owed after the settle that preceded this call: either the source could not pay (wait for
                // liquidity) or the creator address cannot receive (blocked token address). The second must not
                // trap the member.
                uint256 unpaid = rs[i].carry / period;
                if (unpaid != 0 && source.maxWithdraw(address(this)) < unpaid) revert OwedButIlliquid();
                if (unpaid != 0) emit CreatorForgiven(creator, member, unpaid);
                rs[i] = rs[n - 1];
                rs.pop();
            } else {
                if (amountPerPeriod < creatorMin[creator]) revert BelowCreatorMinimum();
                rs[i].amountPerPeriod = amountPerPeriod;
            }
            emit RouteSet(member, creator, amountPerPeriod);
            return;
        }
        if (amountPerPeriod == 0) return; // removing a route that does not exist is a no-op
        if (n >= MAX_ROUTES) revert TooManyRoutes();
        if (amountPerPeriod < creatorMin[creator]) revert BelowCreatorMinimum();
        rs.push(Route({creator: creator, amountPerPeriod: amountPerPeriod, carry: 0}));
        emit RouteSet(member, creator, amountPerPeriod);
    }

    /// @notice Anyone may settle any member: pays the member's creators from the member's yield, never principal.
    function settle(address member) external nonReentrant {
        Member storage m = _requireMember(member);
        _settle(member, m);
    }

    /// @notice The keeper's loop. Addresses that are not members are skipped, not reverted on.
    function settleMany(address[] calldata members) external nonReentrant {
        for (uint256 i = 0; i < members.length; i++) {
            Member storage m = _members[members[i]];
            if (m.principal == 0) continue;
            _settle(members[i], m);
        }
    }

    /// @notice Send the protocol fee set aside so far to feeRecipient. Anyone may call.
    function collectFees() external nonReentrant returns (uint256 amount) {
        uint256 s = feeShares;
        if (s == 0) revert NoFees();
        feeShares = 0;
        amount = source.redeem(s, feeRecipient, address(this));
        emit FeesCollected(feeRecipient, amount);
    }

    // ─────────────────────────────── creator actions ───────────────────────────────

    /// @notice A creator sets the smallest route they accept. Existing routes are unaffected; removal is always allowed.
    function setCreatorMin(uint96 amountPerPeriod) external {
        creatorMin[msg.sender] = amountPerPeriod;
        emit CreatorMinSet(msg.sender, amountPerPeriod);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice True while `member` routes to `creator` and the member's last settle was covered by yield.
    ///         Gate access on this. Call settle(member) first if you need it fresh; it is permissionless.
    function isPatron(address creator, address member) external view returns (bool) {
        Member storage m = _members[member];
        if (m.principal == 0 || !m.funded) return false;
        Route[] storage rs = _routes[member];
        for (uint256 i = 0; i < rs.length; i++) {
            if (rs[i].creator == creator) return rs[i].amountPerPeriod != 0;
        }
        return false;
    }

    function memberOf(address member) external view returns (Member memory) {
        return _members[member];
    }

    function routesOf(address member) external view returns (Route[] memory) {
        return _routes[member];
    }

    /// @notice What the position would redeem for right now, in asset units.
    function positionValue(address member) public view returns (uint256) {
        return source.previewRedeem(_members[member].shares);
    }

    /// @notice True if the position is worth less than principal: the source took a loss.
    function inShortfall(address member) external view returns (bool) {
        Member storage m = _members[member];
        return m.shares < source.previewWithdraw(m.principal);
    }

    /// @notice What settle(member) would do right now: owed to all routes, how much yield covers,
    ///         how much the source can pay today (the gap is held, not forgiven).
    function previewSettle(address member) external view returns (uint256 owed, uint256 fromYield, uint256 pay) {
        Member storage m = _members[member];
        if (m.principal == 0) return (0, 0, 0);
        Route[] storage rs = _routes[member];
        uint256 n = rs.length;
        owed = _owedNow(m, rs);
        if (owed == 0) return (0, 0, 0);
        fromYield = _fromYield(m, n);
        if (fromYield > owed) fromYield = owed;
        uint256 liquid = source.maxWithdraw(address(this));
        pay = fromYield > liquid ? liquid : fromYield;
    }

    /// @notice A conservative lower bound on what claimYield() would accept right now.
    ///         claimYield(claimableYield(member)) does not revert; the exact figure after settle may be a little higher.
    function claimableYield(address member) external view returns (uint256) {
        if (yieldSink != address(0)) return 0;
        Member storage m = _members[member];
        if (m.principal == 0) return 0;
        Route[] storage rs = _routes[member];
        uint256 n = rs.length;
        uint256 ys = _yieldShares(m);
        if (ys <= n + 1) return 0;
        uint256 free = source.previewRedeem(ys - n - 1);
        uint256 owed = _owedNow(m, rs);
        if (free <= owed) return 0;
        free -= owed;
        uint256 liquid = source.maxWithdraw(address(this));
        liquid = liquid > owed ? liquid - owed : 0;
        return free < liquid ? free : liquid;
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _requireMember(address who) internal view returns (Member storage m) {
        m = _members[who];
        if (m.principal == 0) revert NotMember();
    }

    function _checkCap(uint256 amount) internal view {
        if (maxTotalPrincipal != 0 && totalPrincipal + amount > maxTotalPrincipal) revert CapReached();
    }

    /// @dev Shares above the ones that back the principal. previewWithdraw rounds up, so redeeming the
    ///      remaining `previewWithdraw(principal)` shares always returns at least `principal`.
    function _yieldShares(Member storage m) internal view returns (uint256) {
        uint256 ps = source.previewWithdraw(m.principal);
        return m.shares > ps ? m.shares - ps : 0;
    }

    /// @dev Asset units that `withdrawals` separate withdraw() calls can take from yield shares without
    ///      touching principal shares. Each withdraw burns at most previewWithdraw(x) <= x/price + 1 shares,
    ///      so one share per withdrawal is kept back.
    function _fromYield(Member storage m, uint256 withdrawals) internal view returns (uint256) {
        uint256 ys = _yieldShares(m);
        if (ys <= withdrawals) return 0;
        return source.previewRedeem(ys - withdrawals);
    }

    function _owedNow(Member storage m, Route[] storage rs) internal view returns (uint256 owed) {
        uint256 elapsed = block.timestamp - m.lastSettled;
        for (uint256 i = 0; i < rs.length; i++) {
            owed += (rs[i].carry + uint256(rs[i].amountPerPeriod) * elapsed) / period;
        }
    }

    /// @dev Claimable after a settle in this same call: yield shares minus one for rounding, minus anything
    ///      still owed to routes (held back for lack of source liquidity), capped by source liquidity.
    function _claimable(address member, Member storage m) internal view returns (uint256) {
        uint256 ys = _yieldShares(m);
        if (ys <= 1) return 0;
        uint256 free = source.previewRedeem(ys - 1);
        uint256 held;
        Route[] storage rs = _routes[member];
        for (uint256 i = 0; i < rs.length; i++) {
            held += rs[i].carry / period;
        }
        if (free <= held) return 0;
        free -= held;
        uint256 liquid = source.maxWithdraw(address(this));
        return free < liquid ? free : liquid;
    }

    /// @dev Accrue every route, then pay what yield covers and the source can deliver.
    ///      - Accrual is exact: carry keeps the sub-unit remainder, so settling often never loses a creator money.
    ///      - What yield cannot cover is forgiven (no debt against principal) and clears the funded flag.
    ///      - What yield covers but the source cannot pay today (maxWithdraw) is held in carry and paid next time.
    ///      - A payment that reverts is also held, so a bad creator address cannot trap the member.
    function _settle(address member, Member storage m) internal {
        Route[] storage rs = _routes[member];
        uint256 n = rs.length;
        uint256 elapsed = block.timestamp - m.lastSettled;
        m.lastSettled = uint64(block.timestamp); // forge-lint: disable-line(unsafe-typecast)
        if (n == 0) {
            m.funded = true;
            return;
        }

        (uint256[] memory owedBy, uint256 owed) = _accrue(rs, elapsed);
        if (owed == 0) return;

        // one share kept back per rounding step: the creator's withdraw, and the fee's share move when there is a fee
        uint256 fromYield = _fromYield(m, feeBps == 0 ? n : 2 * n);
        if (fromYield > owed) fromYield = owed;
        uint256 liquid = source.maxWithdraw(address(this));
        uint256 pay = fromYield > liquid ? liquid : fromYield;

        uint256 burned = _distribute(member, rs, owedBy, owed, fromYield, pay);
        if (burned != 0) m.shares = _u128(m.shares - burned);
        m.funded = fromYield * 10_000 >= owed * FUNDED_BPS;
        emit Settled(member, owed, fromYield, pay, m.funded);
    }

    function _accrue(Route[] storage rs, uint256 elapsed) internal returns (uint256[] memory owedBy, uint256 owed) {
        uint256 n = rs.length;
        owedBy = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            Route storage r = rs[i];
            uint256 c = r.carry + uint256(r.amountPerPeriod) * elapsed;
            r.carry = c;
            owedBy[i] = c / period;
            owed += owedBy[i];
        }
    }

    /// @dev Split `pay` across routes pro rata to what each is owed. `fromYield - pay` is held (liquidity),
    ///      `owed - fromYield` is forgiven (yield). Returns the source shares burned.
    function _distribute(
        address member,
        Route[] storage rs,
        uint256[] memory owedBy,
        uint256 owed,
        uint256 fromYield,
        uint256 pay
    ) internal returns (uint256 burned) {
        for (uint256 i = 0; i < owedBy.length; i++) {
            uint256 o = owedBy[i];
            if (o == 0) continue;
            Route storage r = rs[i];
            uint256 p = (pay * o) / owed;
            uint256 held = ((fromYield - pay) * o) / owed;
            r.carry = r.carry - o * period + held * period; // the rest, o - p - held, is forgiven
            if (p != 0) burned += _pay(member, r, p);
        }
    }

    /// @dev Pays a creator `p` less the protocol fee, and moves the fee's worth of shares from the member to the
    ///      fee pool. A payment the source refuses, or a creator address the token refuses, must never block the
    ///      member's own actions (every one of them settles first): keep the whole amount owed and move on, with
    ///      no fee taken on what was not paid. Returns the shares that left the member's position.
    function _pay(address member, Route storage r, uint256 p) internal returns (uint256 taken) {
        uint256 fee = (p * feeBps) / 10_000;
        uint256 net = p - fee;
        try source.withdraw(net, r.creator, address(this)) returns (uint256 b) {
            taken = b;
            creatorPaid[r.creator] += net;
            emit CreatorPaid(r.creator, member, net);
            if (fee != 0) {
                uint256 fs = source.previewWithdraw(fee);
                feeShares += fs;
                taken += fs;
                emit FeeAccrued(member, r.creator, fee);
            }
        } catch {
            r.carry += p * period;
            emit CreatorUnpaid(r.creator, member, p);
        }
    }

    function _leave(address member, Member storage m) internal {
        uint256 shares = m.shares;
        uint256 principal = m.principal;
        if (yieldSink != address(0)) shares -= _forwardYield(member, m);
        totalPrincipal -= principal;
        memberCount -= 1;
        delete _members[member];
        delete _routes[member];
        uint256 received = shares == 0 ? 0 : source.redeem(shares, member, address(this));
        emit Left(member, principal, received);
    }

    /// @dev Principal-only mode, on leave: the yield above principal shares goes to the member's routes pro rata
    ///      to their amounts, or to yieldSink when there are none. A recipient the token refuses falls back to
    ///      yieldSink, and if that fails too the member keeps it: nothing may trap an exit. One share per
    ///      recipient is kept back for rounding, exactly as in settle. Returns the shares burned.
    function _forwardYield(address member, Member storage m) internal returns (uint256 burned) {
        Route[] storage rs = _routes[member];
        uint256 n = rs.length;
        uint256 ys = _yieldShares(m);
        uint256 recipients = n == 0 ? 1 : n;
        if (ys <= recipients) return 0;
        uint256 total = source.previewRedeem(ys - recipients);
        uint256 liquid = source.maxWithdraw(address(this));
        if (total > liquid) total = liquid;
        if (total == 0) return 0;
        if (n == 0) return _forwardTo(yieldSink, member, total);
        uint256 weight;
        for (uint256 i = 0; i < n; i++) {
            weight += rs[i].amountPerPeriod;
        }
        if (weight == 0) return _forwardTo(yieldSink, member, total);
        for (uint256 i = 0; i < n; i++) {
            uint256 p = (total * rs[i].amountPerPeriod) / weight;
            if (p != 0) burned += _forwardTo(rs[i].creator, member, p);
        }
    }

    function _forwardTo(address to, address member, uint256 amount) internal returns (uint256) {
        try source.withdraw(amount, to, address(this)) returns (uint256 b) {
            creatorPaid[to] += amount;
            emit YieldForwarded(to, member, amount);
            return b;
        } catch {
            if (to == yieldSink) return 0;
            try source.withdraw(amount, yieldSink, address(this)) returns (uint256 b2) {
                creatorPaid[yieldSink] += amount;
                emit YieldForwarded(yieldSink, member, amount);
                return b2;
            } catch {
                return 0;
            }
        }
    }

    function _pullAndDeposit(address from, uint256 amount) internal returns (uint256 shares) {
        _call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        shares = source.deposit(amount, address(this));
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        return uint128(x); // forge-lint: disable-line(unsafe-typecast)
    }

    /// @dev Minimal safe ERC-20 call: tolerates tokens that return nothing, rejects tokens that return false.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(asset).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
