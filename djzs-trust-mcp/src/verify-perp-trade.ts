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
import { BREAKEVEN_MIN_EDGE_E4, breakevenFloor } from "./floor";

/**
 * Optional exact bracket numbers (caller-supplied, never extracted). Feeds ONLY the non-scoring
 * mechanics block: the break-even hit rate p* = (1 + c)/(1 + R). Nothing here reaches extraction,
 * the engine, risk_score, the verdict, verdict_hash or the anchored certificate.
 */
export const PERP_BRACKET_INPUT = z.object({
  side: z.enum(["long", "short"]),
  entry: z.number().positive(),
  stop: z.number().positive(),
  target: z.number().positive(),
  hit_rate_pct: z.number().min(1).max(99).optional()
    .describe("The thesis's stated probability, in percent, that the target prints before the stop"),
  taker_fee_bps: z.number().min(0).max(100)
    .describe("The venue's taker fee in basis points, charged on entry and on exit"),
  funding_rate_8h: z.number().min(-0.05).max(0.05).optional()
    .describe("Funding rate per 8 hours as a fraction (0.0001 = 0.01%); longs pay a positive rate. Counted only with sigma_annual"),
  sigma_annual: z.number().positive().max(10).optional()
    .describe("Annualized volatility as a fraction (0.45 = 45%); sets the expected hold, and so the funding paid"),
});
export type PerpBracket = z.infer<typeof PERP_BRACKET_INPUT>;

export const VERIFY_PERP_TRADE_INPUT = {
  intent: z
    .string()
    .min(10, "intent must be at least 10 characters")
    .describe("Free-text perpetual or spot trade thesis to audit: direction, size, leverage, entry, stop, target, venue, and the REASON"),
  bracket: PERP_BRACKET_INPUT.optional()
    .describe("Optional exact bracket (side, entry, stop, target, taker_fee_bps, optional hit_rate_pct / funding_rate_8h / sigma_annual). Returns the break-even hit rate in the non-scoring mechanics block; never enters the verdict or its hash"),
};

export type VerifyPerpTradeResult = Record<string, unknown>;

const MECHANICS_NOTE =
  "Reasoning verdict only. Execution mechanics are Gate 2 — report them alongside, never inside, this verdict.";

/**
 * The break-even floor for a stop/target bracket, reported beside the verdict. A bracket is a binary on
 * which level prints first: with no drift the target prints first p0 = 1/(1+R) of the time (from entry),
 * and the bracket breaks even at p* = (1+c)/(1+R), c = fees (+ expected funding) in stop distances.
 * R changes the payoff's shape, never its expectation, so the floor a thesis must clear is p*, not an RR.
 */
export function breakevenMechanics(b: PerpBracket): Record<string, unknown> {
  // One integer price unit for all four prices: about twelve significant digits at the entry.
  const k = 12 - Math.floor(Math.log10(b.entry));
  const px = (x: number) => Math.round(x * 10 ** k);
  const withFunding = b.funding_rate_8h !== undefined && b.sigma_annual !== undefined;
  try {
    const f = breakevenFloor({
      side: b.side,
      entry: px(b.entry),
      stop: px(b.stop),
      target: px(b.target),
      pClaimE4: b.hit_rate_pct === undefined ? null : Math.round(b.hit_rate_pct * 100),
      takerFeeBpsE2: Math.round(b.taker_fee_bps * 100),
      fundingRate: withFunding ? (b.funding_rate_8h as number) : 0,
      fundingIntervalMs: 8 * 3_600_000,
      sigmaAnnual: withFunding ? (b.sigma_annual as number) : 1,
    });
    return {
      status: "computed",
      scored: false,
      r: f.rE4 / 10_000,
      c: f.cE4 / 10_000,
      pstar_pct: f.pStarE4 / 100,
      p0_pct: f.p0E4 / 100,
      hit_rate_pct: b.hit_rate_pct ?? null,
      clears_floor: b.hit_rate_pct === undefined ? null : f.pass,
      floor_margin_pts: BREAKEVEN_MIN_EDGE_E4 / 100,
      funding_included: withFunding,
      expected_hold_hours: withFunding ? Math.round(f.holdMs / 360_000) / 10 : null,
      reason: f.reason,
      rule:
        "p* = (1 + c) / (1 + R): the hit rate the bracket needs to break even after fees" +
        (withFunding ? " and expected funding" : "") +
        ". With no drift the target prints first p0 of the time; R changes the payoff's shape, never its expectation. Not scored: never enters risk_score, the verdict or verdict_hash.",
    };
  } catch (e) {
    return { status: "invalid", scored: false, reason: e instanceof Error ? e.message.replace(/^breakEven: /, "") : String(e) };
  }
}

export async function runVerifyPerpTrade(
  intent: string,
  modelFn: ModelFn,
  bracket?: PerpBracket,
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
    mechanics: {
      status: "not_scored",
      note: MECHANICS_NOTE,
      breakeven: bracket ? breakevenMechanics(bracket) : null,
    },
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
