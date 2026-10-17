/**
 * POST /ledger/anchor — anchor a Ledger commit or reveal, Worker-side.
 *
 * Same key custody and the same order as /corrections/anchor: configuration,
 * then authorization, then shape (which for a reveal includes recomputing the
 * commitment from the preimage), and only then anything that signs or uploads.
 * IRYS_UPLOAD_KEY never leaves the Worker; the operator proves intent with
 * DJZS_Q3_ANCHOR_KEY in the same header. Lives outside index.ts so the offline
 * test can mount it (index.ts cannot be imported from Node; see correction-route.ts).
 */
import type { Context } from "hono"
import { keyMatches } from "./q3-anchor"
import { anchorLedger, validateLedgerRecord, LEDGER_SCHEMA } from "./ledger-anchor"
import type { AnchorOptions } from "./correction-anchor"

export interface LedgerAnchorEnv {
  DJZS_Q3_ANCHOR_KEY?: string
  IRYS_UPLOAD_KEY?: string
  IRYS_NODE_URL?: string
}

export const LEDGER_ANCHOR_PATH = "/ledger/anchor"

export function makeLedgerAnchorHandler(defaultNodeUrl: string, opts?: AnchorOptions) {
  return async (c: Context<{ Bindings: LedgerAnchorEnv }>) => {
    const env = c.env
    if (!env.DJZS_Q3_ANCHOR_KEY || !env.IRYS_UPLOAD_KEY) return c.json({ error: "ledger anchoring not configured" }, 503)
    if (!keyMatches(c.req.header("X-DJZS-Anchor-Key"), env.DJZS_Q3_ANCHOR_KEY)) return c.json({ error: "unauthorized" }, 401)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: "invalid JSON" }, 400) }
    const v = await validateLedgerRecord(body)
    if (!v.ok) return c.json({ error: v.error }, v.error.startsWith("already anchored") ? 409 : 400)
    try {
      const out = await anchorLedger(v.rec, env.IRYS_UPLOAD_KEY, env.IRYS_NODE_URL ?? defaultNodeUrl, opts)
      return c.json({ status: "anchored", ledger_schema: LEDGER_SCHEMA, kind: v.kind, ...out })
    } catch (e) {
      return c.json({ status: "error", detail: (e instanceof Error ? e.message : String(e)).slice(0, 400) }, 502)
    }
  }
}
