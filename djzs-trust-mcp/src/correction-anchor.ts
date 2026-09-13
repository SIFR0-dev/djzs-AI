/**
 * Correction Record anchoring — ONE implementation, used by the Worker route and
 * by the operator harness.
 *
 * KEY CUSTODY IS THE REASON THIS MODULE EXISTS IN src/ RATHER THAN harness/.
 * IRYS_UPLOAD_KEY is a Worker secret and stays one. An earlier draft of the
 * harness signed locally from an env var, which quietly moved the funded key
 * onto the operator's disk and contradicted the design it was meant to serve.
 * The signing and uploading now happen only inside the Worker; the harness
 * computes the expected bytes, posts the record, and checks what came back.
 *
 * SHARED SO THEY CANNOT DIVERGE. If the harness computed the payload one way
 * and the route another, the operator's sha check would compare two different
 * derivations and pass or fail for the wrong reason — the same two-copies
 * failure that produced the PASS/PROCEED vocabulary bug and the two WAIT
 * counters. `buildCorrectionPayload` is the single derivation: both sides call
 * it, so the check is a real end-to-end comparison.
 *
 * RUNTIME DUALITY: hashing uses WebCrypto (`crypto.subtle.digest`), not
 * node:crypto, because this file is bundled into the Worker. Both runtimes
 * provide it; node:crypto would not survive the bundle.
 *
 * WHAT IS ANCHORED is the record MINUS `anchored_irys_id` and `eas_uid`. Those
 * are only knowable after the upload, so including them would make the anchored
 * bytes disagree with the committed file the instant the anchor succeeded.
 * Excluding them mirrors the PHASE_A_EXCLUDE pattern in tests/q3/lib.ts and
 * makes the anchor verifiable against the committed record forever:
 *
 *     canonical(strip(record, ANCHOR_EXCLUDE))  ==  the bytes at gateway.irys.xyz/<id>
 */
import { EthereumSigner, createData } from "@irys/bundles/web"
import { buildIrysUploadFn, POL_GATEWAY_BASE, POL_UPLOAD_TOKEN, type UploadFn } from "./pol-certificate"

export const CORRECTION_SCHEMA = "DJZS-Correction-1"

/** Filled in only after the upload; excluded so the anchored bytes stay stable. */
export const ANCHOR_EXCLUDE: ReadonlySet<string> = new Set(["anchored_irys_id", "eas_uid"])

/** Canonical JSON: sorted keys, undefined skipped. Mirrors tests/q3/lib.ts `canonical`. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]"
  const o = v as Record<string, unknown>
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}"
}

/** WebCrypto sha256, 0x-prefixed. Works in workerd and in Node 18+. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return "0x" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export function strip(rec: Record<string, unknown>, ex: ReadonlySet<string>): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(rec)) if (!ex.has(k)) o[k] = rec[k]
  return o
}

export interface CorrectionTag { name: string; value: string }
export interface CorrectionPayload {
  payload: Record<string, unknown>
  body: string
  sha256: string
  tags: CorrectionTag[]
}

/**
 * Shape check. Deliberately strict about the two things a correction is for —
 * naming the certificate it corrects, and saying something — because a record
 * missing either is not a correction, it is a permanent blank.
 */
export function validateCorrectionRecord(
  rec: unknown,
): { ok: true; rec: Record<string, unknown> } | { ok: false; error: string } {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, error: "record must be an object" }
  const r = rec as Record<string, unknown>
  if (typeof r.id !== "string" || !r.id) return { ok: false, error: "id required" }
  if (typeof r.scope !== "string" || !r.scope) return { ok: false, error: "scope required" }
  const sup = r.supersedes
  if (!sup || typeof sup !== "object" || Array.isArray(sup)) return { ok: false, error: "supersedes required" }
  const s = sup as Record<string, unknown>
  if (typeof s.audit_id !== "string" || !s.audit_id) return { ok: false, error: "supersedes.audit_id required" }
  if (typeof s.irys_id !== "string" || !s.irys_id) return { ok: false, error: "supersedes.irys_id required" }
  if (!Array.isArray(r.statement) || r.statement.length === 0) return { ok: false, error: "statement must be a non-empty array" }
  if (!r.statement.every((p) => typeof p === "string" && p.length)) return { ok: false, error: "statement entries must be non-empty strings" }
  // The double-anchor refusal. An Irys item is permanent; a second one does not
  // replace the first, it competes with it.
  if (r.anchored_irys_id != null) return { ok: false, error: `already anchored as ${String(r.anchored_irys_id)}` }
  return { ok: true, rec: r }
}

/** The single derivation. Both the Worker route and the harness call exactly this. */
export async function buildCorrectionPayload(rec: Record<string, unknown>): Promise<CorrectionPayload> {
  const payload = strip(rec, ANCHOR_EXCLUDE)
  const body = canonical(payload)
  const sha256 = await sha256Hex(body)
  const sup = (rec.supersedes ?? {}) as Record<string, unknown>
  const tags: CorrectionTag[] = [
    { name: "Protocol", value: "ProofOfLogic" },
    // NOT DJZS-Oracle: a correction is not a certificate, and tagging it as one
    // would put it inside query_pol_certificates' own counts.
    { name: "application-id", value: "DJZS-Correction" },
    { name: "correction-schema", value: CORRECTION_SCHEMA },
    { name: "correction-id", value: String(rec.id) },
    { name: "scope", value: String(rec.scope) },
    { name: "corrects-audit-id", value: String(sup.audit_id) },
    { name: "corrects-irys-id", value: String(sup.irys_id) },
    { name: "record-sha256", value: sha256 },
    { name: "Content-Type", value: "application/json" },
  ]
  return { payload, body, sha256, tags }
}

