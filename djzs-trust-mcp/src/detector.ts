/**
 * detector.ts - the detector switch (fill34, DJZS-AD-v0.1 wire-in)
 *
 * ONE place decides which detector (LLM) every transport runs, from the request-time
 * env binding: the MCP paid tools, the plain-HTTP x402 routes (through engine-adapter),
 * the legacy /x402/verify route and the free /try route all call createDetector(env).
 *
 *   DJZS_DETECTOR unset / "anthropic"  -> the Anthropic detector, exactly as before
 *   DJZS_DETECTOR = "phala"            -> the attested detector: every call goes through
 *                                         Phala's ACI gateway and returns a verified receipt
 *                                         (attested-detector.ts). PHALA_API_KEY is the SECRET;
 *                                         PHALA_MODEL / PHALA_ACI_BASE are plain vars.
 *
 * FAIL CLOSED, NEVER FALL BACK: "phala" without PHALA_API_KEY is a refusal
 * (detector_not_configured), never a silent Anthropic verdict sold as attested. A sample
 * whose receipt does not verify rejects the whole N=3 extraction (UnverifiedDetectionError)
 * before any verdict exists - on every transport that is the uncharged path (the MCP
 * middleware settles only non-error results; the HTTP route runs the pipeline in
 * scopeCheck, before settlePayment).
 *
 * THE VERDICT IS UNTOUCHED. The pipelines (verify-pm-trade.ts / verify-perp-trade.ts) and
 * the engine are not modified: finishDetection() attaches `attested_detection` to the
 * pipeline's result AFTER it exists. verdict_hash stays byte-identical to the Anthropic
 * path for the same extracted struct (deploy parity gate, anchored reproductions). The
 * binding of the verdict to the detector outputs is a SEPARATE hash:
 *
 *   binding.hash = sha256(JCS({ v: "DJZS-AD-B1", verdict_hash, intent_sha256,
 *                               detector_output_sha256: [per sample, call order],
 *                               receipt_ids: [per sample] }))
 *
 * DJZS-side hashes (verdict_hash, intent_sha256, binding.hash) keep the repo's 0x-prefixed
 * sha256Hex (shared/hash.ts), so intent_sha256 here is byte-for-byte the routes' and the
 * certificates' binding key; ACI-side hashes (detector_output_sha256, request/response)
 * keep the gateway's bare / `sha256:` forms.
 *
 * A verifier holding the three raw detector outputs recomputes their sha256s, replays the
 * deterministic merge + engine to the verdict_hash, and checks the binding; the receipts
 * (archived in the block with the keyset) prove those outputs came out of the attested
 * gateway for exactly the request bytes that carried the prompt.
 */
import type { ModelFn } from "../../server/engine-v2/extraction-layer"
import { sha256Hex as djzsSha256Hex } from "../../server/engine-v2/hash"
import { buildAnthropicModelFn } from "./verify-pm-trade"
import {
  ATTESTED_DETECTOR_VERSION,
  PHALA_ACI_BASE,
  PHALA_DEFAULT_MODEL,
  buildPhalaDetector,
  jcsBytes,
  UnverifiedDetectionError,
  WorkloadNotEstablishedError,
  type AttestedDetection,
  type FetchLike,
  type ReceiptDocument,
  type WorkloadKeyset,
} from "./attested-detector"
import type { Fault } from "./safe-error"

export type DetectorKind = "anthropic" | "phala"

/** The bindings this switch reads. Request-scoped, never module-scope. */
export interface DetectorEnv {
  ANTHROPIC_API_KEY?: string
  /** SECRET. The Phala Confidential AI key; receipts for a request are readable only with the key that made it. */
  PHALA_API_KEY?: string
  /** Plain var: "phala" selects the attested detector; anything else / unset is the Anthropic detector. */
  DJZS_DETECTOR?: string
  /** Plain var: TEE model id (default PHALA_DEFAULT_MODEL). A Q2 A/B result, not a guess. */
  PHALA_MODEL?: string
  /** Plain var: gateway base (default PHALA_ACI_BASE). Rehearsals only. */
  PHALA_ACI_BASE?: string
}

export interface DetectorHandle {
  kind: DetectorKind
  /** The model id the detector is asked for ("claude-sonnet-4-6" today on the Anthropic path). */
  model: string
  modelFn: ModelFn
  /** Attested path only: one AttestedDetection per call, in completion order. Empty on the Anthropic path. */
  sink: AttestedDetection[]
}

/** Offline seams (tests): never passed in production. */
export interface DetectorOptions {
  fetchImpl?: FetchLike
  now?: number
}

export class DetectorUnavailableError extends Error {
  constructor(public readonly detail: Fault, message: string) {
    super(message)
    this.name = "DetectorUnavailableError"
  }
}

export const ANTHROPIC_DETECTOR_MODEL = "claude-sonnet-4-6" as const

/**
 * Which detector this request runs. Throws DetectorUnavailableError (detail
 * `detector_not_configured`) when the selected detector has no key: the caller answers
 * with that fixed code, uncharged. The selection is the operator's (a Worker var), never
 * the caller's.
 */
