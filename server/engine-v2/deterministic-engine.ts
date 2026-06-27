/**
 * DJZS engine-v2 — Deterministic Audit Engine (Architecture C core)
 * ─────────────────────────────────────────────────────────────────
 * Pure function: structured AuditInput → verdict. ZERO model dependence,
 * ZERO randomness, ZERO I/O. The same input always yields a byte-identical
 * output (proven by the determinism tests). This is the moat — a verdict
 * you can reproduce and a hash you can anchor.
 *
 * Three-valued verdict (the Architecture C contribution):
 *   FAIL  — a rule fired on facts we KNOW (a real finding)
 *   WAIT  — we lack a fact we'd need to clear or condemn (honest abstention)
 *   PASS  — every scored fact is known, and no rule fired
 *
 * Rule codes and weights are NOT redefined here — they are imported from the
 * frozen shared taxonomy (DJZS-LF-v1.1) so engine-v2 scores against the same
 * canonical table as everything else in the system.
 */
import { LOGIC_FAILURE_TAXONOMY, type LFCode, type Severity } from "@shared/audit-schema";
import { AUDIT_FIELDS, type AuditField, type AuditInput, type Field } from "./audit-input-schema";
import { canonicalize, sha256Hex } from "./hash";

export type EngineVerdict = "PASS" | "WAIT" | "FAIL";

export interface EngineFlag {
  code: LFCode;
  name: string;
  severity: Severity;
  weight: number;
  evidence: string;
}

export interface EngineResult {
  verdict: EngineVerdict;
  risk_score: number;
  flags: EngineFlag[];
  unknown_fields: AuditField[];
  verdict_hash: string;
  engine: "djzs-engine-v2/deterministic";
}

/** A finding fired by `value` is below the FAIL line until weights cross this. */
const FAIL_THRESHOLD = 50;

/** Social/sentiment signals that, when used as a data source, indicate a FOMO loop. */
const SOCIAL_SIGNALS = ["social_sentiment", "social", "twitter", "x.com", "telegram", "discord", "sentiment"];

const is = <T>(f: Field<T>, state: Field<T>["state"]) => f.state === state;

function flag(code: LFCode, evidence: string): EngineFlag {
  const def = LOGIC_FAILURE_TAXONOMY[code];
  return { code, name: def.name, severity: def.severity, weight: def.weight, evidence };
}

// ─── Rules ────────────────────────────────────────────────────────────────
// Each rule fires ONLY on affirmative knowledge. A rule that depends on an
// `unknown` field does not fire — that uncertainty surfaces as a WAIT instead
// of a guessed verdict. This is the absent-vs-unknown discipline in code.

// v0.1 heuristic: a present oracle whose description signals a self-reported /
// manipulatable source, not a verifiable feed. String-match for now — replace with a
// schema trust-tier field under DJZS-M. Acceptance test: block-e01-2.
const UNVERIFIED_ORACLE_MARKERS = [
  "self-reported", "self reported", "frontend", "dashboard", "their own",
  "protocol's own", "protocols own", "the team's", "website", "app shows", "ui shows",
];
function oracleIsUnverified(oracle: Field<string>): boolean {
  if (oracle.state !== "present") return false;
  const v = String(oracle.value ?? "").toLowerCase();
  return UNVERIFIED_ORACLE_MARKERS.some(m => v.includes(m));
}

/** DJZS-X01 EXECUTION_UNBOUND — an active position with no halt condition. */
function ruleExecutionUnbound(input: AuditInput): EngineFlag | null {
  const hasPosition = is(input.leverage, "present") || is(input.position_size, "present");
  const noStop = is(input.stop_loss, "absent");
  const noInvalidation = is(input.invalidation_condition, "absent");
  if (hasPosition && noStop && noInvalidation) {
    return flag(
      "DJZS-X01",
      "Active position with no stop_loss and no invalidation condition — unbounded downside, no halt.",
    );
  }
  return null;
}

/** DJZS-E01 ORACLE_UNVERIFIED — data cited without a verifiable oracle source. */
function ruleOracleUnverified(input: AuditInput): EngineFlag | null {
  if (is(input.data_sources, "present") &&
      (is(input.oracle_source, "absent") || oracleIsUnverified(input.oracle_source))) {
    return flag(
      "DJZS-E01",
      "External data sources cited, but no oracle_source provides provenance.",
    );
  }
  return null;
}

/** DJZS-I01 FOMO_LOOP — the decision is driven by a social signal. */
function ruleFomoLoop(input: AuditInput): EngineFlag | null {
  if (is(input.data_sources, "present")) {
    const sources = (input.data_sources as { state: "present"; value: string[] }).value ?? [];
    const social = sources.find((s) => SOCIAL_SIGNALS.includes(String(s).toLowerCase()));
    if (social) {
      return flag("DJZS-I01", `Decision driven by social signal "${social}" rather than verified data.`);
    }
  }
  return null;
}

const RULES = [ruleExecutionUnbound, ruleOracleUnverified, ruleFomoLoop];

/** The single, pure entry point. */
export function runDeterministicAudit(input: AuditInput): EngineResult {
  const flags: EngineFlag[] = [];
  for (const rule of RULES) {
    const fired = rule(input);
    if (fired) flags.push(fired);
  }

  const unknown_fields = AUDIT_FIELDS.filter(
    (name) => (input[name] as Field<unknown>).state === "unknown",
  );

  const risk_score = flags.reduce((sum, f) => sum + f.weight, 0);
  const hasCritical = flags.some((f) => f.severity === "CRITICAL");

  let verdict: EngineVerdict;
  const isBounded =
    input.stop_loss.state === "present" ||
    input.invalidation_condition.state === "present";

  if (hasCritical || risk_score >= FAIL_THRESHOLD) {
    // A real finding on known facts always condemns — even amid open questions.
    verdict = "FAIL";
  } else if (flags.length === 0 && isBounded) {
    // Bounded position, no flaw fired: remaining unknowns cannot change a no-flag verdict.
    verdict = "PASS";
  } else if (unknown_fields.length > 0) {
    // No finding, but an unknown could still be decision-critical: abstain rather than guess.
    verdict = "WAIT";
  } else {
    verdict = "PASS";
  }

  // Hash is a pure function of the verdict-bearing content, so it is stable
  // across runs by construction — no cache, no nonce, no timestamp.
  const verdict_hash = sha256Hex(
    canonicalize({
      verdict,
      risk_score,
      flags: flags.map((f) => f.code).sort(),
      unknown_fields,
    }),
  );

  return {
    verdict,
    risk_score,
    flags,
    unknown_fields,
    verdict_hash,
    engine: "djzs-engine-v2/deterministic",
  };
}
