// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {PatronHandler} from "./handlers/PatronHandler.sol";

/// @dev Properties that must hold after any sequence of member, creator and market actions.
///      I1  Every source share the vault holds belongs to exactly one member.
///      I2  The vault never holds the asset itself.
///      I3  totalPrincipal and memberCount are exact sums.
///      I4  With no source loss on record, every member's shares back their principal, within one
///          share per deposit (ERC-4626 rounds each deposit against the depositor; nothing else).
///      I5  Everything ever paid to creators, set aside or collected as fee, or claimed as yield came out of source gains (plus the sub-share
///          rounding dust that other depositors' own operations leave behind in the source).
///      I6  A member who left holds nothing: no principal, no shares, no routes.
///      I7  A current member's principal is never below the minimum.
///      I8  A member in shortfall cannot pay anyone: settle and claim would both move nothing.
contract PatronVaultInvariants is Test {
    MockUSDC usdc;
    MockERC4626 src;
    PatronVault vault;
    PatronHandler handler;

    bytes32 constant TERMS = keccak256("DJZS Patron Vault member terms v1");

    function _sink() internal virtual returns (address) {
        return address(0);
    }

    function _feeBps() internal pure virtual returns (uint256) {
        return 500; // the product default, so the fee path is under every invariant
    }

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        src = new MockERC4626(usdc);
        vault = new PatronVault(IERC4626(address(src)), 500e6, 30 days, TERMS, 0, 0, _sink(), _feeBps(), makeAddr("fees"));
        handler = new PatronHandler(usdc, src, vault, TERMS);
        targetContract(address(handler));
    }

    function invariant_I1_sharesBelongToMembers() public view {
        uint256 sum = vault.feeShares();
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            sum += vault.memberOf(handler.members(i)).shares;
        }
        assertEq(sum, src.balanceOf(address(vault)), "shares held = members' shares + the fee pool");
    }

    function invariant_I2_vaultHoldsNoAsset() public view {
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function invariant_I3_totalsAreExact() public view {
        uint256 sum;
        uint256 count;
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            uint256 p = vault.memberOf(handler.members(i)).principal;
            sum += p;
            if (p != 0) count++;
        }
        assertEq(sum, vault.totalPrincipal());
        assertEq(count, vault.memberCount());
    }

    function invariant_I4_principalBackedWhenSourceHasNotLost() public view {
        if (handler.lossSinceClean()) return;
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            address m = handler.members(i);
            PatronVault.Member memory mm = vault.memberOf(m);
            if (mm.principal == 0) continue;
            assertGe(mm.shares + handler.deposits(m), src.previewWithdraw(mm.principal), "principal not backed");
        }
    }

    function invariant_I5_payoutsComeFromGainsOnly() public view {
        uint256 paid = vault.creatorPaid(vault.yieldSink()) + handler.feesCollected() + src.previewRedeem(vault.feeShares());
        for (uint256 i = 0; i < handler.creatorsLength(); i++) {
            paid += vault.creatorPaid(handler.creators(i));
        }
        // ERC-4626 rounds every outside deposit or withdrawal against its caller; the dust stays in the source
        // and lifts every holder by less than one share. That is the only non-gain value a payout can contain.
        assertLe(paid + handler.claimedTotal(), src.gains() + 2 * handler.outsiderOps());
    }

    function invariant_I6_leaversHoldNothing() public view {
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            address m = handler.members(i);
            PatronVault.Member memory mm = vault.memberOf(m);
            if (mm.principal != 0) continue;
            assertEq(mm.shares, 0);
            assertEq(vault.routesOf(m).length, 0);
            assertFalse(vault.isPatron(handler.creators(0), m));
        }
    }

    function invariant_I7_membersMeetMinimum() public view {
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            uint256 p = vault.memberOf(handler.members(i)).principal;
            if (p != 0) assertGe(p, vault.minDeposit());
        }
    }

    function invariant_I8_shortfallPaysNothing() public view {
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            address m = handler.members(i);
            PatronVault.Member memory mm = vault.memberOf(m);
            if (mm.principal == 0 || !vault.inShortfall(m)) continue;
            (, uint256 fromYield, uint256 pay) = vault.previewSettle(m);
            assertEq(fromYield, 0, "settle would pay a creator out of a shortfall");
            assertEq(pay, 0);
            assertEq(vault.claimableYield(m), 0, "claim would pay the member out of a shortfall");
        }
    }

    /// @dev Not a property: a fixed pseudo-random walk proving the handler reaches the interesting states
    ///      (payouts, claims, losses, illiquidity), so the invariants above are not passing vacuously.
    function test_handlerReachesInterestingStates() public {
        uint256 r = uint256(keccak256("patronvault"));
        bool sawLoss;
        for (uint256 i = 0; i < 800; i++) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 a = r % 14;
            uint256 x = r >> 8;
            uint256 y = r >> 96;
            if (a == 0) handler.join(x, y);
            else if (a == 1) handler.deposit(x, y);
            else if (a == 2) handler.withdraw(x, y);
            else if (a == 3) handler.claim(x, y);
            else if (a == 4 || a == 5) handler.setRoute(x, y, uint96(r >> 160));
            else if (a == 6 || a == 7) handler.settle(x);
            else if (a == 8) handler.leave(x);
            else if (a == 9) handler.setCreatorMin(x, uint96(y));
            else if (a == 10) handler.warp(x);
            else if (a == 11) handler.gain(x);
            else if (a == 12) handler.loss(x, y);
            else if (a == 13 && (y & 1) == 1) handler.collectFees();
            else handler.setLiquidity(x, y);
            sawLoss = sawLoss || handler.lossSinceClean();
            if (i % 8 != 0) continue; // memory, not gas, is the EVM limit on a long walk
            invariant_I1_sharesBelongToMembers();
            invariant_I2_vaultHoldsNoAsset();
            invariant_I3_totalsAreExact();
            invariant_I4_principalBackedWhenSourceHasNotLost();
            invariant_I5_payoutsComeFromGainsOnly();
            invariant_I6_leaversHoldNothing();
            invariant_I7_membersMeetMinimum();
            invariant_I8_shortfallPaysNothing();
        }
        uint256 paid;
        for (uint256 i = 0; i < handler.creatorsLength(); i++) {
            paid += vault.creatorPaid(handler.creators(i));
        }
        emit log_named_uint("creators paid (USDC units)", paid);
        emit log_named_uint("sink paid (USDC units)", vault.creatorPaid(vault.yieldSink()));
        emit log_named_uint("fees collected (USDC units)", handler.feesCollected());
        emit log_named_uint("fee pool uncollected (USDC units)", src.previewRedeem(vault.feeShares()));
        emit log_named_uint("members claimed (USDC units)", handler.claimedTotal());
        emit log_named_uint("source gains (USDC units)", src.gains());
        emit log_named_uint("source losses (USDC units)", src.losses());
        emit log_named_uint("illiquidity reverts tolerated", handler.illiquidReverts());
        assertGt(paid, 0, "no creator was ever paid");
        if (vault.yieldSink() == address(0)) assertGt(handler.claimedTotal(), 0, "no member ever claimed");
        else assertGt(vault.creatorPaid(vault.yieldSink()), 0, "the sink never received anything");
        assertTrue(sawLoss, "no loss was ever injected");
        assertGt(src.losses(), 0);
        assertGt(handler.feesCollected() + src.previewRedeem(vault.feeShares()), 0, "the fee path never ran");
    }
}

/// @dev The same properties in principal-only mode: members cannot claim, leavers forward unrouted yield.
contract PatronVaultInvariantsSink is PatronVaultInvariants {
    function _sink() internal override returns (address) {
        return makeAddr("sink");
    }

    function invariant_I9_membersNeverReceiveYield() public view {
        // a member's USDC in hand never exceeds what they started with: deposits go out, deposits come back,
        // yield does not, apart from the MAX_ROUTES shares of rounding dust an exit may leave with the member
        for (uint256 i = 0; i < handler.membersLength(); i++) {
            address m = handler.members(i);
            assertLe(usdc.balanceOf(m), 1_000_000e6 + 2 * vault.MAX_ROUTES() * handler.leaves(m), "a member received yield");
        }
    }
}
