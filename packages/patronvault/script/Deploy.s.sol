// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PatronVault} from "../src/PatronVault.sol";
import {FixedCreators} from "../src/FixedCreators.sol";
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
///                    CREATORS            comma-separated creator addresses: deploys a FixedCreators registry with
///                                        exactly these, and the vault accepts routes only to them (the pilot: the
///                                        Scan Room payee). Omit for a vault that accepts any creator address.
///                    CREATOR_REGISTRY    an existing registry to use instead of deploying one (mutually exclusive)
///                    TERMS_FILE          the terms text whose keccak256 becomes termsHash, default
///                                        terms/member-terms-v1.md (the pilot, no fee). A nonzero FEE_BPS refuses
///                                        the v1 text, which does not disclose a fee: pass terms/member-terms-v1.1.md.
///                    EXPECT_ASSET        if set, the deploy reverts unless SOURCE.asset() equals it
///
///         Dry run (no broadcast, no key):
///           SOURCE=0x... forge script script/Deploy.s.sol --rpc-url $RPC
///         Real run adds --broadcast and a signer flag of your choice (--ledger, --account, ...). Never a raw key in a shell line.
contract Deploy is Script {
    string public constant DEFAULT_TERMS_FILE = "terms/member-terms-v1.md";

    struct Params {
        IERC4626 source;
        uint256 minDeposit;
        uint256 period;
        uint256 maxTotalPrincipal;
        uint256 joinDeadline;
        address yieldSink;
        uint256 feeBps;
        address feeRecipient;
        address registry;
        address[] creators;
        string termsFile;
        bytes32 termsHash;
    }

    function _read() internal view returns (Params memory p) {
        p.source = IERC4626(vm.envAddress("SOURCE"));
        p.minDeposit = vm.envOr("MIN_DEPOSIT", uint256(3_500e6));
        p.period = vm.envOr("PERIOD", uint256(30 days));
        p.maxTotalPrincipal = vm.envOr("MAX_TOTAL_PRINCIPAL", uint256(0));
        p.joinDeadline = vm.envOr("JOIN_DEADLINE", uint256(0));
        p.yieldSink = vm.envOr("YIELD_SINK", address(0));
        p.feeBps = vm.envOr("FEE_BPS", uint256(0));
        p.feeRecipient = vm.envOr("FEE_RECIPIENT", address(0));
        p.registry = vm.envOr("CREATOR_REGISTRY", address(0));
        p.creators = vm.envOr("CREATORS", ",", new address[](0));
        p.termsFile = vm.envOr("TERMS_FILE", DEFAULT_TERMS_FILE);
        p.termsHash = keccak256(bytes(vm.readFile(p.termsFile)));
    }

    function run() external returns (PatronVault vault) {
        Params memory p = _read();
        address expectAsset = vm.envOr("EXPECT_ASSET", address(0));
        address asset = p.source.asset();
        require(expectAsset == address(0) || asset == expectAsset, "SOURCE.asset() is not EXPECT_ASSET");
        require(p.joinDeadline == 0 || p.joinDeadline > block.timestamp, "JOIN_DEADLINE is in the past");
        require(
            p.registry == address(0) || p.creators.length == 0, "CREATORS and CREATOR_REGISTRY are mutually exclusive"
        );
        require(
            p.feeBps == 0 || keccak256(bytes(p.termsFile)) != keccak256(bytes(DEFAULT_TERMS_FILE)),
            "FEE_BPS > 0 with the v1 terms, which disclose no fee: set TERMS_FILE=terms/member-terms-v1.1.md"
        );

        vm.startBroadcast();
        if (p.creators.length != 0) p.registry = address(new FixedCreators(p.creators));
        vault = new PatronVault(
            p.source,
            p.minDeposit,
            p.period,
            p.termsHash,
            p.maxTotalPrincipal,
            p.joinDeadline,
            p.yieldSink,
            p.feeBps,
            p.feeRecipient,
            p.registry
        );
        vm.stopBroadcast();

        console2.log("PatronVault:        ", address(vault));
        console2.log("asset:              ", asset);
        console2.log("source:             ", address(p.source));
        console2.log("minDeposit:         ", p.minDeposit);
        console2.log("period (s):         ", p.period);
        console2.log("maxTotalPrincipal:  ", p.maxTotalPrincipal);
        console2.log("joinDeadline:       ", p.joinDeadline);
        console2.log("yieldSink:          ", p.yieldSink);
        console2.log("feeBps:             ", p.feeBps);
        console2.log("feeRecipient:       ", p.feeRecipient);
        console2.log("creatorRegistry:    ", p.registry);
        for (uint256 i = 0; i < p.creators.length; i++) {
            console2.log("  creator:          ", p.creators[i]);
        }
        console2.log("terms file:         ", p.termsFile);
        console2.log("termsHash:");
        console2.logBytes32(p.termsHash);
    }
}
