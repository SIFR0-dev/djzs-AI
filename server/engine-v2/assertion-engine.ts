/**
 * DJZS-A engine-v2 — Assertion Verification core (Step 1: types + comparators + ladder)
 * ─────────────────────────────────────────────────────────────────────────────────────
 * Pure function: (ClaimRecord, TruthRecord, AConfig) → verdict. ZERO model
 * dependence, ZERO randomness, ZERO I/O — no adapter is called here; adapters
 * (calldata/sim/registry/state/provenance) produce the TruthRecord upstream and
 * are a SEPARATE build step. This module is the diff layer + ladder only, so it
 * is mergeable before any adapter exists.
 *
 * Doctrine, in code:
 *   - Comparators are TOTAL functions over FieldStates: every field is present /
 *     absent / unknown, and every comparator returns fire / clear / unknown.
 *   - unknown input -> the code does NOT fire; it lands in unknown_fields -> WAIT.
 *     An adapter never guesses; the engine never substitutes a default.
 *   - Thresholds (amount tolerance, price slippage) are PINNED CONFIG passed in;
 *     the comparators are canon. Policy is the buyer's; arithmetic is ours.
 *   - The ladder is byte-for-byte the verified DJZS-M shape
 *     (see server/engine-v2/deterministic-engine.ts runPredictionAudit):
 *       critical-or-threshold -> FAIL; zero flags && grounded -> PASS;
 *       unknown_fields > 0 -> WAIT; else PASS (residual advisory).
 *   - verdict_hash preimage excludes SourceRef (fetched_at / block ref are
 *     provenance, not verdict-bearing) so the hash reproduces across runs.
 *
 * DRAFT-UNVERIFIED: scores against shared/a-taxonomy.draft.ts (provisional, not
 * canon). Comparator business-semantics are defensible defaults for the machinery;
 * real incident-record calibration is a later, separate merge.
 */
import { canonicalize, sha256Hex } from "./hash";
import {
  A_TAXONOMY,
  A_FAIL_THRESHOLD,
  type ACode,
} from "../../shared/a-taxonomy.draft";

// ─── FieldState (provenance-stamped; the spec's core type) ──────────────────
export type UnknownReason = "unfetchable" | "timeout" | "conflict" | "unsupported_env";

export interface SourceRef {
  adapter: string; // "calldata" | "sim" | "registry" | "state" | "provenance" | "extraction"
  fetched_at: string; // ISO time of the read
  ref: string; // block number, tx hash, URL hash, etc.
}

export type FieldState<T> =
  | { state: "present"; value: T; source: SourceRef }
  | { state: "absent" }
  | { state: "unknown"; reason: UnknownReason };

// ─── Claim / Truth record shapes (exactly the fields the 6 comparators read) ─
export interface EnvClass {
  chainId: number;
  class: string; // e.g. "evm-mainnet" | "evm-l2" | "testnet"
}
export type Authority = "user" | "agent" | "external";
export type Approval = "bounded" | "unbounded";
export type Binding = "binding" | "no_binding";
export type Provenance = "principal" | "external";
export interface AssumedState {
  price?: number;
  balance?: number;
  allowance?: number;
  nonce?: number;
}

/** The assertion, structured (extraction output). */
export interface ClaimRecord {
  amount: FieldState<number>; // A01
  scope: FieldState<string[]>; // A02 — assets the agent claims it will touch
  env: FieldState<EnvClass>; // A03
  authority: FieldState<Authority>; // A05 — who the claim says authorized it
  assumed_state: FieldState<AssumedState>; // A06 — state the claim assumes
}

/** Ground state, structured, provenance-stamped (adapter output). */
export interface TruthRecord {
  amount: FieldState<number>; // A01
  approval: FieldState<Approval>; // A01 — bounded | unbounded
  touched: FieldState<string[]>; // A02 — full touched set
  env: FieldState<EnvClass>; // A03
  binding: FieldState<Binding>; // A04 — registry result
  provenance: FieldState<Provenance>; // A05 — principal | external
  fresh_state: FieldState<AssumedState>; // A06 — fresh reads
}

/** Pinned config: buyer policy, not canon. */
export interface AConfig {
  /** A01: absolute amount tolerance (same unit as amount). */
  amount_tolerance: number;
  /** A06: allowed price drift, basis points. */
  price_slippage_bps: number;
}

export type AVerdict = "PASS" | "WAIT" | "FAIL";

