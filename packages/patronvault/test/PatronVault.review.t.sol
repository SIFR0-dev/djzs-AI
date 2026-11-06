// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {FixedCreators} from "../src/FixedCreators.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

/// @dev Regressions for the 2026-10-21 cold review (docs/review-2026-10-21.md). Each test is named for the
///      finding it pins. The product configuration (fee on) is used throughout because two of the findings only
///      show with a fee.
contract PatronVaultReviewTest is Test {
    MockUSDC usdc;
    MockERC4626 src;
    PatronVault vault;

    bytes32 constant TERMS = keccak256("DJZS Patron Vault member terms v1");
    uint256 constant MIN = 500e6;
    uint256 constant PERIOD = 30 days;
    uint256 constant FEE = 500;

    address alice = makeAddr("alice");
    address creatorA = makeAddr("creatorA");
    address creatorB = makeAddr("creatorB");
    address fees = makeAddr("fees");
    address keeper = makeAddr("keeper");
    address sink = makeAddr("sink");

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        src = new MockERC4626(usdc);
        vault = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), FEE, fees, address(0));
        usdc.mint(alice, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _join(uint256 amount) internal {
        vm.prank(alice);
        vault.join(amount, TERMS);
    }

    function _route(address creator, uint96 per) internal {
        vm.prank(alice);
        vault.setRoute(creator, per);
    }

    function _principalShares() internal view returns (uint256) {
        return src.previewWithdraw(vault.memberOf(alice).principal);
    }

    // ───────────── F2: previewSettle predicts settle, fee on ─────────────

    function testFuzz_F2_previewSettleMatchesSettle_withFee(
        uint256 gain_,
        uint96 perA,
        uint96 perB,
        uint256 elapsed,
        uint256 outsiderGain
    ) public {
        gain_ = bound(gain_, 0, 200e6);
        perA = uint96(bound(perA, 1, 100e6));
        perB = uint96(bound(perB, 0, 100e6));
        elapsed = bound(elapsed, 1, 120 days);
        outsiderGain = bound(outsiderGain, 0, 50_000e6);
        if (outsiderGain != 0) {
            usdc.mint(address(this), 100_000e6);
            usdc.approve(address(src), type(uint256).max);
            src.deposit(100_000e6, address(this));
            src.gain(outsiderGain);
        }
        _join(3_000e6);
        _route(creatorA, perA);
        if (perB != 0) _route(creatorB, perB);
        src.gain(gain_);
        vm.warp(block.timestamp + elapsed);

        (uint256 owed, uint256 fromYield, uint256 pay) = vault.previewSettle(alice);
        vm.prank(alice);
        vault.settle(alice);
        uint256 paidNet = usdc.balanceOf(creatorA) + usdc.balanceOf(creatorB);
        uint256 feeTaken = src.previewRedeem(vault.feeShares());
        // the preview's `pay` is the gross that leaves the member: creators' net plus the fee, within rounding
        assertApproxEqAbs(paidNet + feeTaken, pay, 4, "settle paid other than the preview");
        if (elapsed >= vault.settleInterval()) {
            assertEq(
                vault.memberOf(alice).funded,
                fromYield * 10_000 >= owed * vault.FUNDED_BPS(),
                "funded differs from the preview"
            );
        } else {
            assertTrue(vault.memberOf(alice).funded, "a settle shorter than the interval leaves the flag as it was");
        }
    }

    // ───────────── F3, F7: a third party settles once per settleInterval ─────────────

    function test_F3_thirdPartySettle_spacedToOncePerInterval_memberAnytime() public {
        assertEq(vault.settleInterval(), PERIOD / 30);
        _join(3_000e6);
        _route(creatorA, 10e6);
        src.gain(20e6);

        // a settle in the join's own block by a third party is refused: no flicker to unfunded
        vm.prank(keeper);
        vm.expectRevert(PatronVault.SettleTooSoon.selector);
        vault.settle(alice);
        assertTrue(vault.isPatron(creatorA, alice));

        // the member may settle whenever they like
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vault.settle(alice);
        uint256 lastSettled = vault.memberOf(alice).lastSettled;

        // a third party: not before the interval, from the interval on
        vm.warp(lastSettled + vault.settleInterval() - 1);
        vm.prank(keeper);
        vm.expectRevert(PatronVault.SettleTooSoon.selector);
        vault.settle(alice);
        vm.warp(lastSettled + vault.settleInterval());
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(vault.memberOf(alice).lastSettled, block.timestamp);
    }

    function test_F3_settleMany_skipsTheRecentlySettled() public {
        _join(3_000e6);
        _route(creatorA, 10e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        address[] memory batch = new address[](1);
        batch[0] = alice;
        vm.prank(keeper);
        vault.settleMany(batch);
        uint256 paid = usdc.balanceOf(creatorA);
        assertGt(paid, 0);

        // the same batch an hour later: skipped, nothing moves, no revert
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        vault.settleMany(batch);
        assertEq(usdc.balanceOf(creatorA), paid);
    }

    // ───────────── F6: a liquidity hold holds everything the yield covered ─────────────

    function test_F6_liquidityShortSettle_forgivesNothingTheYieldCovered() public {
        _join(3_000e6);
        _route(creatorA, 1e6);
        _route(creatorB, 1); // one unit per period
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        src.setLiquidity(500_000); // the source can pay half of creator A's share today

        vm.prank(alice);
        vault.settle(alice);
        PatronVault.Route[] memory rs = vault.routesOf(alice);
        uint256 paidA = usdc.balanceOf(creatorA) + src.previewRedeem(vault.feeShares());
        // owed 1,000,001; paid about 500,000 gross; everything else is held, nothing forgiven
        assertApproxEqAbs(paidA + rs[0].carry / PERIOD, 1e6, 2, "A: paid plus held is the period");
        assertEq(rs[1].carry / PERIOD, 1, "B: the single unit is held, not forgiven");
        assertTrue(vault.memberOf(alice).funded);

        // liquidity returns: the member's own settle pays the rest exactly
        src.setLiquidity(type(uint256).max);
        vm.prank(alice);
        vault.settle(alice);
        rs = vault.routesOf(alice);
        assertEq(rs[0].carry / PERIOD, 0);
        assertEq(rs[1].carry / PERIOD, 0);
        assertApproxEqAbs(usdc.balanceOf(creatorA) + src.previewRedeem(vault.feeShares()), 1e6, 3);
    }

    // ───────────── F8: leave reports what a route was still owed ─────────────

    function test_F8_leave_emitsCreatorForgivenForHeldAmounts() public {
        _join(3_000e6);
        _route(creatorA, 5e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true); // the creator cannot receive: the 5 is held in carry
        vm.prank(alice);
        vault.settle(alice);
        assertEq(vault.routesOf(alice)[0].carry / PERIOD, 5e6);

        vm.expectEmit(true, true, false, true);
        emit PatronVault.CreatorForgiven(creatorA, alice, 5e6);
        vm.prank(alice);
        vault.leave();
    }

    // ───────────── F9: Settled.paid is what left, not what was meant to ─────────────

    function test_F9_settledEventReportsWhatWasActuallyPaid() public {
        _join(3_000e6);
        _route(creatorA, 5e6);
        _route(creatorB, 5e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true);
        vm.expectEmit(true, false, false, true);
        emit PatronVault.Settled(alice, 10e6, 10e6, 5e6, true); // owed 10, yield covers 10, 5 reached a creator
        vm.prank(alice);
        vault.settle(alice);
    }

    // ───────────── F10: the vault and the source are not recipients ─────────────

    function test_F10_routeToVaultOrSource_rejected() public {
        _join(3_000e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.InvalidRecipient.selector);
        vault.setRoute(address(vault), 1e6);
        vm.prank(alice);
        vm.expectRevert(PatronVault.InvalidRecipient.selector);
        vault.setRoute(address(src), 1e6);
    }

    function test_F10_sinkAndFeeRecipient_cannotBeTheSource() public {
        vm.expectRevert(PatronVault.InvalidRecipient.selector);
        new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(src), 0, address(0), address(0));
        vm.expectRevert(PatronVault.InvalidRecipient.selector);
        new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), FEE, address(src), address(0));
    }

    // ───────────── F14: a payment starved of gas reverts the call, it is never silently held ─────────────

    function test_F14_settleWithTooLittleGas_revertsInsufficientGas_neverHolds() public {
        _join(3_000e6);
        _route(creatorA, 5e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);

        // enough for everything around the payment, not enough for PAYOUT_GAS: the whole call reverts
        uint256 lastSettled = vault.memberOf(alice).lastSettled;
        vm.prank(alice);
        vm.expectRevert(PatronVault.InsufficientGas.selector);
        vault.settle{gas: 1_000_000}(alice);
        assertEq(vault.routesOf(alice)[0].carry, 0, "nothing accrued or held: the call did not go through");
        assertEq(vault.memberOf(alice).lastSettled, lastSettled);
        assertEq(usdc.balanceOf(creatorA), 0);

        // with the stipend available the same call pays
        vm.prank(alice);
        vault.settle{gas: 3_000_000}(alice);
        assertEq(usdc.balanceOf(creatorA), 4.75e6);
        assertEq(vault.routesOf(alice)[0].carry / PERIOD, 0);
    }

    function test_F14_leaveWithTooLittleGas_revertsInsufficientGas_neverKeepsTheBuffer() public {
        PatronVault po =
            new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, sink, 0, address(0), address(0));
        vm.startPrank(alice);
        usdc.approve(address(po), type(uint256).max);
        po.join(3_000e6, TERMS);
        po.setRoute(creatorA, 5e6);
        vm.stopPrank();
        src.gain(20e6);
        vm.warp(block.timestamp + 10 days);

        vm.prank(alice);
        vm.expectRevert(PatronVault.InsufficientGas.selector);
        po.leave{gas: 1_000_000}();
        assertEq(po.memberOf(alice).principal, 3_000e6, "still a member: the exit did not go through");

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        po.leave{gas: 4_000_000}();
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 3_000e6, 2, "the deposit came back, the buffer did not");
        assertGt(usdc.balanceOf(creatorA), 0, "the buffer reached the creator");
    }

    // ───────────── review B ─────────────

    // H1: `funded` cannot be reset by removing and re-adding a route; isPatron reads coverage live

    function test_H1_removeAndReaddRoute_doesNotResetFunded_isPatronIsLive() public {
        _join(3_000e6);
        _route(creatorA, 10e6);
        // a month with no yield: unfunded, not a patron
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        assertFalse(vault.memberOf(alice).funded);
        assertFalse(vault.isPatron(creatorA, alice));

        // the old trick: remove the route (settle sees it), add it back (settle sees no routes)
        _route(creatorA, 0);
        _route(creatorA, 10e6);
        assertFalse(vault.memberOf(alice).funded, "no routes settles nothing and resets nothing");
        assertFalse(vault.isPatron(creatorA, alice), "a route set this block is only a patron if the last reading was");
        vm.warp(block.timestamp + 1 days);
        assertFalse(vault.isPatron(creatorA, alice), "still no yield to cover what is owed");

        // yield arrives: the live reading flips without any settle
        src.gain(40e6);
        assertTrue(vault.isPatron(creatorA, alice), "live coverage, no settle needed");
    }

    function test_H1_selfSettleSecondsAfterRouting_keepsThePatronReading() public {
        _join(3_000e6);
        _route(creatorA, 10e6);
        vm.warp(block.timestamp + 2);
        vm.prank(alice);
        vault.settle(alice); // a few units owed, no yield yet: a settle shorter than the interval does not judge
        assertTrue(vault.memberOf(alice).funded);
        assertTrue(vault.isPatron(creatorA, alice));

        // an unfunded member cannot talk the flag back up with short settles either
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice); // a month, no yield: unfunded
        assertFalse(vault.memberOf(alice).funded);
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 1 hours);
            vm.prank(alice);
            vault.settle(alice);
            assertFalse(vault.memberOf(alice).funded, "short settles never set the flag");
            assertFalse(vault.isPatron(creatorA, alice));
        }
    }

    function test_H1_routeAddedInShortfall_isNotAPatron() public {
        _join(3_000e6);
        src.loss(50e6); // everyone underwater
        _route(creatorA, 10e6);
        assertTrue(vault.memberOf(alice).funded, "the flag from join is still true");
        assertFalse(vault.isPatron(creatorA, alice), "but a position in shortfall is never a patron");
    }

    // M1: a registry fixes who may be a creator; a member's second wallet is not one

    function test_M1_registry_routesOnlyToListedCreators() public {
        address[] memory list = new address[](1);
        list[0] = creatorA;
        FixedCreators reg = new FixedCreators(list);
        PatronVault pv =
            new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, sink, 0, address(0), address(reg));
        assertEq(pv.creatorRegistry(), address(reg));
        address altWallet = makeAddr("alice-second-wallet");
        vm.startPrank(alice);
        usdc.approve(address(pv), type(uint256).max);
        pv.join(3_000e6, TERMS);
        pv.setRoute(creatorA, 10e6); // listed: fine
        vm.expectRevert(PatronVault.CreatorNotAllowed.selector);
        pv.setRoute(altWallet, 10e6); // not listed: refused
        vm.expectRevert(PatronVault.CreatorNotAllowed.selector);
        pv.setRoute(creatorB, 1);
        pv.setRoute(creatorA, 0); // removal never consults the registry
        vm.stopPrank();
        assertEq(pv.routesOf(alice).length, 0);
    }

    function test_M1_fixedCreators_rejectsZeroAndDuplicates() public {
        address[] memory list = new address[](2);
        list[0] = creatorA;
        list[1] = creatorA;
        vm.expectRevert(FixedCreators.Duplicate.selector);
        new FixedCreators(list);
        list[1] = address(0);
        vm.expectRevert(FixedCreators.ZeroAddress.selector);
        new FixedCreators(list);
    }

    // M2: a gate carries its own floor

    function test_M2_isPatronAtLeast_appliesTheGatesFloor() public {
        _join(3_000e6);
        _route(creatorA, 1); // one unit per period
        src.gain(40e6);
        vm.warp(block.timestamp + 10 days);
        assertTrue(vault.isPatron(creatorA, alice), "any nonzero route passes the bare check");
        assertFalse(vault.isPatronAtLeast(creatorA, alice, 10e6), "not at the gate's floor");
        _route(creatorA, 10e6);
        vm.warp(block.timestamp + 1 days);
        assertTrue(vault.isPatronAtLeast(creatorA, alice, 10e6));
        assertFalse(vault.isPatronAtLeast(creatorB, alice, 1), "no route to B");
    }

    // L1: a source that eats the whole stipend is starved, not refused: the call reverts, nothing is forgiven

    function test_L1_heavySource_revertsSourceOutOfGas_neverForgives() public {
        _join(3_000e6);
        _route(creatorA, 10e6);
        src.gain(40e6);
        vm.warp(block.timestamp + PERIOD);
        src.setWithdrawGasBurn(1_600_000); // more than PAYOUT_GAS

        vm.prank(alice);
        vm.expectRevert(PatronVault.SourceOutOfGas.selector);
        vault.settle(alice);

        // the gas-tuned removal that used to forgive the creator now cannot go through at all
        vm.prank(alice);
        vm.expectRevert(PatronVault.SourceOutOfGas.selector);
        vault.setRoute(creatorA, 0);

        src.setWithdrawGasBurn(1_000_000); // heavy but within the stipend: paid
        vm.prank(alice);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 9.5e6);
    }

    // L2: a source whose maxWithdraw view breaks is treated as illiquid; nobody is trapped

    function test_L2_brokenMaxWithdrawView_holdsPayments_membersStillLeave() public {
        PatronVault po =
            new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, sink, 0, address(0), address(0));
        vm.startPrank(alice);
        usdc.approve(address(po), type(uint256).max);
        po.join(3_000e6, TERMS);
        po.setRoute(creatorA, 10e6);
        vm.stopPrank();
        src.gain(40e6);
        vm.warp(block.timestamp + PERIOD);
        src.setMaxWithdrawReverts(true);

        vm.prank(alice);
        po.settle(alice); // held, not reverted
        assertEq(usdc.balanceOf(creatorA), 0);
        assertEq(po.routesOf(alice)[0].carry / PERIOD, 10e6, "held for liquidity");
        (,, uint256 pay) = po.previewSettle(alice);
        assertEq(pay, 0);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        po.withdraw(500e6);
        assertGe(usdc.balanceOf(alice) - before, 500e6);
        vm.prank(alice);
        po.leave(); // the buffer cannot be forwarded: parked, the member still leaves with the deposit
        assertApproxEqAbs(usdc.balanceOf(alice), 100_000e6, 4);
        assertGt(po.sinkShares(), 0);

        src.setMaxWithdrawReverts(false);
        po.forwardSink();
        assertApproxEqAbs(usdc.balanceOf(sink), 40e6, 4, "once the view works, the sink gets the buffer");
    }

    // L4: under scarce liquidity the member's deposit comes first; the creators' buffer waits as parked shares

    function test_L4_scarceLiquidityExit_principalFirst_bufferParked() public {
        PatronVault po =
            new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, sink, 0, address(0), address(0));
        vm.startPrank(alice);
        usdc.approve(address(po), type(uint256).max);
        po.join(3_500e6, TERMS); // the pilot's all-or-nothing member
        po.setRoute(creatorA, 10e6);
        vm.stopPrank();
        src.gain(200e6); // a 200 buffer
        src.setLiquidity(3_550e6); // enough for the deposit and 50 of the buffer, not both in full

        vm.prank(alice);
        po.leave();
        assertApproxEqAbs(usdc.balanceOf(alice), 100_000e6, 4, "the deposit came back in full");
        assertApproxEqAbs(
            usdc.balanceOf(creatorA), 50e6, 4, "the creator got what the source could pay beyond the deposit"
        );
        assertApproxEqAbs(src.previewRedeem(po.sinkShares()), 150e6, 4, "the rest of the buffer is parked");

        src.setLiquidity(type(uint256).max);
        po.forwardSink();
        assertApproxEqAbs(usdc.balanceOf(sink), 150e6, 4);
        assertEq(src.balanceOf(address(po)), 0);
    }

    function test_F14_aRefusedPayment_isStillHeld_withGasAvailable() public {
        _join(3_000e6);
        _route(creatorA, 5e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true);
        vm.prank(alice);
        vault.settle{gas: 3_000_000}(alice);
        assertEq(vault.routesOf(alice)[0].carry / PERIOD, 5e6, "a real refusal is held, as before");
        assertTrue(vault.memberOf(alice).funded);
    }
}
