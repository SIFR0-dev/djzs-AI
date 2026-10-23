/**
 * try-route.ts - the FREE, wallet-capped preview of the paid audit.
 *
 *   GET  /try/quota?address=0x...   what this wallet has left today, and the text it must sign
 *   POST /try/verdict               { kind, intent, address, day, signature } -> verdict, no receipt
 *
 * Ruling 2026-09-27 ("sell the receipt"): the verdict is free and capped per wallet; the
 * 2.00 USDC buys the attested EAS receipt on any outcome. This route is the free half. It runs
 * THE SAME pipeline the paid routes run (runVerifyPmTrade / runVerifyPerpTrade, one extraction,
 * TypeScript decides) and returns the same verdict fields, then stops: nothing is attested,
 * nothing is anchored, no PAYMENT-RESPONSE. The response carries the offer for the paid route.
 *
 * WHY A SIGNATURE. The cap is per wallet, and a wallet is only a cap if the caller proves control
 * of it. The caller signs an EIP-191 message naming the address, the UTC day and the intent's
 * sha256; the Worker recovers the signer (EOAs offline, smart wallets through ERC-6492 on Base).
 * Binding the intent hash means a captured signature can only replay the same intent. No funds
 * move, no approval is granted: the text says so, and a wallet shows the text.
 *
 * WHY A GLOBAL CAP TOO. Wallets are free to mint, so the per-wallet cap alone bounds nothing.
 * TRY_GLOBAL_DAILY_LIMIT bounds the day's total free extractions; past it the route answers 429
 * and the paid route keeps working. Set the var lower or higher without a code change.
 *
 * QUOTA STORE. D1 (the TELEMETRY binding, table try_verdict + try_day, schema/gate-telemetry.sql).
 * The table is created if absent, so a deploy needs no migration step. Without the binding the
 * route fails CLOSED (503): an uncapped free route would be an open tap on the extraction budget.
 * No IP address is stored, per the schema's privacy note; the wallet address is the quota key
 * the caller signs for.
 *
 * ORDER OF EVENTS. Validate, verify the signature, reserve a slot (wallet, then global), run the
 * pipeline. A pipeline failure releases the slot; a scope refusal keeps it (the extraction ran).
 */
import { createPublicClient, http, getAddress, isAddress, verifyMessage as verifyMessageOffline, type Hex } from "viem"
import { base } from "viem/chains"
import type { ModelFn } from "../../server/engine-v2/extraction-layer"
import { runVerifyPmTrade, type VerifyPmTradeResult } from "./verify-pm-trade"
import { createDetector, detectorFault, runDetected, type DetectorEnv, type DetectorHandle } from "./detector"
import { runVerifyPerpTrade } from "./verify-perp-trade"
import { intentSha256, renderIntentText } from "./engine-adapter"
import { intentHash, toDJZSIntent, type PmIntentLike, type PerpIntentLike } from "./djzs-intent"
import { PERP_RESOURCE, PM_RESOURCE, PRICE_USD, NETWORK, TERMS_URL } from "./http-x402-bazaar.v2"
import { logFault } from "./safe-error"
import { PM_TAXONOMY } from "../../shared/pm-taxonomy"
import { LOGIC_FAILURE_TAXONOMY } from "../../shared/audit-schema"

export const TRY_DAILY_LIMIT = 5
export const TRY_GLOBAL_DAILY_LIMIT_DEFAULT = 200
/** Upper bound on the intent's JSON, so a free call cannot buy an arbitrarily long extraction. */
export const TRY_MAX_INTENT_BYTES = 4096
export const TRY_KINDS = ["pm", "perp"] as const
export type TryKind = (typeof TRY_KINDS)[number]

/** The exact text the wallet signs. Braces are filled by the client from GET /try/quota. */
export const TRY_MESSAGE_FORMAT =
  "djzs.ai try verdict\naddress: {address}\nday: {day}\nintent_sha256: {intent_sha256}\n\n" +
  `Free audit, ${TRY_DAILY_LIMIT} per wallet per UTC day. No funds move. Nothing is attested.`

export function tryMessage(address: string, day: string, intentSha: string): string {
  return TRY_MESSAGE_FORMAT.replace("{address}", address).replace("{day}", day).replace("{intent_sha256}", intentSha)
}

/** UTC calendar day, the quota bucket. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
export function nextUtcMidnight(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return d.toISOString()
}

/** The slice of D1 this route calls. Structural, like TelemetryDB in index.ts. */
export interface QuotaDB {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      first<T = Record<string, unknown>>(): Promise<T | null>
    }
  }
}

