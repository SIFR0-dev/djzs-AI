/**
 * engine-adapter.ts — the EngineAdapter implementation for the plain-HTTP x402
 * route (`http-x402-bazaar.v2.ts`, mounted at POST /x402/verify_pm_trade).
 *
 * ONE SCOPE TRUTH, TWO TRANSPORTS. `scopeCheck` does not re-implement the PM-only
 * rule — it CALLS `runVerifyPmTrade`, the same pipeline function the MCP transport
 * (`/mcp` verify_pm_trade) and `/x402/verify` call, and reads its `in_scope` field.
 * The scope decision therefore cannot drift between transports: there is exactly one
 * copy of the `audit_context !== "prediction_market"` rule in the codebase, inside
 * verify-pm-trade.ts, and every transport reaches it through this same call. (The
 * PASS/PROCEED vocabulary bug of 2026-08-05 is what a second copy costs.)
 *
 * ONE EXTRACTION PER REQUEST. The route's invariant order is scopeCheck (before
 * settlement) then audit (after settlement). Running the N=3 consensus extraction
 * twice would (a) double the model spend and (b) let the scope answer disagree with
 * the audited answer — the gate could open on one extraction and charge for another.
 * So the pipeline runs ONCE per distinct intent and both methods read the same
 * memoised result. The memo lives on the adapter INSTANCE, which the router builds
 * per request: no module-scope state, no cross-request bleed.
 *
 * The engine itself is untouched and still pure: same struct -> same verdict_hash.
 */
import { runVerifyPmTrade, type VerifyPmTradeResult } from "./verify-pm-trade"
import { createDetector, runDetected, type DetectorEnv, type DetectorHandle, type DetectorOptions } from "./detector"
import type { ModelFn } from "../../server/engine-v2/extraction-layer"
import { sha256Hex } from "../../server/engine-v2/hash"
import type { EngineAdapter, ScopeResult, VerdictResult } from "./http-x402-bazaar.v2"
import type { VerdictTally } from "../../server/engine-v2/verdict-rule"

/** Structural check on the engine's tally, so a malformed one is dropped rather than attested. */
function isTally(t: unknown): t is VerdictTally {
  if (typeof t !== "object" || t === null) return false
  const o = t as Record<string, unknown>
  return typeof o.ruleset === "string" && Array.isArray(o.codes) && o.codes.every((c) => typeof c === "string")
    && Number.isInteger(o.unknown_count) && typeof o.bounded === "boolean" && typeof o.thesis_present === "boolean"
}

/** The bindings this adapter reads, request-scoped, never module-scope: the detector switch's (detector.ts). */
export type EngineAdapterEnv = DetectorEnv

/** Shape of an engine flag as the deterministic engine returns it. */
interface EngineFlagLike {
  code?: unknown
}

/**
 * Deterministic text rendering of the wire intent object.
 *
 * The route's declared input is an OBJECT (market/side/thesis/…); the extraction
 * layer audits FREE TEXT. This is the only bridge between them, and it must be a
 * pure function of the object: keys sorted, scalars verbatim, everything else as
 * JSON. Two callers posting the same object therefore audit the same string and
 * commit to the same intent_sha256.
 */
export function renderIntentText(intent: unknown): string {
  if (typeof intent === "string") return intent
  if (!intent || typeof intent !== "object") return String(intent)
  const obj = intent as Record<string, unknown>
  return Object.keys(obj)
    .sort()
    .map((k) => {
      const v = obj[k]
      const rendered =
        typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)
      return `${k}: ${rendered}`
    })
    .join("\n")
}

/**
 * The binding key for this request.
 *
 * Hashed over the RENDERED TEXT — the exact string handed to the engine — which is
 * also what `pol-certificate.ts` hashes (`sha256Hex(intent)`). Hashing the object
 * instead would give a cert whose intent_sha256 disagreed with this response's.
 */
export function intentSha256(intent: unknown): string {
  return sha256Hex(renderIntentText(intent))
}

