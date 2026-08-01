/**
 * DJZS-A — Assertion Taxonomy · v0.1-DRAFT · DRAFT-UNVERIFIED — NOT CANON
 * ──────────────────────────────────────────────────────────────────────
 * Provisional weight table for assertion verification (claim-vs-truth). Authored
 * chat-side (governance values are the author's); recorded on disk here so the
 * engine + A-bench can build against it. On-disk source of the derivation:
 *   docs/djzs-a-taxonomy-v0.1-draft.md
 *
 * FREEZE GATE: these weights are MOVABLE until a named-buyer freeze (per the
 * derivation doc). On freeze this file becomes immutable canon with its own
 * frozen hash, exactly like shared/pm-taxonomy.ts (DJZS-M) and the DJZS-LF table.
 * Until then: DRAFT-UNVERIFIED. Nothing here is canon; do not cite it as frozen.
 *
 * Mirrors the M/LF shape: a frozen record, a summed weight budget with a fatal
 * integrity throw, and a taxonomy hash — but every "frozen" claim is downgraded
 * to "draft" until freeze.
 */
import { canonicalize, sha256Hex } from "./hash";

export type ACode = "A01" | "A02" | "A03" | "A04" | "A05" | "A06";

export interface ADefinition {
  code: ACode;
  name: string;
  weight: number;
  /** true => a solo fire condemns via the hasCritical branch regardless of score. */
  critical: boolean;
}

/**
 * The table, EXACTLY as authored (code/name/weight/critical). Do not add fields:
 * the draft taxonomy hash is taken over exactly this shape.
 */
export const A_TAXONOMY: Record<ACode, ADefinition> = {
  A01: { code: "A01", name: "QUANTITY_INTENT_MISMATCH", weight: 25, critical: true },
  A02: { code: "A02", name: "SCOPE_BOUNDARY_VIOLATION", weight: 15, critical: false },
  A03: { code: "A03", name: "ENVIRONMENT_CLASS_MISMATCH", weight: 10, critical: false },
  A04: { code: "A04", name: "RECIPIENT_UNVERIFIED", weight: 25, critical: true },
  A05: { code: "A05", name: "AUTHORITY_SOURCE_UNVERIFIED", weight: 15, critical: false },
  A06: { code: "A06", name: "STATE_ASSUMPTION_STALE", weight: 10, critical: false },
} as const;

export const ALL_A_CODES = Object.keys(A_TAXONOMY) as ACode[];

export const A_DRAFT_VERSION = "0.1" as const;
export const A_SCHEMA_VERSION = "DJZS-A-v0.1-DRAFT" as const;

/** FAIL line: risk_score >= this condemns even with no critical flag. */
export const A_FAIL_THRESHOLD = 25;

/** Weight budget — fatal integrity throw at module load, M/LF style. */
export const A_MAX_RISK_SCORE = Object.values(A_TAXONOMY).reduce((s, d) => s + d.weight, 0);
if (A_MAX_RISK_SCORE !== 100) {
  throw new Error(
    `[DJZS-A DRAFT FATAL] weights sum to ${A_MAX_RISK_SCORE}, expected 100. Table integrity compromised.`,
  );
}

/**
 * Draft taxonomy hash. CANONICAL FORM = the GOVERNANCE ENVELOPE, not the bare
 * weight table: { codes, fail_threshold, namespace, sum, version }. The identity
 * deliberately binds the WHOLE governance state — namespace + version + budget +
 * threshold + the codes — so a change to any of them (not just a code weight)
 * breaks the hash. The envelope is DERIVED from the live table + constants below
 * (each code carried as {critical, name, weight}, no code duplication), then
 * key-sorted by canonicalize(); property order in this file is irrelevant.
 */
export const A_GOVERNANCE_VERSION = "0.1-DRAFT" as const;

const A_TAXONOMY_ENVELOPE = {
  codes: Object.fromEntries(
    ALL_A_CODES.map((c) => [
      c,
      { critical: A_TAXONOMY[c].critical, name: A_TAXONOMY[c].name, weight: A_TAXONOMY[c].weight },
    ]),
  ),
  fail_threshold: A_FAIL_THRESHOLD,
  namespace: "DJZS-A",
  sum: A_MAX_RISK_SCORE,
  version: A_GOVERNANCE_VERSION,
};

export const A_TAXONOMY_CANON_PREIMAGE = canonicalize(A_TAXONOMY_ENVELOPE);
export const A_TAXONOMY_HASH = sha256Hex(A_TAXONOMY_CANON_PREIMAGE);

/** The author's verbatim governance-envelope preimage — pinned so the derived form can't drift from it. */
export const A_TAXONOMY_CANON_PREIMAGE_EXPECTED =
  '{"codes":{"A01":{"critical":true,"name":"QUANTITY_INTENT_MISMATCH","weight":25},"A02":{"critical":false,"name":"SCOPE_BOUNDARY_VIOLATION","weight":15},"A03":{"critical":false,"name":"ENVIRONMENT_CLASS_MISMATCH","weight":10},"A04":{"critical":true,"name":"RECIPIENT_UNVERIFIED","weight":25},"A05":{"critical":false,"name":"AUTHORITY_SOURCE_UNVERIFIED","weight":15},"A06":{"critical":false,"name":"STATE_ASSUMPTION_STALE","weight":10}},"fail_threshold":25,"namespace":"DJZS-A","sum":100,"version":"0.1-DRAFT"}';

export const A_TAXONOMY_CANON_PREIMAGE_MATCHES =
  A_TAXONOMY_CANON_PREIMAGE === A_TAXONOMY_CANON_PREIMAGE_EXPECTED;

/** Author-supplied draft hash to reconcile against (chat-side authorship). */
export const A_TAXONOMY_HASH_EXPECTED_DRAFT =
  "0x8b649cea6e9ea9213f3f8e58388ed9a014af51aadaaff1f139bf39aed0d41d0c";

export const A_TAXONOMY_HASH_MATCHES_DRAFT =
  A_TAXONOMY_HASH === A_TAXONOMY_HASH_EXPECTED_DRAFT;
