// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

contract PatronVaultTest is Test {
    MockUSDC usdc;
    MockERC4626 src;
    PatronVault vault;

    bytes32 constant TERMS = keccak256("DJZS Patron Vault member terms v1");
    uint256 constant MIN = 500e6;
    uint256 constant PERIOD = 30 days;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address creatorA = makeAddr("creatorA");
    address creatorB = makeAddr("creatorB");
    address keeper = makeAddr("keeper");
    address outsider = makeAddr("outsider");

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        src = new MockERC4626(usdc);
        vault = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0);
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
        _fund(outsider, 1_000_000e6);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(who);
        usdc.approve(address(src), type(uint256).max);
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.join(amount, TERMS);
    }

    function _route(address who, address creator, uint96 perPeriod) internal {
        vm.prank(who);
        vault.setRoute(creator, perPeriod);
    }

    /// @dev Move the source share price off 1.0 so rounding paths are exercised.
    function _skewPrice() internal {
        vm.prank(outsider);
        src.deposit(100_000e6, outsider);
        src.gain(37_000e6); // price 1.37
    }

    function _shares(address who) internal view returns (uint256) {
        return vault.memberOf(who).shares;
    }

    function _principal(address who) internal view returns (uint256) {
        return vault.memberOf(who).principal;
    }

    function _principalShares(address who) internal view returns (uint256) {
        return src.previewWithdraw(_principal(who));
    }

    // ───────────────────────────── constructor ─────────────────────────────

    function test_constructor_setsImmutablesAndApproves() public view {
        assertEq(address(vault.asset()), address(usdc));
        assertEq(address(vault.source()), address(src));
        assertEq(vault.minDeposit(), MIN);
        assertEq(vault.period(), PERIOD);
        assertEq(vault.termsHash(), TERMS);
        assertEq(usdc.allowance(address(vault), address(src)), type(uint256).max);
    }

    function test_constructor_rejectsBadParams() public {
        vm.expectRevert(PatronVault.ZeroAddress.selector);
        new PatronVault(IERC4626(address(0)), MIN, PERIOD, TERMS, 0, 0);
        vm.expectRevert(PatronVault.BadTerms.selector);
        new PatronVault(IERC4626(address(src)), MIN, 0, TERMS, 0, 0);
        vm.expectRevert(PatronVault.BadTerms.selector);
        new PatronVault(IERC4626(address(src)), MIN, PERIOD, bytes32(0), 0, 0);
    }

    function test_pilotLimits_capAndJoinWindow() public {
        uint256 closes = block.timestamp + 60 days;
        PatronVault capped = new PatronVault(IERC4626(address(src)), 3_500e6, PERIOD, TERMS, 49_000e6, closes);
        vm.prank(alice);
        usdc.approve(address(capped), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(capped), type(uint256).max);

        vm.prank(alice);
        capped.join(45_000e6, TERMS);
        vm.prank(bob);
        vm.expectRevert(PatronVault.CapReached.selector);
        capped.join(5_000e6, TERMS);
        vm.prank(bob);
        capped.join(4_000e6, TERMS);
        vm.prank(alice);
        vm.expectRevert(PatronVault.CapReached.selector);
        capped.deposit(1);
        assertEq(capped.totalPrincipal(), 49_000e6);

        vm.prank(bob);
        capped.leave();
        vm.warp(closes);
        vm.prank(bob);
        vm.expectRevert(PatronVault.JoinClosed.selector);
        capped.join(4_000e6, TERMS);
        vm.prank(alice);
        capped.deposit(1_000e6); // existing members may still top up inside the cap
        assertEq(capped.totalPrincipal(), 46_000e6);
    }

    // ───────────────────────────── join ─────────────────────────────

    function test_join_recordsPrincipalSharesAndConsent() public {
        vm.expectEmit(true, false, false, true);
        emit PatronVault.Joined(alice, 3_000e6, 3_000e6, TERMS);
        _join(alice, 3_000e6);

        PatronVault.Member memory m = vault.memberOf(alice);
        assertEq(m.principal, 3_000e6);
        assertEq(m.shares, 3_000e6);
        assertEq(m.joinedAt, block.timestamp);
        assertEq(m.lastSettled, block.timestamp);
        assertTrue(m.funded);
        assertEq(vault.totalPrincipal(), 3_000e6);
        assertEq(vault.memberCount(), 1);
        assertEq(usdc.balanceOf(address(vault)), 0, "vault never holds USDC");
        assertEq(src.balanceOf(address(vault)), 3_000e6);
        assertEq(usdc.balanceOf(alice), 97_000e6);
    }

    function test_join_rejectsWrongTerms() public {
        vm.prank(alice);
        vm.expectRevert(PatronVault.BadTerms.selector);
        vault.join(3_000e6, keccak256("some other text"));
    }

    function test_join_rejectsBelowMinimumAndZero() public {
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.join(MIN - 1, TERMS);
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.join(0, TERMS);
    }

    function test_join_rejectsSecondJoin() public {
        _join(alice, MIN);
        vm.prank(alice);
        vm.expectRevert(PatronVault.AlreadyMember.selector);
        vault.join(MIN, TERMS);
    }

    function test_join_atOddPrice_principalIsBackedWithinOneShare() public {
        _skewPrice();
        _join(alice, 3_000e6);
        // ERC-4626 rounds the deposit against the depositor by at most one share. Nothing else is lost.
        assertGe(_shares(alice) + 1, _principalShares(alice));
        assertGe(vault.positionValue(alice) + 2, 3_000e6);
    }

    // ───────────────────────────── routes ─────────────────────────────

    function test_setRoute_addChangeRemove() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        _route(alice, creatorB, 2e6);
        PatronVault.Route[] memory rs = vault.routesOf(alice);
        assertEq(rs.length, 2);
        assertEq(rs[0].creator, creatorA);
        assertEq(rs[0].amountPerPeriod, 5e6);
        assertTrue(vault.isPatron(creatorA, alice));
        assertTrue(vault.isPatron(creatorB, alice));

        _route(alice, creatorA, 7e6);
        rs = vault.routesOf(alice);
        assertEq(rs.length, 2);
        assertEq(rs[0].amountPerPeriod, 7e6);

        _route(alice, creatorA, 0);
        rs = vault.routesOf(alice);
        assertEq(rs.length, 1);
        assertEq(rs[0].creator, creatorB);
        assertFalse(vault.isPatron(creatorA, alice));
        assertTrue(vault.isPatron(creatorB, alice));

        _route(alice, creatorA, 0); // removing a route that is not there is a no-op
        assertEq(vault.routesOf(alice).length, 1);
    }

    function test_setRoute_requiresMembership() public {
        vm.prank(alice);
        vm.expectRevert(PatronVault.NotMember.selector);
        vault.setRoute(creatorA, 5e6);
    }

    function test_setRoute_rejectsSelfAndZero() public {
        _join(alice, 3_000e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.SelfRoute.selector);
        vault.setRoute(alice, 5e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.ZeroAddress.selector);
        vault.setRoute(address(0), 5e6);
    }

    function test_setRoute_capsAtMaxRoutes() public {
        _join(alice, 3_000e6);
        for (uint256 i = 0; i < vault.MAX_ROUTES(); i++) {
            _route(alice, address(uint160(0x1000 + i)), 1e6);
        }
        vm.prank(alice);
        vm.expectRevert(PatronVault.TooManyRoutes.selector);
        vault.setRoute(creatorA, 1e6);
    }

    function test_setRoute_respectsCreatorMinimum_removalAlwaysAllowed() public {
        _join(alice, 3_000e6);
        vm.prank(creatorA);
        vault.setCreatorMin(5e6);
        assertEq(vault.creatorMin(creatorA), 5e6);

        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowCreatorMinimum.selector);
        vault.setRoute(creatorA, 4e6);

        _route(alice, creatorA, 5e6);
        vm.prank(creatorA);
        vault.setCreatorMin(10e6); // raising the floor does not touch the existing route
        assertTrue(vault.isPatron(creatorA, alice));

        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowCreatorMinimum.selector);
        vault.setRoute(creatorA, 6e6);

        _route(alice, creatorA, 0);
        assertEq(vault.routesOf(alice).length, 0);
    }

    // ───────────────────────────── settle ─────────────────────────────

    function test_settle_noYield_paysNothing_flagsUnfunded_principalUntouched() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        vm.warp(block.timestamp + PERIOD);

        uint256 sharesBefore = _shares(alice);
        vm.prank(keeper);
        vault.settle(alice);

        assertEq(usdc.balanceOf(creatorA), 0);
        assertEq(_shares(alice), sharesBefore, "no shares burned");
        assertEq(_principal(alice), 3_000e6);
        assertFalse(vault.memberOf(alice).funded);
        assertFalse(vault.isPatron(creatorA, alice));
    }

    function test_settle_paysCreatorFromYieldOnly() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6); // a month of interest at about 4.4%
        vm.warp(block.timestamp + PERIOD);

        (uint256 owed, uint256 fromYield, uint256 pay) = vault.previewSettle(alice);
        assertEq(owed, 5e6);
        assertEq(fromYield, 5e6);
        assertEq(pay, 5e6);

        vm.prank(keeper);
        vault.settle(alice);

        assertEq(usdc.balanceOf(creatorA), 5e6);
        assertEq(vault.creatorPaid(creatorA), 5e6);
        assertEq(_principal(alice), 3_000e6);
        assertGe(_shares(alice), _principalShares(alice), "principal shares intact");
        assertGe(vault.positionValue(alice), 3_000e6);
        assertTrue(vault.memberOf(alice).funded);
        assertTrue(vault.isPatron(creatorA, alice));
        // the member keeps the unrouted remainder
        assertGe(vault.claimableYield(alice), 5e6);
    }

    function test_settle_prorataWhenYieldIsShort_forgivesTheRest() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 6e6);
        _route(alice, creatorB, 2e6);
        src.gain(4e6); // only 4 of the 8 owed
        vm.warp(block.timestamp + PERIOD);

        vm.prank(keeper);
        vault.settle(alice);

        uint256 a = usdc.balanceOf(creatorA);
        uint256 b = usdc.balanceOf(creatorB);
        assertApproxEqAbs(a, 3e6, 4, "one share per route held back for rounding, plus the source's own");
        assertApproxEqAbs(b, 1e6, 4);
        assertApproxEqAbs(a + b, 4e6, 4, "everything the yield could cover went out");
        assertGe(_shares(alice), _principalShares(alice), "principal shares intact");
        assertFalse(vault.memberOf(alice).funded);
        assertFalse(vault.isPatron(creatorA, alice));

        // the shortfall was forgiven, not carried: a fully funded next period pays exactly one period
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA) - a, 6e6);
        assertEq(usdc.balanceOf(creatorB) - b, 2e6);
        assertTrue(vault.isPatron(creatorA, alice));
    }

    function test_settle_frequentSettlesLoseNothingToRounding() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 1e6); // 0.386 units per second: rounds to zero on any single short settle
        src.gain(30e6);

        uint256 start = block.timestamp;
        for (uint256 t = 1; t <= 300; t++) {
            vm.warp(start + t); // one settle per second
            vm.prank(keeper);
            vault.settle(alice);
        }
        assertEq(usdc.balanceOf(creatorA), (1e6 * 300) / PERIOD, "paid exactly the floor of 300 seconds of stream");
        vm.warp(start + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 1e6, "a full period pays the full amount, however often it was settled");
    }

    function test_settle_illiquidSource_holdsTheDifference_doesNotForgive() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        src.setLiquidity(2e6);

        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 2e6);
        assertTrue(vault.memberOf(alice).funded, "yield covered it; the source was the problem");
        assertTrue(vault.isPatron(creatorA, alice));

        // settling again with no time elapsed and no liquidity at all: nothing changes, nothing is lost
        src.setLiquidity(0);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 2e6);
        assertTrue(vault.memberOf(alice).funded);

        // the route cannot be removed while the source still owes the creator
        vm.prank(alice);
        vm.expectRevert(PatronVault.OwedButIlliquid.selector);
        vault.setRoute(creatorA, 0);

        // liquidity returns: the held 3 USDC is paid with no time elapsed
        src.setLiquidity(type(uint256).max);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 5e6);
        _route(alice, creatorA, 0);
    }

    function test_settle_blockedCreator_neverTrapsTheMember() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        _route(alice, creatorB, 2e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true); // Circle froze the creator's address

        vm.prank(keeper);
        vault.settle(alice); // does not revert
        assertEq(usdc.balanceOf(creatorA), 0);
        assertEq(usdc.balanceOf(creatorB), 2e6, "the other creator is paid as usual");
        assertTrue(vault.memberOf(alice).funded);
        PatronVault.Route[] memory rs = vault.routesOf(alice);
        assertEq(rs[0].carry / PERIOD, 5e6, "kept owed, not forgiven");

        // the member can still top up, claim, change routes and leave
        vm.prank(alice);
        vault.deposit(500e6);
        uint256 c = vault.claimableYield(alice);
        assertGe(c, 4e6 - 4);
        assertLe(c, 4e6, "the 5 still owed to the frozen creator is not claimable");

        // unfreeze: the next settle delivers what was held
        usdc.setBlocked(creatorA, false);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 5e6);

        // freeze again and remove the route: the source can pay, the creator cannot receive, so it is forgiven
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true);
        vm.expectEmit(true, true, false, true);
        emit PatronVault.CreatorForgiven(creatorA, alice, 5e6);
        _route(alice, creatorA, 0);
        assertEq(vault.routesOf(alice).length, 1);
        vm.prank(alice);
        vault.leave();
        assertEq(_principal(alice), 0);
    }

    function test_settle_anyoneCanCall_nonMemberReverts() public {
        vm.prank(keeper);
        vm.expectRevert(PatronVault.NotMember.selector);
        vault.settle(alice);
    }

    function test_settle_atOddPrice_neverBurnsPrincipalShares() public {
        _skewPrice();
        _join(alice, 3_000e6);
        _route(alice, creatorA, 9e6);
        _route(alice, creatorB, 1e6);
        for (uint256 i = 0; i < 12; i++) {
            src.gain(560e6); // alice holds 3,000 of 140,000 in the source, so her slice of this is 12
            vm.warp(block.timestamp + PERIOD);
            vm.prank(keeper);
            vault.settle(alice);
            assertGe(_shares(alice) + 1, _principalShares(alice), "within the one-share deposit rounding");
        }
        assertEq(usdc.balanceOf(creatorA), 9e6 * 12);
        assertEq(usdc.balanceOf(creatorB), 1e6 * 12);
    }

    // ───────────────────────────── claim ─────────────────────────────

    function test_claimYield_paysUnroutedYield_afterSettlingRoutes() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);

        uint256 claimable = vault.claimableYield(alice);
        assertGe(claimable, 5e6);
        assertLe(claimable, 6e6);

        vm.prank(alice);
        vault.claimYield(claimable);
        assertEq(usdc.balanceOf(alice), 97_000e6 + claimable);
        assertEq(usdc.balanceOf(creatorA), 5e6, "routes were settled first");
        assertGe(_shares(alice), _principalShares(alice));
    }

    function test_claimYield_rejectsMoreThanYield() public {
        _join(alice, 3_000e6);
        src.gain(11e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.ExceedsYield.selector);
        vault.claimYield(12e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.ExceedsYield.selector);
        vault.claimYield(0);
    }

    function test_claimYield_nothingInShortfall() public {
        _join(alice, 3_000e6);
        src.loss(10e6);
        assertEq(vault.claimableYield(alice), 0);
        vm.prank(alice);
        vm.expectRevert(PatronVault.ExceedsYield.selector);
        vault.claimYield(1);
    }

    function test_claimYield_cannotTakeWhatIsHeldForCreators() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        src.setLiquidity(3e6); // 3 goes to the creator now, 2 is held for later
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 3e6);
        src.setLiquidity(type(uint256).max);

        // position is about 8 above principal, but 2 of that belongs to the creator
        uint256 c = vault.claimableYield(alice);
        assertGe(c, 6e6 - 4);
        assertLe(c, 6e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.ExceedsYield.selector);
        vault.claimYield(6e6 + 1);
        vm.prank(alice);
        vault.claimYield(c); // claimYield settles first, which pays the held 2
        assertEq(usdc.balanceOf(creatorA), 5e6);
        assertGe(_shares(alice), _principalShares(alice));
    }

    // ───────────────────────────── deposit / withdraw / leave ─────────────────────────────

    function test_deposit_topUpSettlesFirst() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(alice);
        vault.deposit(1_000e6);
        assertEq(usdc.balanceOf(creatorA), 5e6);
        assertEq(_principal(alice), 4_000e6);
        assertEq(vault.totalPrincipal(), 4_000e6);
        assertGe(_shares(alice) + 1, _principalShares(alice));
    }

    function test_deposit_requiresMembershipAndAmount() public {
        vm.prank(alice);
        vm.expectRevert(PatronVault.NotMember.selector);
        vault.deposit(1e6);
        _join(alice, 3_000e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.deposit(0);
    }

    function test_withdraw_partialReturnsPrincipal_keepsYield() public {
        _join(alice, 3_000e6);
        src.gain(11e6);
        vm.prank(alice);
        vault.withdraw(1_000e6);
        assertEq(usdc.balanceOf(alice), 98_000e6);
        assertEq(_principal(alice), 2_000e6);
        assertEq(vault.totalPrincipal(), 2_000e6);
        assertGe(_shares(alice), _principalShares(alice));
        assertApproxEqAbs(vault.positionValue(alice), 2_011e6, 2, "yield stayed with the position");
    }

    function test_withdraw_rejectsDustRemainderAndOverdraw() public {
        _join(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.withdraw(600e6); // 400 left, below the 500 minimum
        vm.prank(alice);
        vm.expectRevert(PatronVault.ExceedsPrincipal.selector);
        vault.withdraw(1_001e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.withdraw(0);
    }

    function test_withdraw_allIsLeave() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.prank(alice);
        vault.withdraw(3_000e6);
        assertEq(_principal(alice), 0);
        assertEq(vault.routesOf(alice).length, 0);
        assertEq(vault.memberCount(), 0);
        assertApproxEqAbs(usdc.balanceOf(alice), 100_011e6, 2);
    }

    function test_withdraw_inShortfall_isProRata() public {
        _join(alice, 3_000e6);
        src.loss(300e6); // the source lost 10%
        assertTrue(vault.inShortfall(alice));
        vm.prank(alice);
        vault.withdraw(1_000e6);
        assertApproxEqAbs(usdc.balanceOf(alice), 97_000e6 + 900e6, 2, "took 90 cents on the dollar");
        assertEq(_principal(alice), 2_000e6);
        assertApproxEqAbs(vault.positionValue(alice), 1_800e6, 2, "the rest is still 90% backed");
    }

    function test_leave_redeemsEverything_clearsRoutes_allowsRejoin() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(alice);
        vault.leave();
        assertEq(usdc.balanceOf(creatorA), 5e6, "settled on the way out");
        assertApproxEqAbs(usdc.balanceOf(alice), 100_006e6, 2, "deposit plus unrouted yield");
        assertEq(src.balanceOf(address(vault)), 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.memberCount(), 0);
        assertEq(vault.routesOf(alice).length, 0);
        assertFalse(vault.isPatron(creatorA, alice));

        _join(alice, 1_000e6);
        assertEq(_principal(alice), 1_000e6);
        assertEq(vault.routesOf(alice).length, 0);
    }

    function test_leave_inShortfall_takesOwnLossOnly() public {
        _join(alice, 3_000e6);
        _join(bob, 1_000e6);
        src.loss(400e6); // 10% of the pool
        vm.prank(alice);
        vault.leave();
        assertApproxEqAbs(usdc.balanceOf(alice), 97_000e6 + 2_700e6, 2);
        assertApproxEqAbs(vault.positionValue(bob), 900e6, 2, "bob's loss is his own 10%, no more");
    }

    // ───────────────────────────── isolation ─────────────────────────────

    function test_isolation_onePayoutNeverTouchesAnotherMember() public {
        _join(alice, 3_000e6);
        _join(bob, 3_000e6);
        _route(alice, creatorA, 9e6); // alice routes nearly all her yield away; bob routes nothing
        src.gain(22e6);
        vm.warp(block.timestamp + PERIOD);

        uint256 bobShares = _shares(bob);
        uint256 bobValue = vault.positionValue(bob);
        vm.prank(keeper);
        vault.settle(alice);
        vm.prank(keeper);
        vault.settle(bob);

        assertEq(usdc.balanceOf(creatorA), 9e6);
        assertEq(_shares(bob), bobShares, "bob's shares untouched");
        assertApproxEqAbs(vault.positionValue(bob), bobValue, 1, "bob's value moves only by the source's own 1-unit rounding");
        assertGe(_shares(alice), _principalShares(alice));
    }

    function test_isolation_shortfallMemberPaysNothing_healthyMemberPays() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(11e6);
        src.loss(50e6); // everyone is underwater now
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 0, "nothing paid out of a position below principal");
        assertFalse(vault.isPatron(creatorA, alice));

        src.gain(60e6); // recovered
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 5e6, "one period paid, the underwater period forgiven");
        assertTrue(vault.isPatron(creatorA, alice));
    }

    // ───────────────────────────── views ─────────────────────────────

    function test_isPatron_states() public {
        assertFalse(vault.isPatron(creatorA, alice), "non-member");
        _join(alice, 3_000e6);
        assertFalse(vault.isPatron(creatorA, alice), "member, no route");
        _route(alice, creatorA, 5e6);
        assertTrue(vault.isPatron(creatorA, alice), "routed and funded at join");
        assertFalse(vault.isPatron(creatorB, alice), "other creator");
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertFalse(vault.isPatron(creatorA, alice), "no yield to cover the period");
        src.gain(11e6);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertTrue(vault.isPatron(creatorA, alice), "covered again");
    }

    function test_previewSettle_matchesSettle() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        _route(alice, creatorB, 3e6);
        src.gain(6e6);
        vm.warp(block.timestamp + 10 days);
        (uint256 owed, uint256 fromYield, uint256 pay) = vault.previewSettle(alice);
        assertEq(owed, (8e6 * 10 days) / PERIOD);
        assertEq(fromYield, owed);
        assertEq(pay, owed);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA) + usdc.balanceOf(creatorB), pay);
    }

    function test_memberOf_and_routesOf_forStranger() public view {
        PatronVault.Member memory m = vault.memberOf(outsider);
        assertEq(m.principal, 0);
        assertEq(vault.routesOf(outsider).length, 0);
        assertEq(vault.positionValue(outsider), 0);
        assertEq(vault.claimableYield(outsider), 0);
        (uint256 o, uint256 f, uint256 p) = vault.previewSettle(outsider);
        assertEq(o + f + p, 0);
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    function testFuzz_settleNeverBurnsPrincipalShares(
        uint256 deposit_,
        uint96 routeA,
        uint96 routeB,
        uint256 gain_,
        uint256 elapsed,
        uint256 skew
    ) public {
        deposit_ = bound(deposit_, MIN, 50_000e6);
        routeA = uint96(bound(routeA, 0, 1_000e6));
        routeB = uint96(bound(routeB, 0, 1_000e6));
        gain_ = bound(gain_, 0, 5_000e6);
        elapsed = bound(elapsed, 0, 400 days);
        skew = bound(skew, 0, 200_000e6);

        if (skew != 0) {
            vm.prank(outsider);
            src.deposit(100_000e6, outsider);
            src.gain(skew);
        }
        _join(alice, deposit_);
        if (routeA != 0) _route(alice, creatorA, routeA);
        if (routeB != 0) _route(alice, creatorB, routeB);
        src.gain(gain_);
        vm.warp(block.timestamp + elapsed);

        uint256 ps = _principalShares(alice);
        bool healthyBefore = _shares(alice) >= ps;
        vm.prank(keeper);
        vault.settle(alice);

        if (healthyBefore) assertGe(_shares(alice), ps, "settle took principal shares");
        else assertEq(usdc.balanceOf(creatorA) + usdc.balanceOf(creatorB), 0, "paid out of a shortfall");
        assertEq(_principal(alice), deposit_);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_claimableNeverOverstates(uint256 deposit_, uint96 route, uint256 gain_, uint256 elapsed) public {
        deposit_ = bound(deposit_, MIN, 50_000e6);
        route = uint96(bound(route, 0, 100e6));
        gain_ = bound(gain_, 0, 2_000e6);
        elapsed = bound(elapsed, 0, 90 days);
        _join(alice, deposit_);
        if (route != 0) _route(alice, creatorA, route);
        src.gain(gain_);
        vm.warp(block.timestamp + elapsed);
        uint256 c = vault.claimableYield(alice);
        if (c == 0) return;
        vm.prank(alice);
        vault.claimYield(c);
        assertGe(_shares(alice), _principalShares(alice));
    }
}
