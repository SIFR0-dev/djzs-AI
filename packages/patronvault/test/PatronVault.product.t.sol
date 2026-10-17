// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

/// @dev v1.1, the product additions: protocol fee with a hard cap, one-transaction join with permit,
///      batch routes, settleMany for the keeper.
contract PatronVaultProductTest is Test {
    MockUSDC usdc;
    MockERC4626 src;
    PatronVault vault;

    bytes32 constant TERMS = keccak256("DJZS Patron Vault member terms v1");
    uint256 constant MIN = 500e6;
    uint256 constant PERIOD = 30 days;
    uint256 constant FEE = 500; // 5%

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address creatorA = makeAddr("creatorA");
    address creatorB = makeAddr("creatorB");
    address creatorC = makeAddr("creatorC");
    address fees = makeAddr("fees");
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");

    uint256 constant PK = 0xA11CE;
    address signer = vm.addr(PK);

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        src = new MockERC4626(usdc);
        vault = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), FEE, fees);
        _fund(alice);
        _fund(bob);
        usdc.mint(signer, 100_000e6); // the signer never calls approve: permit does it
    }

    function _fund(address who) internal {
        usdc.mint(who, 100_000e6);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.join(amount, TERMS);
    }

    function _route(address who, address creator, uint96 perPeriod) internal {
        vm.prank(who);
        vault.setRoute(creator, perPeriod);
    }

    function _principalShares(address who) internal view returns (uint256) {
        return src.previewWithdraw(vault.memberOf(who).principal);
    }

    function _permitSig(uint256 pk, address owner, uint256 value, uint256 deadline) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), owner, address(vault), value, usdc.nonces(owner), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────────── fee ─────────────────────────────

    function test_fee_comesOutOfTheCreatorPayment_neverPrincipal() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 10e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(keeper);
        vault.settle(alice);

        assertEq(usdc.balanceOf(creatorA), 9.5e6, "creator gets 95%");
        assertEq(vault.creatorPaid(creatorA), 9.5e6);
        assertApproxEqAbs(src.previewRedeem(vault.feeShares()), 0.5e6, 2, "5% sits in the fee pool");
        assertGe(vault.memberOf(alice).shares, _principalShares(alice), "principal shares intact");
        assertEq(vault.memberOf(alice).shares + vault.feeShares(), src.balanceOf(address(vault)), "every share accounted for");

        vm.expectEmit(true, false, false, false);
        emit PatronVault.FeesCollected(fees, 0);
        vm.prank(stranger);
        uint256 got = vault.collectFees();
        assertApproxEqAbs(got, 0.5e6, 2);
        assertEq(usdc.balanceOf(fees), got);
        assertEq(vault.feeShares(), 0);
    }

    function test_fee_zeroMeansNoPool() public {
        PatronVault free = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), 0, address(0));
        vm.prank(alice);
        usdc.approve(address(free), type(uint256).max);
        vm.prank(alice);
        free.join(3_000e6, TERMS);
        vm.prank(alice);
        free.setRoute(creatorA, 10e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        free.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 10e6);
        assertEq(free.feeShares(), 0);
        vm.expectRevert(PatronVault.NoFees.selector);
        free.collectFees();
    }

    function test_fee_capAndRecipientEnforcedAtDeployment() public {
        vm.expectRevert(PatronVault.FeeTooHigh.selector);
        new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), 1_001, fees);
        vm.expectRevert(PatronVault.ZeroAddress.selector);
        new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), 500, address(0));
        PatronVault max = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, address(0), 1_000, fees);
        assertEq(max.feeBps(), 1_000);
        assertEq(max.MAX_FEE_BPS(), 1_000);
    }

    function test_fee_notTakenOnWhatWasNotPaid() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 10e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);
        usdc.setBlocked(creatorA, true);

        vm.prank(keeper);
        vault.settle(alice);
        assertEq(vault.feeShares(), 0, "no payment, no fee");
        assertEq(vault.routesOf(alice)[0].carry / PERIOD, 10e6, "the whole 10 stays owed");

        usdc.setBlocked(creatorA, false);
        vm.prank(keeper);
        vault.settle(alice);
        assertEq(usdc.balanceOf(creatorA), 9.5e6);
        assertApproxEqAbs(src.previewRedeem(vault.feeShares()), 0.5e6, 2);
    }

    function test_fee_proRataAcrossRoutes_whenYieldIsShort() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 6e6);
        _route(alice, creatorB, 2e6);
        src.gain(4e6);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(keeper);
        vault.settle(alice);
        uint256 a = usdc.balanceOf(creatorA);
        uint256 b = usdc.balanceOf(creatorB);
        assertApproxEqAbs(a, 2.85e6, 6, "95% of a 3 share");
        assertApproxEqAbs(b, 0.95e6, 6, "95% of a 1 share");
        assertApproxEqAbs(src.previewRedeem(vault.feeShares()), 0.2e6, 6);
        assertFalse(vault.memberOf(alice).funded);
    }

    function test_fee_principalOnlyMode_forwardedBufferCarriesNoFee() public {
        address sink = makeAddr("sink");
        PatronVault po = new PatronVault(IERC4626(address(src)), MIN, PERIOD, TERMS, 0, 0, sink, FEE, fees);
        vm.prank(alice);
        usdc.approve(address(po), type(uint256).max);
        vm.prank(alice);
        po.join(3_000e6, TERMS);
        vm.prank(alice);
        po.setRoute(creatorA, 10e6);
        src.gain(30e6);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(alice);
        po.leave();
        // the settle on the way out paid 9.5 (fee 0.5); the 20 buffer was forwarded whole
        assertApproxEqAbs(usdc.balanceOf(creatorA), 9.5e6 + 20e6, 6);
        assertApproxEqAbs(src.previewRedeem(po.feeShares()), 0.5e6, 2);
        assertGe(usdc.balanceOf(alice), 100_000e6);
    }

    // ───────────────────────────── permit join ─────────────────────────────

    function test_joinWithPermit_oneTransaction_noPriorApprove() public {
        assertEq(usdc.allowance(signer, address(vault)), 0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _permitSig(PK, signer, 3_000e6, deadline);
        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](2);
        routes[0] = PatronVault.RouteInput(creatorA, 6e6);
        routes[1] = PatronVault.RouteInput(creatorB, 2e6);

        vm.prank(signer);
        vault.joinWithPermit(3_000e6, TERMS, deadline, sig, routes);

        assertEq(vault.memberOf(signer).principal, 3_000e6);
        assertEq(vault.routesOf(signer).length, 2);
        assertTrue(vault.isPatron(creatorA, signer));
        assertTrue(vault.isPatron(creatorB, signer));
        assertEq(usdc.allowance(signer, address(vault)), 0, "the permit was consumed exactly");
        assertEq(usdc.nonces(signer), 1);
    }

    function test_joinWithPermit_survivesAFrontRunPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _permitSig(PK, signer, 3_000e6, deadline);
        // a griefer submits the member's permit first; the member's own transaction must still succeed
        vm.prank(stranger);
        usdc.permit(signer, address(vault), 3_000e6, deadline, sig);
        assertEq(usdc.allowance(signer, address(vault)), 3_000e6);

        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](0);
        vm.prank(signer);
        vault.joinWithPermit(3_000e6, TERMS, deadline, sig, routes);
        assertEq(vault.memberOf(signer).principal, 3_000e6);
    }

    function test_joinWithPermit_badSignatureWithoutAllowance_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _permitSig(0xBEEF, signer, 3_000e6, deadline); // signed by the wrong key
        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](0);
        vm.prank(signer);
        vm.expectRevert(PatronVault.TransferFailed.selector);
        vault.joinWithPermit(3_000e6, TERMS, deadline, sig, routes);
        assertEq(vault.memberOf(signer).principal, 0);
    }

    function test_joinWithPermit_stillChecksTermsMinimumAndRoutes() public {
        uint256 deadline = block.timestamp + 1 hours;
        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](1);
        routes[0] = PatronVault.RouteInput(signer, 1e6); // a self route
        bytes memory sig = _permitSig(PK, signer, 3_000e6, deadline);
        vm.prank(signer);
        vm.expectRevert(PatronVault.SelfRoute.selector);
        vault.joinWithPermit(3_000e6, TERMS, deadline, sig, routes);

        sig = _permitSig(PK, signer, MIN - 1, deadline);
        vm.prank(signer);
        vm.expectRevert(PatronVault.BelowMinimum.selector);
        vault.joinWithPermit(MIN - 1, TERMS, deadline, sig, new PatronVault.RouteInput[](0));
    }

    // ───────────────────────────── batch routes ─────────────────────────────

    function test_joinAndRoute_setsRoutesAtTheDoor() public {
        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](3);
        routes[0] = PatronVault.RouteInput(creatorA, 5e6);
        routes[1] = PatronVault.RouteInput(creatorB, 3e6);
        routes[2] = PatronVault.RouteInput(creatorC, 1e6);
        vm.prank(alice);
        vault.joinAndRoute(3_000e6, TERMS, routes);
        assertEq(vault.routesOf(alice).length, 3);
        assertTrue(vault.isPatron(creatorC, alice));
    }

    function test_setRoutes_addChangeRemove_settlesOnce() public {
        _join(alice, 3_000e6);
        _route(alice, creatorA, 5e6);
        src.gain(20e6);
        vm.warp(block.timestamp + PERIOD);

        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](3);
        routes[0] = PatronVault.RouteInput(creatorA, 0); // remove, after it is paid for the month
        routes[1] = PatronVault.RouteInput(creatorB, 4e6); // add
        routes[2] = PatronVault.RouteInput(creatorC, 2e6); // add
        vm.prank(alice);
        vault.setRoutes(routes);

        assertEq(usdc.balanceOf(creatorA), 4.75e6, "paid up to the second it was removed, less the fee");
        PatronVault.Route[] memory rs = vault.routesOf(alice);
        assertEq(rs.length, 2);
        assertEq(rs[0].creator, creatorB);
        assertEq(rs[1].creator, creatorC);
        assertFalse(vault.isPatron(creatorA, alice));
        assertTrue(vault.isPatron(creatorB, alice));
    }

    function test_setRoutes_rejectsWhatSetRouteRejects() public {
        _join(alice, 3_000e6);
        vm.prank(creatorB);
        vault.setCreatorMin(5e6);
        PatronVault.RouteInput[] memory routes = new PatronVault.RouteInput[](2);
        routes[0] = PatronVault.RouteInput(creatorA, 1e6);
        routes[1] = PatronVault.RouteInput(creatorB, 4e6); // under the creator's floor
        vm.prank(alice);
        vm.expectRevert(PatronVault.BelowCreatorMinimum.selector);
        vault.setRoutes(routes);
        assertEq(vault.routesOf(alice).length, 0, "all or nothing");
    }

    // ───────────────────────────── keeper ─────────────────────────────

    function test_settleMany_settlesMembersAndSkipsStrangers() public {
        _join(alice, 3_000e6);
        _join(bob, 3_000e6);
        _route(alice, creatorA, 10e6);
        _route(bob, creatorB, 10e6);
        src.gain(40e6);
        vm.warp(block.timestamp + PERIOD);

        address[] memory batch = new address[](3);
        batch[0] = alice;
        batch[1] = stranger;
        batch[2] = bob;
        vm.prank(keeper);
        vault.settleMany(batch);

        assertEq(usdc.balanceOf(creatorA), 9.5e6);
        assertEq(usdc.balanceOf(creatorB), 9.5e6);
        assertEq(vault.memberOf(stranger).principal, 0);
    }

    function test_settleMany_emptyIsANoop() public {
        vm.prank(keeper);
        vault.settleMany(new address[](0));
    }
}
