/**
 * DJZS engine-v2 — Audit Input Schema (Architecture C)
 * ─────────────────────────────────────────────────────
 * The structured, model-independent representation that the deterministic
 * engine reasons over. Every fact the engine needs is a *tri-state* field:
 *
 *   present  — the model affirmatively extracted a concrete value
 *   absent   — the model affirmatively asserts the fact does NOT exist
 *              (e.g. "there is no stop loss")
 *   unknown  — the model could not determine the fact, or refused to guess
 *
 * The distinction between `absent` and `unknown` is the whole point: an
 * *absent* stop-loss is a finding (the agent has unbounded downside); an
 * *unknown* stop-loss is a question (we must WAIT, not guess). Collapsing
 * the two is how Architecture A produced flicker and false verdicts.
 *
 * This file is pure types + a zod validator. No model, no API, no I/O.
 */
import { z } from "zod";

export type FieldStatus = "present" | "absent" | "unknown";

export type Field<T> =
  | { state: "present"; value: T }
  | { state: "absent" }
  | { state: "unknown" };

export interface AuditInput {
  /** descriptive context — not scored, but carried for evidence/audit trail */
  agent_type: string;
  intended_action: string;
  market_type?: string;

  /**
   * Which taxonomy this audit is scored against. Optional and absence-tolerant:
   * a missing value is treated as "perp" (the original DJZS-LF behavior), so
   * every existing input remains valid and unchanged. "prediction_market"
   * selects the parallel DJZS-M taxonomy. This is descriptive routing context —
   * it is NOT one of the scored facts.
   */
  audit_context?: "perp" | "prediction_market";

  /** scored facts — every one is tri-state */
  leverage: Field<number>;
  position_size: Field<number>;
  stop_loss: Field<number | string>;
  take_profit: Field<number | string>;
  invalidation_condition: Field<string>;
  /** PM-only scored fact — listed in PM_AUDIT_FIELDS, deliberately NOT in AUDIT_FIELDS. */
  resolution_engagement: Field<string>;
  /** PM-only scored fact — listed in PM_AUDIT_FIELDS, deliberately NOT in AUDIT_FIELDS. */
  probability_basis: Field<string>;
  /**
   * PM-only ADVISORY signal. Not in PM_AUDIT_FIELDS: advisory uncertainty must not
   * create WAIT-pressure, and unknown_fields feeds the verdict_hash — existing PM
   * hashes stay frozen. Not in isBounded: the L3 principle — a field joins the
   * scored sets iff a solo block depends on it; solo M04 cannot block by frozen weight.
   */
  edge_claim: Field<string>;
  data_sources: Field<string[]>;
  oracle_source: Field<string>;
  confidence: Field<number>;
}

/**
 * The scored facts, in canonical order. The engine iterates this list to
 * compute `unknown_fields`, so the ordering here is the ordering of any
 * WAIT report — keep it stable (it feeds the verdict hash by construction).
 */
export const AUDIT_FIELDS = [
  "leverage",
  "position_size",
  "stop_loss",
  "take_profit",
  "invalidation_condition",
  "data_sources",
  "oracle_source",
  "confidence",
] as const;

export type AuditField = (typeof AUDIT_FIELDS)[number];

/**
 * PM-path scored facts. runPredictionAudit computes its unknown_fields over
 * THIS list, in this order; AUDIT_FIELDS above stays frozen so the perp path
 * (WAIT-report ordering and verdict hashes) is untouched.
 */
export const PM_AUDIT_FIELDS = ["invalidation_condition", "resolution_engagement", "probability_basis"] as const;

export type PMAuditField = (typeof PM_AUDIT_FIELDS)[number];

// ─── runtime validation ──────────────────────────────────────────────────
// `value` is intentionally permissive (z.any) — per-field value typing is
// enforced at the TS layer; the schema's job here is to guarantee the
// tri-state envelope is well-formed before the engine trusts it.
const fieldSchema = z.union([
  z.object({ state: z.literal("present"), value: z.any() }),
  z.object({ state: z.literal("absent") }),
  z.object({ state: z.literal("unknown") }),
]);

export const auditInputSchema = z.object({
  agent_type: z.string(),
  intended_action: z.string(),
  market_type: z.string().optional(),
  audit_context: z.enum(["perp", "prediction_market"]).optional(),
  leverage: fieldSchema,
  position_size: fieldSchema,
  stop_loss: fieldSchema,
  take_profit: fieldSchema,
  invalidation_condition: fieldSchema,
  resolution_engagement: fieldSchema,
  probability_basis: fieldSchema,
  edge_claim: fieldSchema,
  data_sources: fieldSchema,
  oracle_source: fieldSchema,
  confidence: fieldSchema,
});

/** Canonical "we know nothing" field — the fail-safe default. */
export const UNKNOWN: Field<never> = { state: "unknown" };