export interface AnchorOptions {
  /** Injectable for tests; defaults to the real Irys POST. */
  uploadFn?: UploadFn
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Gateway propagation retries. Kept small: this runs inside a request. */
  verifyAttempts?: number
  verifyDelayMs?: number
}

export interface AnchoredCorrection {
  irys_id: string
  sha256: string
  gateway_url: string
  /** How many gateway attempts it took. Surfaced so a slow propagation is visible, not hidden. */
  verify_attempts: number
}

/**
 * Sign, upload, then PROVE RETRIEVABILITY BEFORE RETURNING SUCCESS.
 *
 * The gateway check is not decoration. A caller that records an anchor it never
 * re-read is asserting permanence on the strength of a POST response; if the
 * item is not actually served, the correction's published URL is dead and the
 * record claims a remedy that cannot be read. Failing here leaves the caller's
 * files untouched, which is recoverable; recording a bad id is not.
 */
export async function anchorCorrection(
  rec: Record<string, unknown>,
  privateKeyHex: string,
  nodeUrl: string,
  opts: AnchorOptions = {},
): Promise<AnchoredCorrection> {
  const { body, sha256, tags } = await buildCorrectionPayload(rec)
  const key = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex
  const signer = new EthereumSigner(key)
  const item = createData(body, signer, { tags })
  await item.sign(signer)

  const upload = opts.uploadFn ?? buildIrysUploadFn(nodeUrl, POL_UPLOAD_TOKEN)
  const { id } = await upload(item.getRaw())
  const gateway_url = `${POL_GATEWAY_BASE}/${id}`

  const doFetch = opts.fetchFn ?? fetch
  const attempts = opts.verifyAttempts ?? 4
  const delay = opts.verifyDelayMs ?? 1500
  let served: string | null = null
  let used = 0
  for (let i = 1; i <= attempts; i++) {
    used = i
    try {
      const r = await doFetch(gateway_url)
      if (r.ok) { served = await r.text(); break }
    } catch {
      // network hiccup during propagation; retried below
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delay))
  }
  if (served === null) {
    throw new Error(
      `uploaded as ${id} but the gateway did not serve it in ${attempts} attempts. ` +
      `NOTHING RECORDED. Re-check ${gateway_url}; if it serves sha256 ${sha256}, the upload landed.`,
    )
  }
  const servedSha = await sha256Hex(served)
  if (servedSha !== sha256) {
    throw new Error(`gateway served different bytes for ${id}: expected ${sha256}, got ${servedSha}. NOTHING RECORDED.`)
  }
  return { irys_id: id, sha256, gateway_url, verify_attempts: used }
}

/** Irys mainnet GraphQL. The index that knows who signed an item. */
export const IRYS_GRAPHQL_URL = "https://uploader.irys.xyz/graphql"

export interface SignerCheck {
  ok: boolean
  irys_id: string
  /** Signer reported by the Irys index, lowercased; null when the item is unknown there. */
  signer: string | null
  expected: string
  detail: string
}

/**
 * Does this Irys item carry the DJZS signature?
 *
 * THE GAP THIS CLOSES. Anyone can upload an item wearing our tag names — the
 * tags are just strings, and the Irys query filters on them without constraining
 * the uploader. Until now a reader finding an item tagged
 * `correction-id: DJZS-CORR-001` had no way to tell a DJZS record from a copy.
 * One such copy exists (see CORRECTIONS[0].known_strays), created by accident,
 * signed by a public test key. The signer is the only part of an ANS-104 item a
 * third party cannot forge, so it is the only thing worth checking.
 *
 * Returns ok:false for an unknown item rather than throwing — "the index does
 * not have it" and "the wrong key signed it" are different answers and the
 * caller should be able to tell them apart from `detail`.
 */
export async function verifyAnchorSigner(
  irysId: string,
  expectedSigner: string,
  fetchFn: typeof fetch = fetch,
): Promise<SignerCheck> {
  const expected = expectedSigner.toLowerCase()
  const base = { irys_id: irysId, expected }
  let signer: string | null = null
  try {
    const res = await fetchFn(IRYS_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($ids:[String!]!){transactions(ids:$ids){edges{node{id address}}}}`,
        variables: { ids: [irysId] },
      }),
    })
    if (!res.ok) return { ...base, ok: false, signer: null, detail: `Irys index HTTP ${res.status}` }
    const j = (await res.json()) as { data?: { transactions?: { edges?: Array<{ node?: { address?: string } }> } } }
    const addr = j.data?.transactions?.edges?.[0]?.node?.address
    signer = typeof addr === "string" ? addr.toLowerCase() : null
  } catch (e) {
    return { ...base, ok: false, signer: null, detail: `Irys index unreachable: ${(e as Error).message.slice(0, 120)}` }
  }
  if (signer === null) return { ...base, ok: false, signer: null, detail: "not found in the Irys index" }
  if (signer !== expected) {
    return { ...base, ok: false, signer, detail: `signed by ${signer}, NOT the DJZS signer ${expected} — this is not a DJZS record` }
  }
  return { ...base, ok: true, signer, detail: "signed by the DJZS signer" }
}
