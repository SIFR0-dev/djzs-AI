/**
 * POST /corrections/anchor — the handler, separated from index.ts so it can be
 * tested offline.
 *
 * WHY IT IS NOT DEFINED INLINE IN index.ts. Importing index.ts from Node throws
 * before any test runs: http-x402-bazaar.v2.ts calls withDiscoveryFixups() at
 * module scope on line 103 while the OUTPUT_MIME_TYPE const it reads is declared
 * on line 264, which is a temporal-dead-zone error under tsx/Node ESM. The
 * SHIPPED WORKER IS NOT AFFECTED — esbuild reorders during bundling, and the
 * bundled output was evaluated to confirm it starts cleanly — so this is a
 * pre-existing testability limitation of the sources, not a production fault,
 * and fixing it belongs to whoever owns that file.
 *
 * Consequence, stated because it bounds what the tests prove: the tests mount
 * THIS EXACT HANDLER and exercise every branch, but they do not prove index.ts
 * registers it at the right path. That one fact is asserted separately, by
 * reading the registration out of index.ts as text.
 */
import type { Context } from "hono"
import { keyMatches } from "./q3-anchor"
import { logFault, type Fault } from "./safe-error"
import { anchorCorrection, validateCorrectionRecord, CORRECTION_SCHEMA, type AnchorOptions } from "./correction-anchor"

/** Mirrors the fields of index.ts's Env that this route needs. Structurally compatible. */
export interface CorrectionAnchorEnv {
  DJZS_Q3_ANCHOR_KEY?: string
  IRYS_UPLOAD_KEY?: string
  IRYS_NODE_URL?: string
}

export const CORRECTION_ANCHOR_PATH = "/corrections/anchor"

/**
 * The anchoring failures an operator must tell apart, as fixed codes. Both mean NOTHING WAS RECORDED.
 * An unretrievable upload may still have landed, so its Irys id rides along, but only if it has the
 * shape of an Irys id (43 base64url characters), which cannot carry a URL or a key.
 */
function anchorFault(e: unknown): { detail: Fault; irys_id_unverified?: string } {
  const m = e instanceof Error ? e.message : ""
  if (/gateway served different bytes/.test(m)) return { detail: "anchor_gateway_mismatch" }
  if (/gateway did not serve it/.test(m)) {
    const id = /uploaded as ([A-Za-z0-9_-]{43}) but/.exec(m)?.[1]
    return { detail: "anchor_unretrievable", ...(id ? { irys_id_unverified: id } : {}) }
  }
  return { detail: "anchor_failed" }
}

/**
 * KEY CUSTODY IS THE WHOLE POINT. IRYS_UPLOAD_KEY is a Worker secret and never
 * leaves the Worker. The operator proves intent with DJZS_Q3_ANCHOR_KEY — the
 * same header and the same constant-time compare as /q3/anchor — posts the
 * record body, and gets back {irys_id, sha256}. The harness recomputes that sha
 * locally from the SAME buildCorrectionPayload and refuses to write anything
 * back unless the two agree, so the operator verifies the Worker anchored the
 * bytes they meant without ever holding the funded key.
 *
 * ORDER MATTERS: configuration, then authorization, then shape, and only then
 * anything that signs or uploads. A route that signed first and checked later
 * would spend the funded key on an unauthorized caller before refusing them.
 */
export function makeCorrectionAnchorHandler(defaultNodeUrl: string, opts?: AnchorOptions) {
  return async (c: Context<{ Bindings: CorrectionAnchorEnv }>) => {
    const env = c.env
    if (!env.DJZS_Q3_ANCHOR_KEY || !env.IRYS_UPLOAD_KEY) {
      return c.json({ error: "correction anchoring not configured" }, 503)
    }
    if (!keyMatches(c.req.header("X-DJZS-Anchor-Key"), env.DJZS_Q3_ANCHOR_KEY)) {
      return c.json({ error: "unauthorized" }, 401)
    }
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: "invalid JSON" }, 400) }

    const v = validateCorrectionRecord(body)
    if (!v.ok) {
      // An already-anchored record is a CONFLICT, not a malformed request: the
      // caller is not wrong about the shape, they are about to publish a second
      // permanent record competing with the first.
      const conflict = v.error.startsWith("already anchored")
      return c.json({ error: v.error }, conflict ? 409 : 400)
    }
    try {
      const out = await anchorCorrection(v.rec, env.IRYS_UPLOAD_KEY, env.IRYS_NODE_URL ?? defaultNodeUrl, opts)
      return c.json({ status: "anchored", correction_schema: CORRECTION_SCHEMA, ...out })
    } catch (e) {
      // 502: the upload or the retrievability proof failed. No irys_id is
      // returned, deliberately — there is nothing here safe to record.
      logFault("corrections.anchor", e)
      const { detail, irys_id_unverified } = anchorFault(e)
      return c.json({ status: "error", detail, ...(irys_id_unverified ? { irys_id_unverified } : {}) }, 502)
    }
  }
}
