// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DJZSVerdictRule} from "./DJZSVerdictRule.sol";

// The EAS types this resolver is called with, copied from eas-contracts Common.sol and
// resolver/ISchemaResolver.sol so no dependency is added. EAS on Base is the predeploy
// 0x4200000000000000000000000000000000000021; the SchemaRegistry is ...0020.
struct Attestation {
    bytes32 uid;
    bytes32 schema;
    uint64 time;
    uint64 expirationTime;
    uint64 revocationTime;
    bytes32 refUID;
    address recipient;
    address attester;
    bool revocable;
    bytes data;
}

interface ISchemaResolver {
    function version() external view returns (string memory);
    function isPayable() external pure returns (bool);
    function attest(Attestation calldata attestation) external payable returns (bool);
    function multiAttest(Attestation[] calldata attestations, uint256[] calldata values) external payable returns (bool);
    function revoke(Attestation calldata attestation) external payable returns (bool);
    function multiRevoke(Attestation[] calldata attestations, uint256[] calldata values) external payable returns (bool);
}

/// @title DJZSVerdictResolver
/// @notice EAS schema resolver for the DJZS verdict schema v3. An attestation under this schema is
/// accepted only when the verdict and risk score it states are exactly what DJZSVerdictRule derives
/// from the tally it also states. The public record therefore cannot hold a verdict that the
/// attested facts contradict, whoever the attester is.
/// @dev Schema v3, registered with this resolver and revocable = false:
///   bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,
///   uint8 unknownCount,bool bounded,bool thesisPresent
/// The first five fields are the v2 schema, unchanged; the last three are the rest of the tally.
/// Nothing here trusts the attester: a mismatch returns false and EAS reverts the attestation; a
/// tally the rule cannot read (unknown ruleset or code) reverts inside the rule and EAS bubbles it.
contract DJZSVerdictResolver is ISchemaResolver {
    string public constant SCHEMA =
        "bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,uint8 unknownCount,bool bounded,bool thesisPresent";
    bool public constant REVOCABLE = false;

    address public immutable eas;
    DJZSVerdictRule public immutable rule;

    event VerdictChecked(bytes32 indexed uid, bytes32 indexed intentHash, string rulesetVersion, uint16 riskScore, uint8 verdictCode);

    error AccessDenied();
    error ZeroAddress();
    error NotPayable();

    modifier onlyEAS() {
        if (msg.sender != eas) revert AccessDenied();
        _;
    }

    constructor(address eas_, DJZSVerdictRule rule_) {
        if (eas_ == address(0) || address(rule_) == address(0)) revert ZeroAddress();
        eas = eas_;
        rule = rule_;
    }

    /// @notice keccak256(abi.encodePacked(schema, resolver, revocable)): the UID the SchemaRegistry
    /// assigns to schema v3 once registered with this resolver.
    function schemaUID() external view returns (bytes32) {
        return keccak256(abi.encodePacked(SCHEMA, address(this), REVOCABLE));
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    function isPayable() external pure returns (bool) {
        return false;
    }

    /// @notice Free read: what the rule says about an encoded v3 attestation payload.
    function check(bytes calldata data) public view returns (bool ok, uint16 riskScore, uint8 verdictCode, bytes32 intentHash) {
        (
            bytes32 intentHash_,
            string memory verdict,
            uint8 attestedRisk,
            string[] memory flags,
            string memory rulesetVersion,
            uint8 unknownCount,
            bool bounded,
            bool thesisPresent
        ) = abi.decode(data, (bytes32, string, uint8, string[], string, uint8, bool, bool));
        DJZSVerdictRule.Tally memory t = DJZSVerdictRule.Tally({
            rulesetVersion: rulesetVersion,
            codes: flags,
            unknownCount: unknownCount,
            bounded: bounded,
            thesisPresent: thesisPresent
        });
        (riskScore, verdictCode) = rule.score(t);
        ok = riskScore == attestedRisk
            && keccak256(bytes(rule.verdictString(verdictCode))) == keccak256(bytes(verdict));
        intentHash = intentHash_;
    }

    function attest(Attestation calldata attestation) external payable onlyEAS returns (bool) {
        if (msg.value != 0) revert NotPayable();
        return _attest(attestation);
    }

    function multiAttest(Attestation[] calldata attestations, uint256[] calldata values)
        external
        payable
        onlyEAS
        returns (bool)
    {
        if (msg.value != 0) revert NotPayable();
        for (uint256 i; i < attestations.length; ++i) {
            if (values[i] != 0) revert NotPayable();
            if (!_attest(attestations[i])) return false;
        }
        return true;
    }

    /// @dev The schema is registered non-revocable, so EAS never reaches these. Nothing to check.
    function revoke(Attestation calldata) external payable onlyEAS returns (bool) {
        return true;
    }

    function multiRevoke(Attestation[] calldata, uint256[] calldata) external payable onlyEAS returns (bool) {
        return true;
    }

    function _attest(Attestation calldata attestation) internal returns (bool) {
        (bool ok, uint16 riskScore, uint8 verdictCode, bytes32 intentHash) = check(attestation.data);
        if (!ok) return false;
        emit VerdictChecked(attestation.uid, intentHash, _rulesetOf(attestation.data), riskScore, verdictCode);
        return true;
    }

    function _rulesetOf(bytes calldata data) internal pure returns (string memory rulesetVersion) {
        (,,,, rulesetVersion,,,) = abi.decode(data, (bytes32, string, uint8, string[], string, uint8, bool, bool));
    }
}
