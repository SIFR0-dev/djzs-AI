// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Read-only checks of a candidate yield source, run against a fork. This is the part of the
///         R2 screening rules a script can verify; the rest (admin powers, oracle history, curator record,
///         30-day utilisation) is read from the protocol's own disclosures and written down by hand.
///
///         SOURCE=0x... USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 forge script script/Screen.s.sol --rpc-url $RPC
///
///         Checks:
///           1. asset() is the USDC address you pass (rule 1: native USDC on Base, no bridged or wrapped stand-in)
///           2. the round-trip the vault relies on: redeeming previewWithdraw(x) shares returns at least x, for a
///              ladder of amounts (the "principal shares" accounting is only sound on a source with this property)
///           3. the source's reported liquidity (maxWithdraw of its largest holder you name, or totalAssets) against
///              the vault you plan, for rule 6 (withdrawable liquidity at least 10x the vault)
contract Screen is Script {
    function run() external view {
        IERC4626 src = IERC4626(vm.envAddress("SOURCE"));
        address usdc = vm.envAddress("USDC");
        uint256 planned = vm.envOr("PLANNED_VAULT", uint256(49_000e6));
        address probe = vm.envOr("PROBE_HOLDER", address(0));

        address asset = src.asset();
        console2.log("source:      ", address(src));
        console2.log("asset:       ", asset);
        console2.log("asset ok:    ", asset == usdc);
        console2.log("totalAssets: ", src.totalAssets());

        uint256[6] memory ladder = [uint256(1), 999_999, 500e6, 3_500e6, 49_000e6, 1_000_000e6];
        bool roundTripOk = true;
        for (uint256 i = 0; i < ladder.length; i++) {
            uint256 x = ladder[i];
            uint256 back = src.previewRedeem(src.previewWithdraw(x));
            if (back < x) roundTripOk = false;
            console2.log("round trip x -> previewRedeem(previewWithdraw(x)):", x, back);
        }
        console2.log("round trip ok:", roundTripOk);

        uint256 liquid = probe == address(0) ? src.totalAssets() : src.maxWithdraw(probe);
        console2.log("liquidity figure used:        ", liquid);
        console2.log("planned vault (asset units):  ", planned);
        console2.log("liquidity >= 10x planned:     ", liquid >= 10 * planned);
        console2.log("source share decimals:        ", IERC20(address(src)).decimals());
    }
}
