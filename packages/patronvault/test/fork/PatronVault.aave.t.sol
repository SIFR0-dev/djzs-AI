// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../../src/PatronVault.sol";
import {FixedCreators} from "../../src/FixedCreators.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IERC4626} from "../../src/interfaces/IERC4626.sol";

/// @dev The pilot's month, run against the real source on a Base mainnet fork: the Aave v3 Base USDC wrapper
///      (StataTokenV2) and real USDC. Interest accrues on the fork by warping, because Aave's normalized income
///      is computed from the reserve's last update timestamp and block.timestamp.
///
///      Runs only when FORK_RPC_URL is set, so the offline suite stays offline:
///        FORK_RPC_URL=https://mainnet.base.org forge test --match-path test/fork/PatronVault.aave.t.sol -vv
contract PatronVaultAaveForkTest is Test {
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC4626 constant WRAPPER = IERC4626(0xC768c589647798a6EE01A91FdE98EF2ed046DBD6); // waBasUSDC

    uint256 constant MIN = 3_500e6;
    uint256 constant PERIOD = 30 days;
    uint256 constant CAP = 49_000e6;

    PatronVault vault;
    bytes32 terms;
    address alice = makeAddr("alice");
    address payee = makeAddr("scan-room-payee");
    address sink = makeAddr("sink");
    address keeper = makeAddr("keeper");

    function setUp() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        terms = keccak256(bytes(vm.readFile("terms/member-terms-v1.md")));
        address[] memory creators = new address[](1);
        creators[0] = payee;
        FixedCreators registry = new FixedCreators(creators); // the pilot's one creator
        vault = new PatronVault(
            WRAPPER, MIN, PERIOD, terms, CAP, block.timestamp + 60 days, sink, 0, address(0), address(registry)
        );
        deal(address(USDC), alice, 10_000e6);
        vm.prank(alice);
        USDC.approve(address(vault), type(uint256).max);
    }

    function test_fork_pilotMonth_joinRouteSettleWithdrawLeave() public {
        assertEq(address(vault.asset()), address(USDC));
        assertEq(WRAPPER.asset(), address(USDC));

        // join 4,000 so a 500 withdrawal later leaves exactly the minimum
        vm.prank(alice);
        vault.join(4_000e6, terms);
        PatronVault.Member memory m = vault.memberOf(alice);
        assertEq(m.principal, 4_000e6);
        assertEq(WRAPPER.balanceOf(address(vault)), m.shares, "every wrapper share is alice's");
        assertEq(USDC.balanceOf(address(vault)), 0, "the vault holds no USDC");
        // ERC-4626 rounds the deposit against the depositor by at most one share; on this wrapper one share is
        // about 1.15 USDC, so the position can read a little below principal until interest covers that share
        assertGe(m.shares + 1, WRAPPER.previewWithdraw(4_000e6), "join cost more than one share of rounding");
        uint256 oneShare = WRAPPER.previewRedeem(1) + 1;
        assertGe(vault.positionValue(alice) + oneShare, 4_000e6, "position reads principal within one share");
        emit log_named_uint("one wrapper share in USDC units", oneShare);
        emit log_named_uint("position value at join (USDC units)", vault.positionValue(alice));
        emit log_named_uint("in shortfall at join (1 = yes)", vault.inShortfall(alice) ? 1 : 0);

        vm.prank(alice);
        vault.setRoute(payee, 10e6);
        assertTrue(vault.isPatron(payee, alice));

        // one month of real Aave interest
        vm.warp(block.timestamp + PERIOD);
        (uint256 owed, uint256 fromYield, uint256 pay) = vault.previewSettle(alice);
        assertEq(owed, 10e6, "exact accrual over one period");
        emit log_named_uint("yield available after a month (USDC units)", vault.positionValue(alice) - 4_000e6);
        emit log_named_uint("owed", owed);
        emit log_named_uint("from yield", fromYield);
        emit log_named_uint("payable today", pay);

        uint256 principalSharesBefore = WRAPPER.previewWithdraw(4_000e6);
        vm.prank(keeper);
        vault.settle(alice);
        m = vault.memberOf(alice);
        assertEq(USDC.balanceOf(payee), pay, "the payee got what the preview said");
        assertEq(vault.creatorPaid(payee), pay);
        assertGe(m.shares, principalSharesBefore, "a payout never burned a principal share");
        assertEq(m.principal, 4_000e6);
        assertEq(vault.isPatron(payee, alice), fromYield * 10_000 >= owed * vault.FUNDED_BPS());

        // principal-only: nothing to claim
        vm.prank(alice);
        vm.expectRevert(PatronVault.YieldNotClaimable.selector);
        vault.claimYield(1);

        // part of the deposit back: exactly what was asked, within the source's rounding
        uint256 before = USDC.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(500e6);
        uint256 got = USDC.balanceOf(alice) - before;
        assertGe(got, 500e6, "withdraw paid less than asked");
        assertLe(got, 500e6 + 2, "withdraw paid more than a rounding step over");
        m = vault.memberOf(alice);
        assertEq(m.principal, 3_500e6);
        assertGe(m.shares, WRAPPER.previewWithdraw(3_500e6), "remaining principal still backed");

        // leave: deposit back, the buffer goes to the payee, the vault is empty
        uint256 payeeBefore = USDC.balanceOf(payee);
        before = USDC.balanceOf(alice);
        vm.prank(alice);
        vault.leave();
        uint256 back = USDC.balanceOf(alice) - before;
        assertGe(back, 3_500e6, "leave returned less than principal");
        assertLe(back, 3_500e6 + 2, "leave returned more than principal plus rounding: yield leaked to a member");
        assertGt(USDC.balanceOf(payee) - payeeBefore, 0, "the exit buffer went to the payee");
        assertEq(vault.memberOf(alice).principal, 0);
        assertEq(vault.memberOf(alice).shares, 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.memberCount(), 0);
        assertEq(WRAPPER.balanceOf(address(vault)), 0, "no shares left behind");
        assertEq(USDC.balanceOf(address(vault)), 0);
        // the member ends within the source's rounding of where they started: the deposit came back, the yield did not
        assertApproxEqAbs(
            USDC.balanceOf(alice), 10_000e6, 2 * vault.MAX_ROUTES(), "member balance moved by more than rounding dust"
        );
        emit log_named_int(
            "alice balance change over the month (USDC units)", int256(USDC.balanceOf(alice)) - int256(10_000e6)
        );
        emit log_named_uint("payee received in total (USDC units)", USDC.balanceOf(payee));
    }

    /// @dev The trap the keeper hit on this fork on 2026-10-21 before PAYOUT_GAS existed: eth_estimateGas returned
    ///      ~253k for a settle whose real cost is ~333k, because at 253k the wrapper's withdraw ran out of gas
    ///      inside the aToken burn, the catch held the payment, and the transaction "succeeded" paying nobody.
    function test_fork_settleStarvedOfGas_revertsInsteadOfHolding() public {
        vm.prank(alice);
        vault.join(4_000e6, terms);
        vm.prank(alice);
        vault.setRoute(payee, 10e6);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(keeper);
        vm.expectRevert(PatronVault.InsufficientGas.selector);
        vault.settle{gas: 253_000}(alice);
        assertEq(USDC.balanceOf(payee), 0);
        assertEq(vault.routesOf(alice)[0].carry, 0, "nothing was held");

        vm.prank(keeper);
        vault.settle{gas: 2_600_000}(alice);
        assertEq(USDC.balanceOf(payee), 10e6, "with the stipend available, the payee is paid in full");
    }

    function test_fork_capAndDeadlineHold() public {
        vm.prank(alice);
        vault.join(4_000e6, terms);
        address bob = makeAddr("bob");
        deal(address(USDC), bob, 50_000e6);
        vm.startPrank(bob);
        USDC.approve(address(vault), type(uint256).max);
        vm.expectRevert(PatronVault.CapReached.selector);
        vault.join(46_000e6, terms); // 4,000 + 46,000 > 49,000
        vault.join(45_000e6, terms);
        vm.stopPrank();
        assertEq(vault.totalPrincipal(), 49_000e6);

        vm.warp(block.timestamp + 61 days);
        address carol = makeAddr("carol");
        deal(address(USDC), carol, 5_000e6);
        vm.startPrank(carol);
        USDC.approve(address(vault), type(uint256).max);
        vm.expectRevert(PatronVault.JoinClosed.selector);
        vault.join(3_500e6, terms);
        vm.stopPrank();
    }
}
