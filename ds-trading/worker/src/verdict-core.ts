// DJZS-M verdict core — pure and deterministic. LLM detects (elsewhere),
// THIS decides. Same struct -> same verdict + same hash, always. No LLM, no
// network, no clock, no randomness inside this module.

export const DJZS_M_TAXONOMY = "DJZS-M v1";

// Frozen weights (PM_WEIGHTS_HASH lineage): sum 100, FAIL threshold 25.
export const DJZS_M_WEIGHTS = {
  M01: { weight: 30, severity: "CRITICAL" }, // NARRATIVE_RESOLUTION_GAP
  M02: { weight: 30, severity: "CRITICAL" }, // FALSIFICATION_ABSENT
  M03: { weight: 25, severity: "HIGH" },     // PROBABILITY_UNSOURCED
  M04: { weight: 15, severity: "MEDIUM" },   // CONSENSUS_NO_EDGE — ADVISORY
} as const;

export const FAIL_THRESHOLD = 25;

export type FlagCode = keyof typeof DJZS_M_WEIGHTS;
export type Verdict = "PASS" | "WAIT" | "FAIL";
export type Action = "PROCEED" | "HALT";

export interface AuditInput {
  subject: string;
  thesis: string;
  market_ticker?: string | null;
  side?: "yes" | "no" | null;
  p_claim_e4?: number | null;
  market_price_e4?: number | null;
  fee_est_e4?: number | null;
  flags: FlagCode[];
  unknowns: string[];
}

export interface Decision {
  taxonomy: typeof DJZS_M_TAXONOMY;
  flags: FlagCode[];      // sorted, deduped
  unknowns: string[];     // sorted, deduped
  risk_score: number;
  verdict: Verdict;
  action: Action;         // derived from verdict in exactly one place
  advisory_only: boolean; // true when solo-M04 residual PASS
}

const sortedUnique = <T extends string>(xs: T[]): T[] => [...new Set(xs)].sort();

export function decide(flags: FlagCode[], unknowns: string[]): Decision {
  const f = sortedUnique(flags);
  for (const code of f) {
    if (!(code in DJZS_M_WEIGHTS)) throw new Error(`unknown flag code: ${code}`);
  }
  const u = sortedUnique(unknowns);
  const risk = f.reduce((s, c) => s + DJZS_M_WEIGHTS[c].weight, 0);
  const soloM04 = f.length === 1 && f[0] === "M04";

  let verdict: Verdict;
  if (soloM04) {
    verdict = u.length > 0 ? "WAIT" : "PASS"; // M04 is advisory: solo = residual PASS
  } else if (
    f.some((c) => DJZS_M_WEIGHTS[c].severity === "CRITICAL") ||
    risk >= FAIL_THRESHOLD
  ) {
    verdict = "FAIL";
  } else if (u.length > 0) {
    verdict = "WAIT"; // unknowns block; abstention is the accepted cost
  } else {
    verdict = "PASS";
  }

  // Two vocabularies, ONE derivation point (the entry-002 lesson).
  const action: Action = verdict === "PASS" ? "PROCEED" : "HALT";
  return {
    taxonomy: DJZS_M_TAXONOMY,
    flags: f,
    unknowns: u,
    risk_score: risk,
    verdict,
    action,
    advisory_only: soloM04,
  };
}

/** Canonical serialization: sorted keys, no whitespace, null for absent. */
export function canonicalVerdictPreimage(input: AuditInput, d: Decision): string {
  const struct = {
    fee_est_e4: input.fee_est_e4 ?? null,
    flags: d.flags,
    market_price_e4: input.market_price_e4 ?? null,
    market_ticker: input.market_ticker ?? null,
    p_claim_e4: input.p_claim_e4 ?? null,
    risk_score: d.risk_score,
    side: input.side ?? null,
    subject: input.subject,
    taxonomy: d.taxonomy,
    thesis: input.thesis,
    unknowns: d.unknowns,
    verdict: d.verdict,
  };
  return JSON.stringify(struct); // key order is fixed by the literal above
}

export async function computeVerdictHash(input: AuditInput, d: Decision): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalVerdictPreimage(input, d));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
