/**
 * verify_perp_trade — the perpetual/spot TRADE audit pipeline. Mirrors verify-pm-trade.ts and is
 * deliberately a separate pipeline (Path B ruling): the caller's choice of tool declares the context,
 * so this pipeline runs the perp extraction prompt (DJZS-X-LF-v1.2, carries thesis_statement) while
 * verify_pm_trade keeps the PM prompt untouched. A prediction-market bet submitted here is refused
 * (in_scope:false, not charged) — never silently audited as a trade.
 * Engine: the same deterministic engine, perp path (DJZS-LF-v1.2: X01, E01, I01, S01 live).
 */
import {
  extractAuditInputConsensus,
  EXTRACTION_CONTRACT_VERSION_LF,
  type ModelFn,
} from "../../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../../server/engine-v2/deterministic-engine";
import { SCHEMA_VERSION, WEIGHTS_HASH, TAXONOMY_HASH } from "@shared/audit-schema";
import { z } from "zod";

export const VERIFY_PERP_TRADE_INPUT = {
  intent: z
    .string()
    .min(10, "intent must be at least 10 characters")
    .describe("Free-text perpetual or spot trade thesis to audit: direction, size, leverage, entry, stop, target, venue, and the REASON"),
};

export type VerifyPerpTradeResult = Record<string, unknown>;

export async function runVerifyPerpTrade(
  intent: string,
  modelFn: ModelFn,
): Promise<VerifyPerpTradeResult> {
  const r = await extractAuditInputConsensus(intent, modelFn, 3, "perp");

  // PERP-ONLY SCOPE: a prediction-market thesis is refused, not reinterpreted.
  if (r.input.audit_context === "prediction_market") {
    return {
      schema_version: "DJZS-ENGINE-V2",
      tool: "verify_perp_trade",
      in_scope: false,
      reason:
        "Perp-only tool: the intent extracted as a prediction-market thesis. Use verify_pm_trade.",
      verdict: null,
    };
  }
  r.input.audit_context = "perp";

  const result = runDeterministicAudit(r.input);
  const action =
    result.verdict === "PASS" ? "PROCEED" : result.verdict === "FAIL" ? "FAIL" : "HALT";

  const response: VerifyPerpTradeResult = {
    schema_version: "DJZS-ENGINE-V2",
    tool: "verify_perp_trade",
    in_scope: true,
    taxonomy: {
      perp: SCHEMA_VERSION,
      weights_hash: WEIGHTS_HASH,
      taxonomy_hash: TAXONOMY_HASH,
      extraction: EXTRACTION_CONTRACT_VERSION_LF,
    },
    verdict: result.verdict,
    action,
    risk_score: result.risk_score,
    flags: result.flags, // sub-threshold non-critical flags (E01, I01) ride a PASS as advisories by frozen weight
    unknown_fields: result.unknown_fields,
    disagreements: r.disagreements,
    verdict_hash: result.verdict_hash,
    extraction_failsafe: r.failsafe,
    // Gate 2 is not this tool's job. Liquidation distance, funding cost, R:R are reported by the
    // caller's execution pipeline (or DJZS's gate2-mechanics) and never enter risk_score or the verdict.
    mechanics: { status: "not_scored", note: "Reasoning verdict only. Execution mechanics are Gate 2 — report them alongside, never inside, this verdict." },
  };

  if (action === "HALT") {
    const u = result.unknown_fields;
    response.halt_reason =
      `WAIT: ${u.length} field(s) unresolvable from intent — [${u.join(", ")}].` +
      (u.includes("thesis_statement") ? " State the reason the price should move your way." : "") +
      (u.includes("stop_loss") || u.includes("invalidation_condition") ? " State the exit level or the condition that proves the thesis wrong." : "") +
      " Clarify intent and re-audit.";
  }
  if (action === "FAIL" && Array.isArray(result.flags) && result.flags.some((f: { code: string }) => f.code === "DJZS-S01")) {
    response.fail_reason = "Position stated with no articulated thesis. Mechanics can be checked; reasoning cannot. Add the reason for the direction and re-audit.";
  }
  return response;
}
