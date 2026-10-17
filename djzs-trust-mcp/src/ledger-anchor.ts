/**
 * Ledger commit-and-reveal — the conflict record for the Daily Narrative Scan.
 *
 * WHY THIS EXISTS. The scan grades public narratives against markets. The show
 * law says the ledger is never disclosed. Those two rules collide the moment the
 * scan author opens a position in a market the scan graded: a verdict on a
 * market the author is in, under a brand whose claim is neutrality. The fix the
 * 2026-09-30 review proposed, ruled in on 2026-10-16: hash the position when it
 * opens, reveal it when it closes, both anchored and permanent.
 *
 * TWO RECORD KINDS, ONE SCHEMA.
 *   commit — published when the position opens. Public fields: the scan row it
 *            touches, the venue, the market, the open time, and a 32-byte
 *            commitment = sha256(canonical(preimage)). Side, size and price are
 *            NOT in it. A reader learns that the author holds SOME position in
 *            THAT market from THAT time, which is the disclosure the conflict
 *            needs, and nothing a copier could trade on.
 *   reveal — published when the position closes. Carries the full preimage
 *            (side, size, price, salt), the close, and the commit's Irys id. The
 *            Worker recomputes sha256(canonical(preimage)) and REFUSES the
 *            reveal unless it equals the stated commitment, so a reveal can
 *            never describe a different position than the one committed.
 *
 * THE SALT. 32 random bytes inside the preimage. Without it, a commitment over
 * {venue, market, side, size, price} is guessable from a small space and the
 * commit would leak the position it is meant to hide.
 *
 * SAME DISCIPLINE AS CORRECTIONS. canonical JSON, sha256 over the exact bytes
 * that are uploaded, gateway read-back before success, and the harness refuses
 * its write-back unless the Worker's sha equals the local one. Key custody is
 * unchanged: IRYS_UPLOAD_KEY never leaves the Worker.
 */
import { EthereumSigner, createData } from "@irys/bundles/web"
import { buildIrysUploadFn, POL_GATEWAY_BASE, POL_UPLOAD_TOKEN } from "./pol-certificate"
import { canonical, sha256Hex, strip, type AnchorOptions, type CorrectionTag } from "./correction-anchor"

export const LEDGER_SCHEMA = "DJZS-Ledger-1"
export const LEDGER_KINDS = ["commit", "reveal"] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]
export const LEDGER_SIDES = ["yes", "no", "long", "short"] as const
/** Fields the local file carries that are NOT part of the anchored bytes. */
export const LEDGER_ANCHOR_EXCLUDE: ReadonlySet<string> = new Set(["anchored_irys_id", "anchored_at"])

const HEX32 = /^0x[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/
const ID = /^DJZS-LEDGER-\d{3,}$/

export interface LedgerPreimage {
  venue: string
  market: string
  side: string
  size: number
  price: number
  opened_at: string
  salt: string
}

/** sha256 of the canonical preimage. The ONE derivation; harness and Worker both call it. */
export async function commitmentOf(pre: LedgerPreimage): Promise<string> {
  return sha256Hex(canonical(pre))
}

export function validatePreimage(p: unknown): { ok: true; pre: LedgerPreimage } | { ok: false; error: string } {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "preimage must be an object" }
  const r = p as Record<string, unknown>
  for (const k of ["venue", "market", "side", "opened_at", "salt"]) {
    if (typeof r[k] !== "string" || !r[k]) return { ok: false, error: `preimage.${k} required` }
  }
  if (!(LEDGER_SIDES as readonly string[]).includes(r.side as string)) return { ok: false, error: `preimage.side must be one of ${LEDGER_SIDES.join("|")}` }
  if (typeof r.size !== "number" || !(r.size > 0) || !Number.isFinite(r.size)) return { ok: false, error: "preimage.size must be a positive number" }
  if (typeof r.price !== "number" || !(r.price > 0) || !Number.isFinite(r.price)) return { ok: false, error: "preimage.price must be a positive number" }
  if (!ISO.test(r.opened_at as string)) return { ok: false, error: "preimage.opened_at must be ISO 8601 UTC" }
  if (!HEX32.test(r.salt as string)) return { ok: false, error: "preimage.salt must be 0x + 64 hex (32 random bytes)" }
  return { ok: true, pre: r as unknown as LedgerPreimage }
}

/**
 * Validates a commit or a reveal. A reveal's commitment is checked against its
 * preimage HERE, before anything signs: a reveal that does not open its own
 * commit is not a reveal.
 */
