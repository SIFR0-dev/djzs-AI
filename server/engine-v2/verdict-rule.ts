/**
 * DJZS verdict rule over a tally (DJZS-VR-v1.0).
 * ─────────────────────────────────────────────
 * The last step of the deterministic engine, isolated: given WHAT the engine counted (the fired
 * codes, how many scored fields were unknown, whether the position or bet was bounded, whether a
 * thesis was present), derive the risk score and the verdict. Nothing else enters the verdict.
 *
 * This file exists so the same rule can live in three places and be held together:
 *   deterministic-engine.ts      runs it inline and now also emits the tally it decided from
 *   this file                    the rule alone, pure, over the tally
 *   contracts/DJZSVerdictRule.sol the rule on Base, byte for byte
 * tests/verdict-rule-fixtures.ts sweeps the full engine input space, checks this function against
 * the engine on every input, and writes the distinct tallies with their outcomes to
 * tests/fixtures/verdict-rule-*.json, which the Hardhat test replays against the contract.
 *
 * Weights and severities are read from the frozen taxonomies (DJZS-PM-v1.0, DJZS-LF-v1.2), never
 * restated here. The thresholds are the engine's: PM condemns at 25, LF at 50.
 */
import { LOGIC_FAILURE_TAXONOMY, SCHEMA_VERSION, type LFCode } from "@shared/audit-schema";
import { PM_FAIL_THRESHOLD, PM_SCHEMA_VERSION, PM_TAXONOMY, type PMCode } from "@shared/pm-taxonomy";

export const VERDICT_RULE_VERSION = "DJZS-VR-v1.0" as const;

/** The rulesets the rule knows. Any other string is refused, never scored as zero. */
export const RULESETS = [PM_SCHEMA_VERSION, SCHEMA_VERSION] as const;
export type Ruleset = (typeof RULESETS)[number];

/** LF condemns when weights cross this; the engine's FAIL_THRESHOLD. */
export const LF_FAIL_THRESHOLD = 50;

export type Verdict = "PASS" | "WAIT" | "FAIL";
export const VERDICT_CODE: Record<Verdict, 1 | 2 | 3> = { PASS: 1, WAIT: 2, FAIL: 3 };

export type VerdictTally = {
  ruleset: Ruleset;
  /** Fired codes, sorted, unique. */
  codes: string[];
  /** Scored fields the extraction left unknown. */
  unknown_count: number;
  /**
   * PM: invalidation_condition, resolution_engagement and probability_basis all present.
   * LF: stop_loss or invalidation_condition present.
   */
  bounded: boolean;
  /** LF: thesis_statement present. PM: not consulted, recorded as true. */
  thesis_present: boolean;
};

export type RuleOutcome = { risk_score: number; verdict: Verdict };

export class UnknownRulesetError extends Error {}
export class UnknownCodeError extends Error {}

function weightAndCritical(ruleset: Ruleset, code: string): { weight: number; critical: boolean } {
  if (ruleset === PM_SCHEMA_VERSION) {
    const def = PM_TAXONOMY[code as PMCode];
    if (!def) throw new UnknownCodeError(`${code} is not a ${ruleset} code`);
    return { weight: def.weight, critical: def.severity === "CRITICAL" };
  }
  const def = LOGIC_FAILURE_TAXONOMY[code as LFCode];
  if (!def) throw new UnknownCodeError(`${code} is not a ${ruleset} code`);
  return { weight: def.weight, critical: def.severity === "CRITICAL" };
}

/**
 * Pure. FAIL when any fired code is CRITICAL or the weights reach the ruleset's threshold.
 * Otherwise PASS when nothing fired and the intent is bounded (and, for LF, states a thesis).
 * Otherwise WAIT when any scored field is unknown. Otherwise PASS.
 */
export function verdictFromTally(t: VerdictTally): RuleOutcome {
  if (!RULESETS.includes(t.ruleset)) throw new UnknownRulesetError(`unknown ruleset ${String(t.ruleset)}`);
  const seen = new Set<string>();
  let risk_score = 0;
  let critical = false;
  for (const code of t.codes) {
    if (seen.has(code)) throw new UnknownCodeError(`duplicate code ${code}`);
    seen.add(code);
    const w = weightAndCritical(t.ruleset, code);
    risk_score += w.weight;
    critical = critical || w.critical;
  }
  const threshold = t.ruleset === PM_SCHEMA_VERSION ? PM_FAIL_THRESHOLD : LF_FAIL_THRESHOLD;
  const thesisOk = t.ruleset === PM_SCHEMA_VERSION ? true : t.thesis_present;
  let verdict: Verdict;
  if (critical || risk_score >= threshold) verdict = "FAIL";
  else if (t.codes.length === 0 && t.bounded && thesisOk) verdict = "PASS";
  else if (t.unknown_count > 0) verdict = "WAIT";
  else verdict = "PASS";
  return { risk_score, verdict };
}

/** Canonical text of a tally, for fixtures and for de-duplication. */
export function tallyKey(t: VerdictTally): string {
  return `${t.ruleset}|${t.codes.join("+")}|u${t.unknown_count}|b${t.bounded ? 1 : 0}|t${t.thesis_present ? 1 : 0}`;
}