export interface AEngineFlag {
  code: ACode;
  name: string;
  weight: number;
  critical: boolean;
  evidence: string;
}

export interface AEngineResult {
  verdict: AVerdict;
  risk_score: number;
  flags: AEngineFlag[];
  unknown_fields: ACode[];
  verdict_hash: string;
  engine: "djzs-engine-v2/assertion";
}

type Outcome =
  | { kind: "fire"; evidence: string }
  | { kind: "clear" }
  | { kind: "unknown"; reason: UnknownReason };

const CLEAR: Outcome = { kind: "clear" };
const fire = (evidence: string): Outcome => ({ kind: "fire", evidence });
const unknown = (reason: UnknownReason): Outcome => ({ kind: "unknown", reason });

/** First unknown reason among the fields a comparator needs, or null if all resolvable. */
function firstUnknown(...fields: FieldState<unknown>[]): UnknownReason | null {
  for (const f of fields) if (f.state === "unknown") return f.reason;
  return null;
}

// ─── Comparators A01–A06 (total functions over FieldStates) ─────────────────

/** A01 QUANTITY_INTENT_MISMATCH: intent amount vs truth amount / approval bound. */
function cmpA01(claim: ClaimRecord, truth: TruthRecord, cfg: AConfig): Outcome {
  // Unbounded approval against a finite stated amount is a fire on its own — a
  // decode fact, not an opinion. Evaluate it before the amount diff.
  if (
    truth.approval.state === "present" &&
    truth.approval.value === "unbounded" &&
    claim.amount.state === "present" &&
    Number.isFinite(claim.amount.value)
  ) {
    return fire(`unbounded approval granted against a finite stated amount (${claim.amount.value})`);
  }
  // Amount diff requires both amounts known.
  if (claim.amount.state === "present" && truth.amount.state === "present") {
    const diff = Math.abs(claim.amount.value - truth.amount.value);
    return diff > cfg.amount_tolerance
      ? fire(`stated ${claim.amount.value} vs truth ${truth.amount.value} exceeds tolerance ${cfg.amount_tolerance}`)
      : CLEAR;
  }
  // Intent silent but truth moves value.
  if (claim.amount.state === "absent" && truth.amount.state === "present" && truth.amount.value > cfg.amount_tolerance) {
    return fire(`no amount stated but truth moves ${truth.amount.value}`);
  }
  const u = firstUnknown(claim.amount, truth.amount, truth.approval);
  return u ? unknown(u) : CLEAR;
}

/** A02 SCOPE_BOUNDARY_VIOLATION: truth.touched ⊄ claim.scope. */
function cmpA02(claim: ClaimRecord, truth: TruthRecord): Outcome {
  const u = firstUnknown(claim.scope, truth.touched);
  if (u) return unknown(u);
  if (claim.scope.state === "present" && truth.touched.state === "present") {
    const scope = new Set(claim.scope.value);
    const outside = truth.touched.value.filter((a) => !scope.has(a));
    return outside.length > 0 ? fire(`touched assets outside claimed scope: [${outside.join(", ")}]`) : CLEAR;
  }
  // A missing scope with a known touched set cannot be bounded -> unknown, not a silent pass.
  if (truth.touched.state === "present" && truth.touched.value.length > 0 && claim.scope.state === "absent") {
    return unknown("unfetchable");
  }
  return CLEAR;
}

/** A03 ENVIRONMENT_CLASS_MISMATCH: chain id / class differ. */
function cmpA03(claim: ClaimRecord, truth: TruthRecord): Outcome {
  const u = firstUnknown(claim.env, truth.env);
  if (u) return unknown(u);
  if (claim.env.state === "present" && truth.env.state === "present") {
    const c = claim.env.value;
    const t = truth.env.value;
    return c.chainId !== t.chainId || c.class !== t.class
      ? fire(`claim env ${c.chainId}/${c.class} != truth env ${t.chainId}/${t.class}`)
      : CLEAR;
  }
  return CLEAR;
}

/** A04 RECIPIENT_UNVERIFIED: registry binding == no_binding. */
function cmpA04(truth: TruthRecord): Outcome {
  if (truth.binding.state === "unknown") return unknown(truth.binding.reason);
  if (truth.binding.state === "present" && truth.binding.value === "no_binding") {
    return fire("recipient could not be bound to the named counterparty by any checkable source");
  }
  return CLEAR;
}