export async function validateLedgerRecord(
  rec: unknown,
): Promise<{ ok: true; rec: Record<string, unknown>; kind: LedgerKind } | { ok: false; error: string }> {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, error: "record must be an object" }
  const r = rec as Record<string, unknown>
  if (typeof r.id !== "string" || !ID.test(r.id)) return { ok: false, error: "id must look like DJZS-LEDGER-001" }
  if (r.kind !== "commit" && r.kind !== "reveal") return { ok: false, error: "kind must be commit or reveal" }
  if (typeof r.scan_row !== "string" || !r.scan_row) return { ok: false, error: "scan_row required (the graded narrative this position touches)" }
  if (typeof r.venue !== "string" || !r.venue) return { ok: false, error: "venue required" }
  if (typeof r.market !== "string" || !r.market) return { ok: false, error: "market required" }
  if (typeof r.opened_at !== "string" || !ISO.test(r.opened_at)) return { ok: false, error: "opened_at must be ISO 8601 UTC" }
  if (typeof r.commitment !== "string" || !HEX32.test(r.commitment)) return { ok: false, error: "commitment must be 0x + 64 hex" }
  if (r.anchored_irys_id != null) return { ok: false, error: `already anchored as ${String(r.anchored_irys_id)}` }
  if (r.kind === "commit") {
    for (const k of ["side", "size", "price", "salt", "preimage"]) {
      if (k in r) return { ok: false, error: `a commit must not carry ${k}; that is what the commitment hides` }
    }
    return { ok: true, rec: r, kind: "commit" }
  }
  // reveal
  if (typeof r.commit_irys_id !== "string" || !r.commit_irys_id) return { ok: false, error: "reveal needs commit_irys_id (the anchored commit it opens)" }
  const v = validatePreimage(r.preimage)
  if (!v.ok) return v
  if (v.pre.venue !== r.venue || v.pre.market !== r.market || v.pre.opened_at !== r.opened_at) {
    return { ok: false, error: "preimage venue/market/opened_at must equal the record's public fields" }
  }
  const c = await commitmentOf(v.pre)
  if (c !== r.commitment) return { ok: false, error: `preimage does not open the commitment: sha256 ${c} != ${r.commitment}` }
  if (typeof r.closed_at !== "string" || !ISO.test(r.closed_at)) return { ok: false, error: "reveal needs closed_at (ISO 8601 UTC)" }
  if (r.closed_at <= r.opened_at) return { ok: false, error: "closed_at must be after opened_at" }
  if (typeof r.close_price !== "number" || !Number.isFinite(r.close_price) || r.close_price < 0) return { ok: false, error: "reveal needs close_price (number >= 0; 0 for a market that settled against the position)" }
  return { ok: true, rec: r, kind: "reveal" }
}

export interface LedgerPayload { payload: Record<string, unknown>; body: string; sha256: string; tags: CorrectionTag[] }

/** The single derivation. Both the Worker route and the harness call exactly this. */
export async function buildLedgerPayload(rec: Record<string, unknown>): Promise<LedgerPayload> {
  const payload = strip(rec, LEDGER_ANCHOR_EXCLUDE)
  const body = canonical(payload)
  const sha256 = await sha256Hex(body)
  const tags: CorrectionTag[] = [
    { name: "Protocol", value: "ProofOfLogic" },
    // NOT DJZS-Oracle and NOT DJZS-Q3: a position is neither a certificate nor a study record.
    { name: "application-id", value: "DJZS-Ledger" },
    { name: "ledger-schema", value: LEDGER_SCHEMA },
    { name: "ledger-kind", value: String(rec.kind) },
    { name: "ledger-id", value: String(rec.id) },
    { name: "scan-row", value: String(rec.scan_row) },
    { name: "venue", value: String(rec.venue) },
    { name: "market", value: String(rec.market) },
    { name: "commitment", value: String(rec.commitment) },
    { name: "record-sha256", value: sha256 },
    { name: "Content-Type", value: "application/json" },
  ]
  if (rec.kind === "reveal") tags.splice(9, 0, { name: "opens-irys-id", value: String(rec.commit_irys_id) })
  return { payload, body, sha256, tags }
}

export interface AnchoredLedger { irys_id: string; sha256: string; gateway_url: string; verify_attempts: number }

/** Sign, upload, prove retrievability, then return. Mirrors anchorCorrection byte for byte in discipline. */
export async function anchorLedger(
  rec: Record<string, unknown>,
  privateKeyHex: string,
  nodeUrl: string,
  opts: AnchorOptions = {},
): Promise<AnchoredLedger> {
  const { body, sha256, tags } = await buildLedgerPayload(rec)
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
    try { const r = await doFetch(gateway_url); if (r.ok) { served = await r.text(); break } } catch { /* retried */ }
    if (i < attempts) await new Promise((r) => setTimeout(r, delay))
  }
  if (served === null) throw new Error(`uploaded as ${id} but the gateway did not serve it in ${attempts} attempts. NOTHING RECORDED. Re-check ${gateway_url}; if it serves sha256 ${sha256}, the upload landed.`)
  const servedSha = await sha256Hex(served)
  if (servedSha !== sha256) throw new Error(`gateway served different bytes for ${id}: expected ${sha256}, got ${servedSha}. NOTHING RECORDED.`)
  return { irys_id: id, sha256, gateway_url, verify_attempts: used }
}
