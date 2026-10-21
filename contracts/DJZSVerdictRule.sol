// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DJZSVerdictRule
/// @notice The DJZS verdict rule (DJZS-VR-v1.0) on Base: the last step of the deterministic engine,
/// as bytecode. Given what the engine counted (a Tally), it derives the risk score and the verdict.
/// @dev Byte for byte the rule in server/engine-v2/verdict-rule.ts and the inline rungs of
/// server/engine-v2/deterministic-engine.ts. tests/fixtures/verdict-rule.json holds every distinct
/// tally the engine produces over its full input space, and test/DJZSVerdictRule.test.cjs replays
/// it against this contract, so the three copies of the rule cannot drift apart.
///
/// The weights and severities are the frozen taxonomies DJZS-PM-v1.0 (sum 100) and DJZS-LF-v1.2
/// (sum 200). They are constants here, and the constructor refuses to deploy if they do not sum to
/// the governed totals. A new taxonomy version is a new contract at a new address, never an edit.
///
/// Verdict codes: PASS 1, WAIT 2, FAIL 3. Doctrine: LLM detects, TypeScript decides, the chain checks.
contract DJZSVerdictRule {
    string public constant VERSION = "DJZS-VR-v1.0";
    string public constant PM_RULESET = "DJZS-PM-v1.0";
    string public constant LF_RULESET = "DJZS-LF-v1.2";

    uint8 public constant PASS = 1;
    uint8 public constant WAIT = 2;
    uint8 public constant FAIL = 3;

    /// @dev The engine's thresholds: PM_FAIL_THRESHOLD in shared/pm-taxonomy.ts, FAIL_THRESHOLD in
    /// server/engine-v2/deterministic-engine.ts.
    uint16 public constant PM_FAIL_THRESHOLD = 25;
    uint16 public constant LF_FAIL_THRESHOLD = 50;
    uint16 public constant PM_WEIGHT_SUM = 100;
    uint16 public constant LF_WEIGHT_SUM = 200;

    bytes32 internal constant PM_ID = keccak256("DJZS-PM-v1.0");
    bytes32 internal constant LF_ID = keccak256("DJZS-LF-v1.2");

    /// @notice What the engine counted. `codes` are the fired taxonomy codes, unique.
    /// `bounded`: PM, invalidation_condition, resolution_engagement and probability_basis all present;
    /// LF, stop_loss or invalidation_condition present. `thesisPresent`: LF, thesis_statement present;
    /// PM does not consult it.
    struct Tally {
        string rulesetVersion;
        string[] codes;
        uint8 unknownCount;
        bool bounded;
        bool thesisPresent;
    }

    error UnknownRuleset(string rulesetVersion);
    error UnknownCode(string rulesetVersion, string code);
    error DuplicateCode(string code);
    error WeightSumMismatch(string rulesetVersion, uint16 actual, uint16 expected);
    error InvalidVerdictCode(uint8 code);

    constructor() {
        // The same integrity assertion the TypeScript taxonomies run at import: the frozen weight
        // budgets are 100 and 200. If a future edit breaks that, this contract does not deploy.
        uint16 pm;
        string[4] memory pmCodes = ["DJZS-M01", "DJZS-M02", "DJZS-M03", "DJZS-M04"];
        for (uint256 i; i < pmCodes.length; ++i) {
            (uint16 w,,) = weightOf(PM_ID, keccak256(bytes(pmCodes[i])));
            pm += w;
        }
        if (pm != PM_WEIGHT_SUM) revert WeightSumMismatch(PM_RULESET, pm, PM_WEIGHT_SUM);

        uint16 lf;
        string[11] memory lfCodes = [
            "DJZS-S01", "DJZS-S02", "DJZS-S03", "DJZS-E01", "DJZS-E02", "DJZS-I01", "DJZS-I02", "DJZS-I03",
            "DJZS-X01", "DJZS-X02", "DJZS-T01"
        ];
        for (uint256 i; i < lfCodes.length; ++i) {
            (uint16 w,,) = weightOf(LF_ID, keccak256(bytes(lfCodes[i])));
            lf += w;
        }
        if (lf != LF_WEIGHT_SUM) revert WeightSumMismatch(LF_RULESET, lf, LF_WEIGHT_SUM);
    }

    /// @notice Weight and severity of a code in a ruleset. `known` is false for a code the ruleset
    /// does not define, so a caller can never mistake an unknown code for a zero-weight one.
    function weightOf(bytes32 rulesetId, bytes32 codeId) public pure returns (uint16 weight, bool critical, bool known) {
        if (rulesetId == PM_ID) {
            if (codeId == keccak256("DJZS-M01")) return (30, true, true); // NARRATIVE_RESOLUTION_GAP, CRITICAL
            if (codeId == keccak256("DJZS-M02")) return (30, true, true); // FALSIFICATION_ABSENT, CRITICAL
            if (codeId == keccak256("DJZS-M03")) return (25, false, true); // PROBABILITY_UNSOURCED, HIGH
            if (codeId == keccak256("DJZS-M04")) return (15, false, true); // CONSENSUS_NO_EDGE, MEDIUM
            return (0, false, false);
        }
        if (rulesetId == LF_ID) {
            if (codeId == keccak256("DJZS-S01")) return (30, true, true); // CIRCULAR_LOGIC, CRITICAL
            if (codeId == keccak256("DJZS-S02")) return (25, false, true); // HIGH
            if (codeId == keccak256("DJZS-S03")) return (18, false, true); // MEDIUM
            if (codeId == keccak256("DJZS-E01")) return (25, false, true); // ORACLE_UNVERIFIED, HIGH
            if (codeId == keccak256("DJZS-E02")) return (18, false, true); // MEDIUM
            if (codeId == keccak256("DJZS-I01")) return (16, false, true); // FOMO_LOOP, MEDIUM
            if (codeId == keccak256("DJZS-I02")) return (16, false, true); // NARRATIVE_DEPENDENCY, MEDIUM
            if (codeId == keccak256("DJZS-I03")) return (16, false, true); // MEDIUM
            if (codeId == keccak256("DJZS-X01")) return (15, true, true); // EXECUTION_UNBOUND, CRITICAL
            if (codeId == keccak256("DJZS-X02")) return (9, false, true); // HIGH
            if (codeId == keccak256("DJZS-T01")) return (12, false, true); // LOW
            return (0, false, false);
        }
        return (0, false, false);
    }

    /// @notice The rule. FAIL when any fired code is CRITICAL or the weights reach the ruleset's
    /// threshold; otherwise PASS when nothing fired and the intent is bounded (LF: and a thesis is
    /// present); otherwise WAIT when any scored field is unknown; otherwise PASS.
    /// @dev Reverts on an unknown ruleset, an unknown code, or a duplicate code: a tally the rule
    /// cannot read is refused, never scored as zero.
    function score(Tally calldata t) public pure returns (uint16 riskScore, uint8 verdictCode) {
        bytes32 rulesetId = keccak256(bytes(t.rulesetVersion));
        uint16 threshold;
        if (rulesetId == PM_ID) threshold = PM_FAIL_THRESHOLD;
        else if (rulesetId == LF_ID) threshold = LF_FAIL_THRESHOLD;
        else revert UnknownRuleset(t.rulesetVersion);

        bool critical;
        for (uint256 i; i < t.codes.length; ++i) {
            bytes32 codeId = keccak256(bytes(t.codes[i]));
            for (uint256 j; j < i; ++j) {
                if (keccak256(bytes(t.codes[j])) == codeId) revert DuplicateCode(t.codes[i]);
            }
            (uint16 w, bool c, bool known) = weightOf(rulesetId, codeId);
            if (!known) revert UnknownCode(t.rulesetVersion, t.codes[i]);
            riskScore += w;
            critical = critical || c;
        }

        bool thesisOk = rulesetId == PM_ID ? true : t.thesisPresent;
        if (critical || riskScore >= threshold) verdictCode = FAIL;
        else if (t.codes.length == 0 && t.bounded && thesisOk) verdictCode = PASS;
        else if (t.unknownCount > 0) verdictCode = WAIT;
        else verdictCode = PASS;
    }

    /// @notice The verdict as the attestation spells it.
    function verdictString(uint8 code) public pure returns (string memory) {
        if (code == PASS) return "PASS";
        if (code == WAIT) return "WAIT";
        if (code == FAIL) return "FAIL";
        revert InvalidVerdictCode(code);
    }

    /// @notice True when an attested (riskScore, verdict) is exactly what the rule derives from the tally.
    function isConsistent(Tally calldata t, uint16 attestedRiskScore, string calldata attestedVerdict)
        external
        pure
        returns (bool)
    {
        (uint16 riskScore, uint8 verdictCode) = score(t);
        return riskScore == attestedRiskScore
            && keccak256(bytes(verdictString(verdictCode))) == keccak256(bytes(attestedVerdict));
    }
}