export interface TryEnv extends DetectorEnv {
  BASE_RPC_URL?: string
  TELEMETRY?: QuotaDB
  /** Plain var. Total free verdicts per UTC day across all wallets. Default TRY_GLOBAL_DAILY_LIMIT_DEFAULT. */
  TRY_GLOBAL_DAILY_LIMIT?: string
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
}

function json(obj: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  })
}

// ── schema (idempotent; also in schema/gate-telemetry.sql for the operator) ─────────────────
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS try_verdict (
     day      TEXT    NOT NULL,
     address  TEXT    NOT NULL,
     n        INTEGER NOT NULL DEFAULT 0,
     first_ts TEXT    NOT NULL,
     last_ts  TEXT    NOT NULL,
     PRIMARY KEY (day, address)
   )`,
  `CREATE TABLE IF NOT EXISTS try_day (
     day TEXT PRIMARY KEY,
     n   INTEGER NOT NULL DEFAULT 0
   )`,
]
/** One CREATE pass per D1 handle per isolate. Keyed on the binding object, never module-global state about a request. */
const schemaReady = new WeakMap<object, Promise<void>>()
function ensureSchema(db: QuotaDB): Promise<void> {
  let p = schemaReady.get(db)
  if (!p) {
    p = (async () => {
      for (const sql of SCHEMA_SQL) await db.prepare(sql).bind().run()
    })()
    p.catch(() => schemaReady.delete(db)) // a failed CREATE is retried on the next request
    schemaReady.set(db, p)
  }
  return p
}

async function walletUsed(db: QuotaDB, day: string, address: string): Promise<number> {
  const row = await db.prepare("SELECT n FROM try_verdict WHERE day = ? AND address = ?").bind(day, address).first<{ n: number }>()
  return row?.n ?? 0
}
async function globalUsed(db: QuotaDB, day: string): Promise<number> {
  const row = await db.prepare("SELECT n FROM try_day WHERE day = ?").bind(day).first<{ n: number }>()
  return row?.n ?? 0
}
/** Atomic reserve: increments only while under the limit; null means exhausted. */
async function reserveWallet(db: QuotaDB, day: string, address: string, limit: number, ts: string): Promise<number | null> {
  const row = await db
    .prepare(
      "INSERT INTO try_verdict (day, address, n, first_ts, last_ts) VALUES (?, ?, 1, ?, ?) " +
        "ON CONFLICT(day, address) DO UPDATE SET n = n + 1, last_ts = excluded.last_ts WHERE try_verdict.n < ? RETURNING n",
    )
    .bind(day, address, ts, ts, limit)
    .first<{ n: number }>()
  return row?.n ?? null
}
async function reserveGlobal(db: QuotaDB, day: string, limit: number): Promise<number | null> {
  const row = await db
    .prepare("INSERT INTO try_day (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE try_day.n < ? RETURNING n")
    .bind(day, limit)
    .first<{ n: number }>()
  return row?.n ?? null
}
async function releaseWallet(db: QuotaDB, day: string, address: string): Promise<void> {
  await db.prepare("UPDATE try_verdict SET n = n - 1 WHERE day = ? AND address = ? AND n > 0").bind(day, address).run().catch(() => {})
}
async function releaseGlobal(db: QuotaDB, day: string): Promise<void> {
  await db.prepare("UPDATE try_day SET n = n - 1 WHERE day = ? AND n > 0").bind(day).run().catch(() => {})
}

function globalLimit(env: TryEnv): number {
  const n = Number(env.TRY_GLOBAL_DAILY_LIMIT)
  return Number.isInteger(n) && n >= 0 ? n : TRY_GLOBAL_DAILY_LIMIT_DEFAULT
}

/** EOA first (offline, no RPC), then ERC-6492/1271 through Base for smart wallets. */
async function signatureValid(env: TryEnv, address: Hex, message: string, signature: Hex): Promise<boolean> {
  try {
    if (await verifyMessageOffline({ address, message, signature })) return true
  } catch {
    /* not a plain ECDSA signature; fall through to the on-chain path */
  }
  try {
    const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL ?? "https://mainnet.base.org") })
    return await client.verifyMessage({ address, message, signature })
  } catch {
    return false
  }
}

/** Taxonomy lookup for plain-language flag details; unknown codes pass through bare. */
function describeCode(code: string): { name?: string; description?: string; severity?: string; weight?: number } {
  const pm = (PM_TAXONOMY as Record<string, { name: string; description: string; severity: string; weight: number }>)[code]
  if (pm) return { name: pm.name, description: pm.description, severity: pm.severity, weight: pm.weight }
  const lf = (LOGIC_FAILURE_TAXONOMY as Record<string, { name: string; description: string; severity: string; weight: number }>)[code]
  if (lf) return { name: lf.name, description: lf.description, severity: lf.severity, weight: lf.weight }
  return {}
}

function receiptOffer(kind: TryKind) {
  const spec = kind === "perp" ? PERP_RESOURCE : PM_RESOURCE
  return {
    price: `${PRICE_USD.toFixed(2)} USDC`,
    network: NETWORK,
    url: spec.url,
    ruleset: spec.rulesetVersion,
    what: "The same audit, run again on the same intent and attested on Base (EAS) with the payer as recipient. Verifiable by anyone at https://djzs.ai/verify.",
    how: "POST { intent } to url; answer the 402 with an x402 exact-EVM payment (USDC on Base). Out-of-scope intents are refused without charge.",
  }
}

export async function handleTryQuota(request: Request, env: TryEnv): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "GET") return json({ error: "method_not_allowed", allow: "GET, OPTIONS" }, 405)
  const url = new URL(request.url)
  const raw = url.searchParams.get("address") ?? ""
  const day = utcDay()
  const common = {
    day,
    resets_at: nextUtcMidnight(),
    limit: TRY_DAILY_LIMIT,
    message_format: TRY_MESSAGE_FORMAT,
    kinds: TRY_KINDS,
    receipt: { pm: receiptOffer("pm"), perp: receiptOffer("perp") },
    terms: TERMS_URL,
  }
  if (!env.TELEMETRY) return json({ ok: false, error: "quota_store_unavailable", ...common }, 503)
  await ensureSchema(env.TELEMETRY)
  const gUsed = await globalUsed(env.TELEMETRY, day)
  const gLimit = globalLimit(env)
  if (!raw) return json({ ok: true, ...common, global_remaining: Math.max(0, gLimit - gUsed) }, 200)
  if (!isAddress(raw)) return json({ ok: false, error: "bad_address", ...common }, 400)
  const address = getAddress(raw)
  const used = await walletUsed(env.TELEMETRY, day, address)
  return json(
    { ok: true, address, used, remaining: Math.max(0, TRY_DAILY_LIMIT - used), global_remaining: Math.max(0, gLimit - gUsed), ...common },
    200,
  )
}

type Runner = (text: string, model: ModelFn) => Promise<VerifyPmTradeResult>

export async function handleTryVerdict(request: Request, env: TryEnv, modelFn?: ModelFn): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "POST") return json({ error: "method_not_allowed", allow: "POST, OPTIONS" }, 405)

  // 1. body shape
  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== "object") throw new Error("not an object")
    body = parsed as Record<string, unknown>
  } catch {
    return json({ ok: false, error: "invalid_json", schema: "POST { kind, intent, address, day, signature }" }, 400)
  }
  const kind = body.kind
  if (kind !== "pm" && kind !== "perp") return json({ ok: false, error: "bad_kind", allowed: TRY_KINDS }, 400)
  const intent = body.intent
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return json({ ok: false, error: "missing_intent", schema: "intent must be an object" }, 400)
  if (JSON.stringify(intent).length > TRY_MAX_INTENT_BYTES) return json({ ok: false, error: "intent_too_large", max_bytes: TRY_MAX_INTENT_BYTES }, 413)
  if (typeof body.address !== "string" || !isAddress(body.address)) return json({ ok: false, error: "bad_address" }, 400)
  const address = getAddress(body.address)
  const day = utcDay()
  if (body.day !== day) return json({ ok: false, error: "day_mismatch", day, detail: "sign with the server's UTC day from GET /try/quota and retry" }, 400)
  const signature = body.signature
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return json({ ok: false, error: "bad_signature_format" }, 400)

  // 2. the signature binds address, day and this exact intent
  const sha = intentSha256(intent)
  const message = tryMessage(address, day, sha)
  if (!(await signatureValid(env, address, message, signature as Hex))) {
    return json({ ok: false, error: "bad_signature", signed_text_expected: message }, 401)
  }

  // 3. quota store: fail closed
  const db = env.TELEMETRY
  if (!db) return json({ ok: false, error: "quota_store_unavailable" }, 503)
  await ensureSchema(db)
  // The detector switch (detector.ts). A test passes modelFn; production resolves it from the env.
  let detector: DetectorHandle | undefined
  if (!modelFn) {
    try {
      detector = createDetector(env)
    } catch (e) {
      logFault("try.detector", e)
      return json({ ok: false, error: "audit_unavailable", detail: detectorFault(e) ?? "audit_unavailable" }, 503)
    }
  }

  // Kill switch first. TRY_GLOBAL_DAILY_LIMIT="0" must refuse every free verdict: SQLite's upsert
  // INSERTS a new day row whatever the DO UPDATE's WHERE says, so reserveGlobal alone would let the
  // day's first call through at limit 0.
  const gLimit = globalLimit(env)
  if (gLimit <= 0) {
    return json({ ok: false, error: "free_tier_exhausted_today", day, resets_at: nextUtcMidnight(), receipt: receiptOffer(kind), terms: TERMS_URL }, 429)
  }
  const ts = new Date().toISOString()
  const used = await reserveWallet(db, day, address, TRY_DAILY_LIMIT, ts)
  if (used === null) {
    return json(
      { ok: false, error: "wallet_quota_exhausted", day, limit: TRY_DAILY_LIMIT, used: TRY_DAILY_LIMIT, remaining: 0, resets_at: nextUtcMidnight(), receipt: receiptOffer(kind), terms: TERMS_URL },
      429,
    )
  }
  const g = await reserveGlobal(db, day, gLimit)
  if (g === null) {
    await releaseWallet(db, day, address)
    return json({ ok: false, error: "free_tier_exhausted_today", day, resets_at: nextUtcMidnight(), receipt: receiptOffer(kind), terms: TERMS_URL }, 429)
  }
  const quota = { day, limit: TRY_DAILY_LIMIT, used, remaining: Math.max(0, TRY_DAILY_LIMIT - used), resets_at: nextUtcMidnight() }

  // 4. the same pipeline the paid route runs, once
  const runner: Runner = kind === "perp" ? (runVerifyPerpTrade as unknown as Runner) : runVerifyPmTrade
  let result: VerifyPmTradeResult
  try {
    const text = renderIntentText(intent)
    const d = detector
    result = d ? await runDetected(() => runner(text, d.modelFn), d, text) : await runner(text, modelFn as ModelFn)
  } catch (e) {
    await releaseGlobal(db, day)
    await releaseWallet(db, day, address)
    // The cause (an extraction provider's error body) goes to the log; a free, unauthenticated-by-payment route returns a code.
    logFault("try.audit", e)
    return json({ ok: false, error: "audit_unavailable", detail: detectorFault(e) ?? "audit_unavailable", slot_released: true }, 503)
  }

  if (result.in_scope !== true) {
    return json(
      {
        ok: true,
        kind,
        verdict: "REFUSED_SCOPE",
        reason: typeof result.reason === "string" ? result.reason : "out_of_scope",
        note: kind === "pm" ? "This route audits prediction-market intents; the perp route audits trades." : "This route audits perp and spot trades; the pm route audits prediction-market intents.",
        intent_sha256: sha,
        quota,
        attested: false,
        terms: TERMS_URL,
      },
      200,
    )
  }
  const verdict = result.verdict
  if (verdict !== "PASS" && verdict !== "WAIT" && verdict !== "FAIL") {
    logFault("try.verdict", new Error(`unexpected verdict ${JSON.stringify(verdict)}`))
    return json({ ok: false, error: "engine_contract_violation", detail: "engine_error" }, 500)
  }
  const flagsRaw = Array.isArray(result.flags) ? (result.flags as Array<Record<string, unknown>>) : []
  const flags_detail = flagsRaw
    .filter((f) => f && typeof f.code === "string")
    .map((f) => ({ code: f.code as string, ...describeCode(f.code as string), ...(typeof f.evidence === "string" ? { evidence: f.evidence } : {}) }))
  const unknown = Array.isArray(result.unknown_fields) ? (result.unknown_fields as unknown[]).filter((u): u is string => typeof u === "string") : []
  const flags = [...flags_detail.map((f) => f.code), ...unknown.map((u) => `unknown:${u}`)]
  let intent_hash: string | null = null
  try {
    intent_hash = intentHash(toDJZSIntent(intent as PmIntentLike | PerpIntentLike, kind))
  } catch {
    intent_hash = null // the paid route computes the binding key; a shape it cannot map is reported as null here, not as a failure
  }
  const taxonomy = result.taxonomy && typeof result.taxonomy === "object" ? (result.taxonomy as Record<string, unknown>) : undefined
  return json(
    {
      ok: true,
      kind,
      verdict,
      risk_score: typeof result.risk_score === "number" ? result.risk_score : 0,
      flags,
      flags_detail,
      unknown_fields: unknown,
      verdict_hash: typeof result.verdict_hash === "string" ? result.verdict_hash : null,
      intent_sha256: sha,
      intent_hash,
      ...(result.tally ? { tally: result.tally } : {}),
      ...(taxonomy ? { taxonomy } : {}),
      ruleset: kind === "perp" ? PERP_RESOURCE.rulesetVersion : PM_RESOURCE.rulesetVersion,
      quota,
      attested: false,
      receipt: receiptOffer(kind),
      note: "Free verdict: same engine, same ruleset, not attested and not anchored. The receipt is what a counterparty can check.",
      terms: TERMS_URL,
    },
    200,
  )
}