export function createDetector(env: DetectorEnv, opts: DetectorOptions = {}): DetectorHandle {
  const kind: DetectorKind = env.DJZS_DETECTOR === "phala" ? "phala" : "anthropic"
  if (kind === "phala") {
    if (!env.PHALA_API_KEY) {
      throw new DetectorUnavailableError("detector_not_configured", "EXTRACTION_UNAVAILABLE: DJZS_DETECTOR=phala but PHALA_API_KEY not configured")
    }
    const sink: AttestedDetection[] = []
    const model = env.PHALA_MODEL && env.PHALA_MODEL.trim() !== "" ? env.PHALA_MODEL.trim() : PHALA_DEFAULT_MODEL
    const modelFn = buildPhalaDetector({
      apiKey: env.PHALA_API_KEY,
      model,
      base: env.PHALA_ACI_BASE && env.PHALA_ACI_BASE.trim() !== "" ? env.PHALA_ACI_BASE.trim() : PHALA_ACI_BASE,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      sink,
      onUnverified: "throw",
    })
    return { kind, model, modelFn, sink }
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new DetectorUnavailableError("detector_not_configured", "EXTRACTION_UNAVAILABLE: ANTHROPIC_API_KEY not configured")
  }
  return { kind, model: ANTHROPIC_DETECTOR_MODEL, modelFn: buildAnthropicModelFn(env.ANTHROPIC_API_KEY), sink: [] }
}

/** The fixed code for a detector failure, or undefined when the error is not the detector's. */
export function detectorFault(e: unknown): Fault | undefined {
  if (e instanceof DetectorUnavailableError) return e.detail
  if (e instanceof UnverifiedDetectionError || e instanceof WorkloadNotEstablishedError) return "detector_unverified"
  return undefined
}

export const ATTESTED_BINDING_VERSION = "DJZS-AD-B1" as const

export interface AttestedSample {
  receipt_id: string
  chat_id: string | null
  served_at: number | null
  request_sha256: string
  response_sha256: string
  detector_output_sha256: string
  session_id: string | null
  model_served: string | null
  verified: boolean
  /** The signed receipt, archived: re-verifies offline under `keyset` without the gateway. */
  receipt: ReceiptDocument
}

/** What a paid verdict carries on the attested path. Absent on the Anthropic path and on refusals. */
export interface AttestedDetectionBlock {
  scheme: typeof ATTESTED_DETECTOR_VERSION
  provider: "phala-aci"
  gateway: string
  model: string
  workload_keyset_digest: string
  receipt_key_id: string
  repo_url: string | null
  repo_commit: string | null
  report_sha256: string
  /** The attested keyset the receipts bind to (its JCS sha256 is workload_keyset_digest). */
  keyset: WorkloadKeyset
  samples: AttestedSample[]
  binding: {
    version: typeof ATTESTED_BINDING_VERSION
    verdict_hash: string
    /** sha256 of the rendered intent text the engine audited - the same quantity the routes and certificates bind. */
    intent_sha256: string
    detector_output_sha256: string[]
    receipt_ids: string[]
    /** 0x-prefixed sha256 (shared/hash.ts) of the JCS form of {v, verdict_hash, intent_sha256, detector_output_sha256, receipt_ids}. */
    hash: string
  }
}

/** The binding hash, as a verifier recomputes it. Exported so tests and verifiers share one definition. */
export function attestedBindingHash(preimage: { verdict_hash: string; intent_sha256: string; detector_output_sha256: string[]; receipt_ids: string[] }): string {
  return djzsSha256Hex(new TextDecoder().decode(jcsBytes({ v: ATTESTED_BINDING_VERSION, ...preimage })))
}

/**
 * Attach `attested_detection` to a pipeline result. Anthropic path, refusals
 * (in_scope !== true) and a result without a verdict_hash pass through untouched. Every
 * sample in the sink is verified by construction (the detector throws otherwise); the
 * block records that fact per sample rather than assuming it.
 */
export async function finishDetection<R extends Record<string, unknown>>(result: R, handle: DetectorHandle, intentText: string): Promise<R> {
  if (handle.kind !== "phala") return result
  if (result.in_scope !== true || typeof result.verdict_hash !== "string" || handle.sink.length === 0) return result
  const samples: AttestedSample[] = handle.sink.map((d) => ({
    receipt_id: d.receipt_id,
    chat_id: d.chat_id,
    served_at: d.served_at,
    request_sha256: d.request_sha256,
    response_sha256: d.response_sha256,
    detector_output_sha256: d.detector_output_sha256,
    session_id: d.upstream?.session_id ?? null,
    model_served: d.model_served,
    verified: d.verified,
    receipt: d.receipt,
  }))
  const first = handle.sink[0]
  const preimage = {
    verdict_hash: result.verdict_hash,
    intent_sha256: djzsSha256Hex(intentText),
    detector_output_sha256: samples.map((s) => s.detector_output_sha256),
    receipt_ids: samples.map((s) => s.receipt_id),
  }
  const block: AttestedDetectionBlock = {
    scheme: ATTESTED_DETECTOR_VERSION,
    provider: "phala-aci",
    gateway: first.gateway,
    model: first.model,
    workload_keyset_digest: first.workload_keyset_digest,
    receipt_key_id: first.receipt_key_id,
    repo_url: first.repo_url,
    repo_commit: first.repo_commit,
    report_sha256: first.report_sha256,
    keyset: first.keyset,
    samples,
    binding: { version: ATTESTED_BINDING_VERSION, ...preimage, hash: attestedBindingHash(preimage) },
  }
  return { ...result, attested_detection: block }
}

/**
 * Run a pipeline under a detector and attach the block. The pipeline call is the caller's
 * (PM or perp, with or without a bracket); this only sequences run -> finish.
 */
export async function runDetected<R extends Record<string, unknown>>(run: () => Promise<R>, handle: DetectorHandle, intentText: string): Promise<R> {
  return finishDetection(await run(), handle, intentText)
}