/** A05 AUTHORITY_SOURCE_UNVERIFIED: provenance external while claim asserts user authority. */
function cmpA05(claim: ClaimRecord, truth: TruthRecord): Outcome {
  // Honest default: a framework that cannot say where the instruction came from
  // yields unknown -> WAIT (never a PASS stamped over silence).
  const u = firstUnknown(truth.provenance, claim.authority);
  if (u) return unknown(u);
  if (
    truth.provenance.state === "present" &&
    truth.provenance.value === "external" &&
    claim.authority.state === "present" &&
    claim.authority.value === "user"
  ) {
    return fire("instruction origin is external but the claim asserts user authority");
  }
  return CLEAR;
}

/** A06 STATE_ASSUMPTION_STALE: any assumed field outside the staleness/slippage window. */
function cmpA06(claim: ClaimRecord, truth: TruthRecord, cfg: AConfig): Outcome {
  const u = firstUnknown(claim.assumed_state, truth.fresh_state);
  if (u) return unknown(u);
  if (claim.assumed_state.state === "present" && truth.fresh_state.state === "present") {
    const a = claim.assumed_state.value;
    const f = truth.fresh_state.value;
    const drift: string[] = [];
    if (a.price !== undefined && f.price !== undefined) {
      const bps = f.price === 0 ? Infinity : (Math.abs(a.price - f.price) / f.price) * 10000;
      if (bps > cfg.price_slippage_bps) drift.push(`price ${a.price}->${f.price} (${bps.toFixed(0)}bps > ${cfg.price_slippage_bps})`);
    }
    for (const k of ["balance", "allowance", "nonce"] as const) {
      if (a[k] !== undefined && f[k] !== undefined && a[k] !== f[k]) drift.push(`${k} ${a[k]}->${f[k]}`);
    }
    return drift.length > 0 ? fire(`assumed state stale: ${drift.join("; ")}`) : CLEAR;
  }
  return CLEAR;
}

const COMPARATORS: Array<{ code: ACode; run: (c: ClaimRecord, t: TruthRecord, cfg: AConfig) => Outcome }> = [
  { code: "A01", run: (c, t, cfg) => cmpA01(c, t, cfg) },
  { code: "A02", run: (c, t) => cmpA02(c, t) },
  { code: "A03", run: (c, t) => cmpA03(c, t) },
  { code: "A04", run: (_c, t) => cmpA04(t) },
  { code: "A05", run: (c, t) => cmpA05(c, t) },
  { code: "A06", run: (c, t, cfg) => cmpA06(c, t, cfg) },
];

/** The single, pure entry point. */
export function runAssertionAudit(claim: ClaimRecord, truth: TruthRecord, cfg: AConfig): AEngineResult {
  const flags: AEngineFlag[] = [];
  const unknown_fields: ACode[] = [];

  for (const { code, run } of COMPARATORS) {
    const o = run(claim, truth, cfg);
    if (o.kind === "fire") {
      const def = A_TAXONOMY[code];
      flags.push({ code, name: def.name, weight: def.weight, critical: def.critical, evidence: o.evidence });
    } else if (o.kind === "unknown") {
      unknown_fields.push(code);
    }
  }
  unknown_fields.sort();

  const risk_score = flags.reduce((s, f) => s + f.weight, 0);
  const hasCritical = flags.some((f) => f.critical);
  // "grounded" = every comparator input resolved (no unknowns). The A analog of
  // isBounded in the M ladder.
  const isGrounded = unknown_fields.length === 0;

  let verdict: AVerdict;
  if (hasCritical || risk_score >= A_FAIL_THRESHOLD) {
    verdict = "FAIL";
  } else if (flags.length === 0 && isGrounded) {
    verdict = "PASS";
  } else if (unknown_fields.length > 0) {
    verdict = "WAIT";
  } else {
    verdict = "PASS"; // residual: sub-threshold non-critical advisory rides a PASS
  }

  // Preimage EXCLUDES SourceRef — verdict-bearing content only, so the hash is
  // stable across runs (no fetched_at, no block ref). Same shape as engine-v2.
  const verdict_hash = sha256Hex(
    canonicalize({
      verdict,
      risk_score,
      flags: flags.map((f) => f.code).sort(),
      unknown_fields,
    }),
  );

  return { verdict, risk_score, flags, unknown_fields, verdict_hash, engine: "djzs-engine-v2/assertion" };
}
