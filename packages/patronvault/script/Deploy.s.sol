// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";

/// @notice Deploys PatronVault with every parameter taken from the environment, and the termsHash
///         taken from the terms file itself so the text and the hash cannot drift apart.
///
///         Required:  SOURCE              the ERC-4626 yield source (its asset() must be the USDC you expect)
///         Optional:  MIN_DEPOSIT         asset units, default 3500000000 (3,500 USDC)
///                    PERIOD              seconds, default 2592000 (30 days)
///                    MAX_TOTAL_PRINCIPAL asset units, default 0 (no cap)
///                    JOIN_DEADLINE       unix seconds, default 0 (no deadline)
///                    YIELD_SINK          principal-only mode: members cannot claim yield; on leave the unrouted
///                                        yield goes to their routes, or to this address with no routes.
///                                        Default 0 = members keep and may claim unrouted yield.
///                    FEE_BPS             protocol fee on creator payments in basis points, default 0, max 1000
///                    FEE_RECIPIENT       where collectFees() sends it; required when FEE_BPS > 0
///                    EXPECT_ASSET        if set, the deploy reverts unless SOURCE.asset() equals it
///
///         Dry run (no broadcast, no key):
///           SOURCE=0x... forge script script/Deploy.s.sol --rpc-url $RPC
///         Real run adds --broadcast and a signer flag of your choice (--ledger, --account, ...). Never a raw key in a shell line.
contract Deploy is Script {
    string public constant TERMS_FILE = "terms/member-terms-v1.md";

    function run() external returns (PatronVault vault) {
        IERC4626 source = IERC4626(vm.envAddress("SOURCE"));
        uint256 minDeposit = vm.envOr("MIN_DEPOSIT", uint256(3_500e6));
        uint256 period = vm.envOr("PERIOD", uint256(30 days));
        uint256 maxTotalPrincipal = vm.envOr("MAX_TOTAL_PRINCIPAL", uint256(0));
        uint256 joinDeadline = vm.envOr("JOIN_DEADLINE", uint256(0));
        address yieldSink = vm.envOr("YIELD_SINK", address(0));
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(0));
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0));
        address expectAsset = vm.envOr("EXPECT_ASSET", address(0));

        address asset = source.asset();
        require(expectAsset == address(0) || asset == expectAsset, "SOURCE.asset() is not EXPECT_ASSET");
        require(joinDeadline == 0 || joinDeadline > block.timestamp, "JOIN_DEADLINE is in the past");

        bytes32 termsHash = keccak256(bytes(vm.readFile(TERMS_FILE)));

        vm.startBroadcast();
        vault = new PatronVault(source, minDeposit, period, termsHash, maxTotalPrincipal, joinDeadline, yieldSink, feeBps, feeRecipient);
        vm.stopBroadcast();

        console2.log("PatronVault:        ", address(vault));
        console2.log("asset:              ", asset);
        console2.log("source:             ", address(source));
        console2.log("minDeposit:         ", minDeposit);
        console2.log("period (s):         ", period);
        console2.log("maxTotalPrincipal:  ", maxTotalPrincipal);
        console2.log("joinDeadline:       ", joinDeadline);
        console2.log("yieldSink:          ", yieldSink);
        console2.log("feeBps:             ", feeBps);
        console2.log("feeRecipient:       ", feeRecipient);
        console2.log("termsHash:");
        console2.logBytes32(termsHash);
    }
}
