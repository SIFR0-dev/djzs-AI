/**
 * DJZS-M — Prediction-Market Taxonomy (parallel to DJZS-LF)
 * ─────────────────────────────────────────────────────────
 * Additive, self-contained taxonomy for prediction-market audits. This file
 * mirrors the structure of shared/audit-schema.ts (LFDefinition / taxonomy /
 * weights+taxonomy hashes / max-score integrity assertion) but is a SEPARATE
 * frozen table with its own version (DJZS-PM-v1.0), its own weight budget
 * (100, not 200), and its own hashes. The perp taxonomy in audit-schema.ts is
 * untouched — these two never share a code namespace or a hash.
 *
 * The sha256/canonicalize primitives are reused from engine-v2's dependency-free
 * hash module so PM hashes are computed by the identical algorithm as everything
 * else in the system.
 */
import { canonicalize, sha256Hex } from "@shared/hash";

export type PMCode = "DJZS-M01" | "DJZS-M02" | "DJZS-M03" | "DJZS-M04";

export type PMCategory = "Prediction";
export type PMSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface PMDefinition {
  code: PMCode;
  name: string;
  category: PMCategory;
  weight: number;
  severity: PMSeverity;
  description: string;
}

export const PM_TAXONOMY: Record<PMCode, PMDefinition> = {
  "DJZS-M01": {
    code: "DJZS-M01",
    name: "NARRATIVE_RESOLUTION_GAP",
    category: "Prediction",
    weight: 30,
    severity: "CRITICAL",
    description: "Thesis reasons about a narrative adjacent to the actual resolution question.",
  },
  "DJZS-M02": {
    code: "DJZS-M02",
    name: "FALSIFICATION_ABSENT",
    category: "Prediction",
    weight: 30,
    severity: "CRITICAL",
    description: "No stated condition that would prove the thesis wrong before resolution.",
  },
  "DJZS-M03": {
    code: "DJZS-M03",
    name: "PROBABILITY_UNSOURCED",
    category: "Prediction",
    weight: 25,
    severity: "HIGH",
    description: "Market or model probability asserted without verifiable basis.",
  },
  "DJZS-M04": {
    code: "DJZS-M04",
    name: "CONSENSUS_NO_EDGE",
    category: "Prediction",
    weight: 15,
    severity: "MEDIUM",
    description: "Thesis restates consensus at an extreme price with no differentiated edge.",
  },
} as const;

export const PM_MAX_RISK_SCORE = Object.values(PM_TAXONOMY)
  .reduce((sum, def) => sum + def.weight, 0); // = 100 — DO NOT CHANGE without governance

export const ALL_PM_CODES = Object.keys(PM_TAXONOMY) as PMCode[];

export const PM_LF_VERSION = "1.0" as const;
export const PM_SCHEMA_VERSION = `DJZS-PM-v${PM_LF_VERSION}` as const;

export const PM_FAIL_THRESHOLD = 25;

if (PM_MAX_RISK_SCORE !== 100) {
  throw new Error(
    `[DJZS-M FATAL] PM taxonomy weights sum to ${PM_MAX_RISK_SCORE}, expected 100. ` +
    `Weight table integrity compromised.`
  );
}

export const PM_WEIGHTS_HASH: string = sha256Hex(
  canonicalize({
    taxonomy_version: PM_LF_VERSION,
    weights: Object.fromEntries(
      Object.entries(PM_TAXONOMY).map(([k, v]) => [k, v.weight])
    ),
  })
);

export const PM_TAXONOMY_HASH: string = sha256Hex(
  canonicalize({
    taxonomy_version: PM_LF_VERSION,
    taxonomy: PM_TAXONOMY,
  })
);
