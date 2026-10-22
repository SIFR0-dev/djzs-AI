// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../../src/PatronVault.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";

/// @dev Drives PatronVault through random but valid sequences. Every action keeps its own preconditions,
///      so a revert here is a bug, not noise (fail_on_revert is on). Liquidity-dependent calls are wrapped
///      because an illiquid source is allowed to refuse them.
contract PatronHandler is Test {
    MockUSDC public usdc;
    MockERC4626 public src;
    PatronVault public vault;
    bytes32 public terms;

    address[] public members;
    address[] public creators;
    address public outsider = makeAddr("outsider");

    // ghosts
    bool public lossSinceClean; // a source loss happened while someone was a member
    mapping(address => uint256) public deposits; // deposit() + join() calls per current membership
    mapping(address => uint256) public leaves; // lifetime leave() and withdraw-all exits
    uint256 public claimedTotal;
    uint256 public feesCollected;
    uint256 public illiquidReverts;
    uint256 public outsiderOps; // each one can leave at most a share's worth of rounding dust to other holders
    uint256 public calls;

    constructor(MockUSDC usdc_, MockERC4626 src_, PatronVault vault_, bytes32 terms_) {
        usdc = usdc_;
        src = src_;
        vault = vault_;
        terms = terms_;
        for (uint256 i = 0; i < 4; i++) {
            address m = makeAddr(string(abi.encodePacked("member", i)));
            members.push(m);
            _fund(m);
        }
        creators.push(makeAddr("creatorA"));
        creators.push(makeAddr("creatorB"));
        creators.push(makeAddr("creatorC"));
        _fund(outsider);
    }

    function membersLength() external view returns (uint256) {
        return members.length;
    }

    function creatorsLength() external view returns (uint256) {
        return creators.length;
    }

    // ───────────────────────────── member actions ─────────────────────────────

    function join(uint256 who, uint256 amount) external {
        address m = _member(who);
        if (vault.memberOf(m).principal != 0) return;
        amount = bound(amount, vault.minDeposit(), 20_000e6);
        calls++;
        vm.prank(m);
        vault.join(amount, terms);
        deposits[m] = 1;
    }

    function deposit(uint256 who, uint256 amount) external {
        address m = _member(who);
        if (vault.memberOf(m).principal == 0) return;
        amount = bound(amount, 1, 20_000e6);
        calls++;
        (bool healthy,) = _healthy(m);
        vm.prank(m);
        vault.deposit(amount);
        deposits[m] += 1;
        _postSettle(m, healthy, 1); // the top-up itself may round one share against the member
    }

    function withdraw(uint256 who, uint256 amount) external {
        address m = _member(who);
        uint256 p = vault.memberOf(m).principal;
        if (p == 0) return;
        amount = bound(amount, 1, p);
        uint256 remaining = p - amount;
        if (remaining != 0 && remaining < vault.minDeposit()) amount = p; // leave instead of leaving dust
        calls++;
        (bool healthy,) = _healthy(m);
        vm.prank(m);
        try vault.withdraw(amount) {
            if (vault.memberOf(m).principal == 0) {
                _left(m);
            } else if (healthy && !lossSinceClean) {
                assertGe(
                    vault.memberOf(m).shares, src.previewWithdraw(p - amount), "withdraw dipped into principal shares"
                );
            }
        } catch (bytes memory reason) {
            _onlyIlliquid(reason);
        }
    }

    function claim(uint256 who, uint256 part) external {
        if (vault.yieldSink() != address(0)) return; // principal-only mode: nothing to claim
        address m = _member(who);
        if (vault.memberOf(m).principal == 0) return;
        uint256 c = vault.claimableYield(m);
        if (c == 0) return;
        uint256 amount = bound(part, 1, c);
        calls++;
        (bool healthy,) = _healthy(m);
        uint256 before = usdc.balanceOf(m);
        vm.prank(m);
        try vault.claimYield(amount) {
            claimedTotal += usdc.balanceOf(m) - before;
            _postSettle(m, healthy, 0);
        } catch (bytes memory reason) {
            _onlyIlliquid(reason);
        }
    }

    function setRoute(uint256 who, uint256 creator, uint96 amount) external {
        address m = _member(who);
        if (vault.memberOf(m).principal == 0) return;
        address c = creators[bound(creator, 0, creators.length - 1)];
        amount = uint96(bound(amount, 0, 400e6));
        if (amount != 0 && amount < vault.creatorMin(c)) amount = uint96(vault.creatorMin(c));
        if (amount != 0 && vault.routesOf(m).length >= vault.MAX_ROUTES() && !_hasRoute(m, c)) return;
        calls++;
        (bool healthy,) = _healthy(m);
        vm.prank(m);
        try vault.setRoute(c, amount) {
            _postSettle(m, healthy, 0);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), PatronVault.OwedButIlliquid.selector, "unexpected setRoute revert");
            illiquidReverts++;
        }
    }

    function settle(uint256 who) external {
        address m = _member(who);
        if (vault.memberOf(m).principal == 0) return;
        calls++;
        (bool healthy,) = _healthy(m);
        // a third party may settle once per settleInterval; inside it, the member settles themselves
        if (block.timestamp < vault.memberOf(m).lastSettled + vault.settleInterval()) vm.prank(m);
        vault.settle(m);
        _postSettle(m, healthy, 0);
    }

    function leave(uint256 who) external {
        address m = _member(who);
        if (vault.memberOf(m).principal == 0) return;
        calls++;
        vm.prank(m);
        try vault.leave() {
            _left(m);
        } catch (bytes memory reason) {
            _onlyIlliquid(reason);
        }
    }

    // ───────────────────────────── creator actions ─────────────────────────────

    function setCreatorMin(uint256 creator, uint96 amount) external {
        address c = creators[bound(creator, 0, creators.length - 1)];
        amount = uint96(bound(amount, 0, 50e6));
        calls++;
        vm.prank(c);
        vault.setCreatorMin(amount);
    }

    function collectFees() external {
        if (vault.feeShares() == 0) return;
        calls++;
        uint256 before = usdc.balanceOf(vault.feeRecipient());
        try vault.collectFees() {
            feesCollected += usdc.balanceOf(vault.feeRecipient()) - before;
        } catch (bytes memory reason) {
            _onlyIlliquid(reason);
        }
    }

    /// @dev Principal-only mode: deliver parked exit buffers to the sink when the source can pay.
    function forwardSink() external {
        if (src.previewRedeem(vault.sinkShares()) == 0 || src.maxWithdraw(address(vault)) == 0) return;
        calls++;
        vault.forwardSink();
    }

    // ───────────────────────────── world ─────────────────────────────

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 45 days));
    }

    function gain(uint256 amount) external {
        uint256 total = src.totalAssets();
        if (total == 0) return;
        src.gain(bound(amount, 1, total / 50 + 1)); // up to 2% of the pool at once
    }

    function loss(uint256 amount, uint256 dice) external {
        if (dice % 6 != 0) return; // losses are rare
        uint256 total = src.totalAssets();
        if (total < 1000) return;
        src.loss(bound(amount, 1, total / 20)); // up to 5% of the pool
        if (vault.memberCount() != 0) lossSinceClean = true;
    }

    function setLiquidity(uint256 amount, uint256 dice) external {
        if (dice % 3 == 0) {
            src.setLiquidity(type(uint256).max);
        } else {
            src.setLiquidity(bound(amount, 0, src.totalAssets()));
        }
    }

    function outsiderDeposit(uint256 amount) external {
        amount = bound(amount, 1, 100_000e6);
        outsiderOps++;
        vm.prank(outsider);
        src.deposit(amount, outsider);
    }

    function outsiderWithdraw(uint256 part) external {
        uint256 max = src.maxWithdraw(outsider);
        if (max == 0) return;
        outsiderOps++;
        vm.prank(outsider);
        src.withdraw(bound(part, 1, max), outsider, outsider);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _member(uint256 who) internal view returns (address) {
        return members[bound(who, 0, members.length - 1)];
    }

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000e6);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(who);
        usdc.approve(address(src), type(uint256).max);
    }

    function _hasRoute(address m, address c) internal view returns (bool) {
        PatronVault.Route[] memory rs = vault.routesOf(m);
        for (uint256 i = 0; i < rs.length; i++) {
            if (rs[i].creator == c) return true;
        }
        return false;
    }

    /// @dev Is the position fully backed right now, and how many shares it takes to back the principal.
    function _healthy(address m) internal view returns (bool, uint256) {
        PatronVault.Member memory mm = vault.memberOf(m);
        uint256 need = src.previewWithdraw(mm.principal);
        return (mm.shares >= need, need);
    }

    /// @dev The core property: a settle (and anything that settles first) never burns principal shares.
    ///      `slack` is 1 only for a top-up, whose own ERC-4626 deposit may round one share against the member.
    function _postSettle(address m, bool healthyBefore, uint256 slack) internal view {
        if (!healthyBefore) return;
        PatronVault.Member memory mm = vault.memberOf(m);
        uint256 needAfter = src.previewWithdraw(mm.principal);
        assertGe(mm.shares + slack, needAfter, "payout burned principal shares");
    }

    function _left(address m) internal {
        deposits[m] = 0;
        leaves[m] += 1;
        if (vault.memberCount() == 0) lossSinceClean = false;
    }

    function _onlyIlliquid(bytes memory reason) internal {
        assertEq(bytes4(reason), MockERC4626.Illiquid.selector, "unexpected revert");
        illiquidReverts++;
    }
}