/** `flags` on the wire is a string list: taxonomy codes, then unknown fields. */
function flagStrings(result: VerifyPmTradeResult): string[] {
  const flags = Array.isArray(result.flags) ? (result.flags as EngineFlagLike[]) : []
  const codes = flags
    .map((f) => (f && typeof f === "object" ? f.code : f))
    .filter((c): c is string => typeof c === "string")
  const unknowns = Array.isArray(result.unknown_fields) ? (result.unknown_fields as unknown[]) : []
  const unknownCodes = unknowns.filter((u): u is string => typeof u === "string").map((u) => `unknown:${u}`)
  return [...codes, ...unknownCodes]
}

/**
 * Build a request-scoped adapter. `env` supplies the extraction key; absent, the
 * adapter refuses in `scopeCheck` — i.e. BEFORE the route reaches settlePayment,
 * so a misconfigured deployment cannot charge anyone.
 *
 * `modelFn` is the offline seam (same convention as pol-certificate's UploadFn and
 * verify-pm-trade's ModelFn): pass a stub to exercise this adapter with no key and
 * no network. Production never passes it.
 */
export function createEngineAdapter(
  env: EngineAdapterEnv,
  modelFn?: ModelFn,
  /** Which pipeline audits the intent. Default: the PM pipeline (unchanged behavior). */
  runner: (text: string, model: ModelFn) => Promise<VerifyPmTradeResult> = runVerifyPmTrade,
  /** Offline seam for the attested path (stub gateway). Production never passes it. */
  detectorOpts: DetectorOptions = {},
): EngineAdapter {
  /** intent_sha256 -> in-flight/settled pipeline run. One entry per request in practice. */
  const runs = new Map<string, Promise<VerifyPmTradeResult>>()

  const run = (intent: unknown): Promise<VerifyPmTradeResult> => {
    const key = intentSha256(intent)
    const existing = runs.get(key)
    if (existing) return existing
    const text = renderIntentText(intent)
    let p: Promise<VerifyPmTradeResult>
    if (modelFn) {
      p = runner(text, modelFn)
    } else {
      // The detector switch (DJZS_DETECTOR): Anthropic, or the attested Phala lane. A missing key, a
      // failed report binding or an unverified receipt all reject HERE, from scopeCheck - before
      // settlePayment - so every detector failure is an uncharged refusal.
      let handle: DetectorHandle
      try {
        handle = createDetector(env, detectorOpts)
      } catch (e) {
        // Fail CLOSED and fail EARLY: thrown from scopeCheck this is an uncharged refusal.
        return Promise.reject(e)
      }
      const h = handle
      p = runDetected(() => runner(text, h.modelFn), h, text)
    }
    runs.set(key, p)
    return p
  }

  return {
    async scopeCheck(intent: unknown): Promise<ScopeResult> {
      const result = await run(intent)
      if (result.in_scope === true) return { inScope: true }
      return {
        inScope: false,
        reason: typeof result.reason === "string" ? result.reason : "out_of_scope",
      }
    },

    async audit(intent: unknown): Promise<VerdictResult> {
      const result = await run(intent)
      // INTRINSIC PRECONDITION, not an implicit one. The route only calls audit()
      // after an in-scope scopeCheck, but a future caller reordering that would
      // otherwise mint a verdict — and, downstream, a permanent certificate — for
      // an intent the scope gate refused. Enforce it here, where it cannot be skipped.
      if (result.in_scope !== true) {
        throw new Error("OUT_OF_SCOPE: audit() called on an intent the scope gate refused")
      }
      const verdict = result.verdict
      if (verdict !== "PASS" && verdict !== "WAIT" && verdict !== "FAIL") {
        throw new Error(`ENGINE_CONTRACT_VIOLATION: unexpected verdict ${JSON.stringify(verdict)}`)
      }
      return {
        verdict,
        risk_score: typeof result.risk_score === "number" ? result.risk_score : 0,
        flags: flagStrings(result),
        verdict_hash: typeof result.verdict_hash === "string" ? result.verdict_hash : "",
        intent_sha256: intentSha256(intent),
        // DJZS-VR-v1.0: what the verdict was derived from, for the v3 attestation and its resolver.
        ...(isTally((result as { tally?: unknown }).tally) ? { tally: (result as { tally: VerdictTally }).tally } : {}),
        // DJZS-AD-v0.1: the attested lane's receipts and binding ride the wire untouched; absent on the Anthropic path.
        ...(result.attested_detection !== undefined ? { attested_detection: result.attested_detection } : {}),
      }
    },
  }
}
