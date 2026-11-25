/**
 * pay-link.ts - pay for a DJZS audit from a chat client that cannot sign an x402 payment itself.
 *
 * THE GAP. verify_pm_trade and verify_perp_trade cost 2.00 USDC over x402. An x402 client (an agent with a
 * wallet) pays in-band: the unpaid call returns the payment requirement, the client signs and calls again.
 * A chat app has no wallet, so the same call dead-ends at "payment required" and the user cannot buy the audit
 * from the chat at all.
 *
 * THE LINK. When a paid tool is called with NO payment, the answer is unchanged (same isError result, same
 * _meta["x402/error"], so every x402 client still pays exactly as before) and it ALSO carries a pay link:
 * https://mcp.djzs.ai/pay/<pay_session>. The session stores the exact tool arguments and the exact x402 quote
 * from that unpaid answer. The user opens the link in a browser, sees the exact thesis and the price, and signs
 * one EIP-3009 USDC authorization in their own wallet. The page posts it back; the Worker then makes the SAME
 * paid tool call in-process with that payment attached (the x402 path is the code under test, not a copy of it):
 * withX402 verifies, runs the audit, and settles only a non-error result, exactly as for an agent payer.
 * The chat then calls get_paid_audit with the pay_session and receives the verdict and the receipt.
 *
 * FORWARD COMPATIBLE. The same URL is the target of a URL-mode elicitation once this server speaks MCP
 * 2026-07-28 (Claude declares URL elicitation to legacy connector servers as form-only, so the link travels in
 * the tool result for now). Nothing in the session format depends on how the link reached the user.
 *
 * WHAT THE LINK IS. A capability, not an identity: whoever opens it can pay for that one audit, and whoever
 * holds the pay_session can read its result. The page shows the exact thesis and price before anything is
 * signed, so a forwarded link cannot charge anyone for something they did not see. The URL carries nothing but
 * a random id (no thesis, no wallet, no credential). The session is single-use: pending -> paying is an atomic
 * claim, so two tabs cannot pay twice for one audit.
 *
 * MONEY RULES, all inherited from the paid tool: the recipient and amount are inside the payer's signature;
 * an out-of-scope thesis or a failed audit is never settled; a payment whose outcome cannot be confirmed is
 * reported as UNCERTAIN, never as "not charged".
 *
 * STORAGE. D1 (the TELEMETRY binding), table pay_session, created on first use like the /try tables. No IP and
 * no user identity is stored. Rows are pruned PAY_SESSION_RETENTION_MS after the link expires. Without the
 * binding no link is offered and the paid tools behave exactly as before.
 */
import { reasonCode } from "./safe-error"

export const PAY_LINK_ORIGIN = "https://mcp.djzs.ai"
export const PAY_SESSION_RE = /^ps_[A-Za-z0-9_-]{22}$/
export const PAY_META_KEY = "ai.djzs/pay"
/** How long a link can be paid. Short: it is minted for one conversation turn. */
export const PAY_LINK_TTL_MS = 30 * 60 * 1000
/** Rows (and their results) are kept this long after the link expires, then pruned by the daily cron. */
export const PAY_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** A claimed session with no outcome after this long is reported UNCERTAIN, not PROCESSING. */
export const PROCESSING_STALE_MS = 10 * 60 * 1000
export const PAY_LINK_DAILY_LIMIT_DEFAULT = 300
export const PAID_TOOLS = ["verify_pm_trade", "verify_perp_trade"] as const
export type PaidToolName = (typeof PAID_TOOLS)[number]
const MAX_ARGS_BYTES = 16_384
const MAX_PAYMENT_BYTES = 16_384

/** What the page checks the stored quote against before it asks the wallet to sign anything. */
export interface PayExpect {
  network: string
  chainId: number
  amount: string
  asset: string
  payTo: string
}

/** The slice of the D1 client used here (same structural typing as Env.TELEMETRY in index.ts). */
export interface PayDB {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      first<T = Record<string, unknown>>(): Promise<T | null>
    }
  }
}

type SessionStatus = "pending" | "paying" | "paid" | "refused" | "uncertain"

interface SessionRow {
  id: string
  tool: string
  args: string
  accepts: string
  resource: string
  status: SessionStatus
  created_at: string
  expires_at: string
  updated_at: string
  result: string | null
  payment: string | null
  detail: string | null
}

export interface PayLink {
  url: string
  pay_session: string
  expires_at: string
  price: string
  network: string
}

/** The MCP tool result shape as far as this module reads it. */
export interface ToolResultLike {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type PayPreflight = { ok: true } | { ok: false; code: string }

export interface PayDeps {
  /** Facilitator verify of the signed authorization against a freshly built quote. Moves no money. */
  preflight(tool: PaidToolName, payment: string): Promise<PayPreflight>
  /** The paid tool, called in-process through the real MCP server with the payment in _meta["x402/payment"]. */
  callPaidTool(tool: PaidToolName, args: Record<string, unknown>, payment: string): Promise<ToolResultLike>
}

// ── schema (idempotent; also in schema/gate-telemetry.sql for the operator) ─────────────────────────────────
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS pay_session (
     id          TEXT PRIMARY KEY,
     tool        TEXT NOT NULL,
     args        TEXT NOT NULL,
     accepts     TEXT NOT NULL,
     resource    TEXT NOT NULL,
     status      TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     result      TEXT,
     payment     TEXT,
     detail      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pay_session_created ON pay_session (created_at)`,
]
const schemaReady = new WeakMap<object, Promise<void>>()
function ensureSchema(db: PayDB): Promise<void> {
  let p = schemaReady.get(db)
  if (!p) {
    p = (async () => {
      for (const sql of SCHEMA_SQL) await db.prepare(sql).bind().run()
    })()
    p.catch(() => schemaReady.delete(db))
    schemaReady.set(db, p)
  }
  return p
}

export function isPaidTool(name: string): name is PaidToolName {
  return (PAID_TOOLS as readonly string[]).includes(name)
}

export function payLinkDailyLimit(raw: unknown): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : PAY_LINK_DAILY_LIMIT_DEFAULT
}

export function newPaySessionId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return "ps_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function payUrl(id: string): string {
  return `${PAY_LINK_ORIGIN}/pay/${id}`
}

function parseJson<T>(s: string | null | undefined): T | null {
  if (typeof s !== "string") return null
  try { return JSON.parse(s) as T } catch { return null }
}

const DAY_START = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`

/**
 * Create a session for an unpaid call and return its link, or null when no link can be offered (no D1, over the
 * daily cap, arguments too large, no quote). Never throws for the caller's sake: a missing link only means the
 * paid tool answers exactly as it did before this module existed.
 */
export async function mintPayLink(
  db: PayDB | undefined,
  o: { tool: PaidToolName; args: Record<string, unknown>; accepts: unknown; resource: unknown; now: Date; dailyLimit: number },
): Promise<PayLink | null> {
  if (!db) return null
  if (!Array.isArray(o.accepts) || o.accepts.length === 0 || !o.resource || typeof o.resource !== "object") return null
  const args = JSON.stringify(o.args ?? {})
  if (new TextEncoder().encode(args).length > MAX_ARGS_BYTES) return null
  await ensureSchema(db)
  const today = await db.prepare("SELECT COUNT(*) AS n FROM pay_session WHERE created_at >= ?").bind(DAY_START(o.now)).first<{ n: number }>()
  if ((today?.n ?? 0) >= o.dailyLimit) return null
  const id = newPaySessionId()
  const created = o.now.toISOString()
  const expires = new Date(o.now.getTime() + PAY_LINK_TTL_MS).toISOString()
  await db
    .prepare("INSERT INTO pay_session (id, tool, args, accepts, resource, status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
    .bind(id, o.tool, args, JSON.stringify(o.accepts), JSON.stringify(o.resource), created, expires, created)
    .run()
  return { url: payUrl(id), pay_session: id, expires_at: expires, price: "2.00 USDC", network: "Base (eip155:8453)" }
}

/** The line a model reads next to the x402 requirement. ASCII only, like every tool text on this server. */
export function payLinkText(link: PayLink): string {
  return [
    "No x402 wallet in this client? The user can pay in a browser instead.",
    `Pay link: ${link.url}`,
    `Price: ${link.price} on Base, signed in the user's own wallet. The link expires at ${link.expires_at}.`,
    "Show the user this link and the price. Wait until they say they paid, then call get_paid_audit with",
    `pay_session "${link.pay_session}". Do not call the paid tool again to pay.`,
  ].join("\n")
}

async function loadRow(db: PayDB, id: string): Promise<SessionRow | null> {
  await ensureSchema(db)
  return db.prepare("SELECT * FROM pay_session WHERE id = ?").bind(id).first<SessionRow>()
}

/** The view of a session both readers share: the page and get_paid_audit. Stale claims read as uncertain. */
function effectiveStatus(row: SessionRow, now: Date): SessionStatus | "expired" {
  if (row.status === "pending" && row.expires_at <= now.toISOString()) return "expired"
  if (row.status === "paying" && now.getTime() - Date.parse(row.updated_at) > PROCESSING_STALE_MS) return "uncertain"
  return row.status
}

const UNCERTAIN_REMEDIATION =
  "The payment could not be confirmed. Before paying again, check whether 2.00 USDC left the wallet that signed. " +
  "If it did, contact support with this pay_session. If it did not, run the paid tool again for a new link."

/** get_paid_audit. Read-only. */
export async function readPaidAudit(db: PayDB | undefined, id: string, now: Date): Promise<Record<string, unknown>> {
  if (!db) return { status: "UNAVAILABLE", pay_session: id, detail: "pay_links_unavailable" }
  if (!PAY_SESSION_RE.test(id)) return { status: "NOT_FOUND", pay_session: id }
  const row = await loadRow(db, id)
  if (!row) return { status: "NOT_FOUND", pay_session: id }
  const st = effectiveStatus(row, now)
  const base = { pay_session: id, tool: row.tool }
  switch (st) {
    case "paid":
      return {
        status: "PAID", ...base, charged: true,
        audit: parseJson<Record<string, unknown>>(row.result) ?? {},
        payment: parseJson<Record<string, unknown>>(row.payment) ?? {},
      }
    case "refused":
      return { status: "REFUSED_SCOPE", ...base, charged: false, audit: parseJson<Record<string, unknown>>(row.result) ?? {},
        detail: "Sent to the wrong paid tool. Nothing was charged. Use verify_pm_trade for a prediction-market bet and verify_perp_trade for a perpetual or spot trade." }
    case "paying":
      return { status: "PROCESSING", ...base, detail: "The payment is being settled and the audit is running. Call again in a few seconds." }
    case "uncertain":
      return { status: "UNCERTAIN", ...base, charged: null, detail: row.detail ?? "settlement_uncertain", remediation: UNCERTAIN_REMEDIATION }
    case "expired":
      return { status: "EXPIRED", ...base, charged: false, detail: "The link expired unpaid. Run the paid tool again for a new link." }
    default:
      return {
        status: "PENDING", ...base, charged: false, pay_url: payUrl(id), expires_at: row.expires_at,
        ...(row.detail ? { last_attempt: row.detail } : {}),
        detail: "Not paid yet. Give the user the link again and wait until they say they paid.",
      }
  }
}

/**
 * Map the in-process paid call to a session outcome. The preflight verify has already passed when this runs,
 * so an x402 error now comes from the tool's own verify or from settlement: neither "charged" nor "not charged"
 * can be claimed, and it is UNCERTAIN (the same rule as SETTLEMENT_UNCERTAIN on the HTTP route).
 */
export function classifyPaidResult(r: ToolResultLike | null): { status: SessionStatus; detail: string | null; result: unknown; payment: unknown } {
  const meta = (r?._meta ?? {}) as Record<string, unknown>
  const receipt = meta["x402/payment-response"] as { success?: unknown } | undefined
  if (r && r.isError !== true) {
    if (receipt && receipt.success === true) return { status: "paid", detail: null, result: r.structuredContent ?? null, payment: receipt }
    return { status: "uncertain", detail: "receipt_missing", result: null, payment: null }
  }
  const xerr = meta["x402/error"] as { error?: unknown } | undefined
  if (xerr) return { status: "uncertain", detail: reasonCode(xerr.error, "payment_failed"), result: null, payment: null }
  // A tool-level error: withX402 settles only a non-error result, so nothing was charged.
  const text = r?.content?.find((c) => c.type === "text")?.text
  const body = parseJson<Record<string, unknown>>(text)
  if (body && body.in_scope === false) return { status: "refused", detail: "out_of_scope", result: body, payment: null }
  return { status: "pending", detail: "audit_failed_uncharged", result: null, payment: null }
}

function verdictSummary(audit: Record<string, unknown> | null): Record<string, unknown> {
  if (!audit) return {}
  const pick: Record<string, unknown> = {}
  for (const k of ["verdict", "action", "risk_score", "verdict_hash", "halt_reason", "fail_reason"]) if (audit[k] !== undefined) pick[k] = audit[k]
  if (Array.isArray(audit.flags)) pick.flags = (audit.flags as unknown[]).map((f) => (f && typeof f === "object" ? (f as { code?: unknown }).code : f)).filter((c) => typeof c === "string")
  const cert = audit.pol_certificate as Record<string, unknown> | undefined
  if (cert && typeof cert.irys_id === "string") pick.certificate = cert.irys_id
  return pick
}

function jsonRes(o: unknown, status: number): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}

/** POST /pay/:id with {payment: base64 x402 payload}. */
export async function handlePayPost(req: Request, db: PayDB | undefined, id: string, deps: PayDeps, now: () => Date): Promise<Response> {
  if (!PAY_SESSION_RE.test(id)) return jsonRes({ status: "not_found" }, 404)
  if (!db) return jsonRes({ status: "unavailable", charged: false }, 503)
  let payment: unknown
  try {
    const raw = await req.text()
    if (raw.length > MAX_PAYMENT_BYTES + 64) return jsonRes({ status: "bad_request", detail: "body_too_large", charged: false }, 413)
    payment = (JSON.parse(raw) as { payment?: unknown }).payment
  } catch {
    return jsonRes({ status: "bad_request", detail: "invalid_json", charged: false }, 400)
  }
  if (typeof payment !== "string" || payment.length < 16 || payment.length > MAX_PAYMENT_BYTES || !/^[A-Za-z0-9+/=_-]+$/.test(payment)) {
    return jsonRes({ status: "bad_request", detail: "malformed_payment", charged: false }, 400)
  }

  const row = await loadRow(db, id)
  if (!row) return jsonRes({ status: "not_found" }, 404)
  const st = effectiveStatus(row, now())
  if (st === "paid") return jsonRes({ status: "paid", already: true, charged: true, ...verdictSummary(parseJson<Record<string, unknown>>(row.result)), payment: parseJson<Record<string, unknown>>(row.payment) }, 200)
  if (st === "refused") return jsonRes({ status: "refused", charged: false, reason: (parseJson<Record<string, unknown>>(row.result) ?? {}).reason ?? null }, 200)
  if (st === "paying") return jsonRes({ status: "processing" }, 409)
  if (st === "uncertain") return jsonRes({ status: "uncertain", charged: null, remediation: UNCERTAIN_REMEDIATION }, 409)
  if (st === "expired") return jsonRes({ status: "expired", charged: false }, 410)
  if (!isPaidTool(row.tool)) return jsonRes({ status: "unavailable", charged: false }, 500)

  // 1. Verify the signed authorization before claiming the session. Nothing moves; a bad signature, an expired
  //    window or an underfunded wallet is answered here with the facilitator's own reason, and the link stays payable.
  let pre: PayPreflight
  try {
    pre = await deps.preflight(row.tool, payment)
  } catch {
    // The facilitator could not be asked. Nothing was claimed and nothing moved.
    return jsonRes({ status: "pending", charged: false, detail: "facilitator_unavailable" }, 503)
  }
  if (!pre.ok) return jsonRes({ status: "pending", charged: false, detail: reasonCode(pre.code, "payment_invalid") }, 402)

  // 2. Claim: pending -> paying, atomically. A second tab loses here and is told the payment is in progress.
  const claimedAt = now().toISOString()
  const claim = await db
    .prepare("UPDATE pay_session SET status = 'paying', updated_at = ?, detail = NULL WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id")
    .bind(claimedAt, id, claimedAt)
    .first<{ id: string }>()
  if (!claim) return jsonRes({ status: "processing" }, 409)

  // 3. The paid call itself. From here on, an exception means we cannot say whether the payment settled.
  let outcome: ReturnType<typeof classifyPaidResult>
  try {
    const args = parseJson<Record<string, unknown>>(row.args) ?? {}
    outcome = classifyPaidResult(await deps.callPaidTool(row.tool, args, payment))
  } catch {
    outcome = { status: "uncertain", detail: "settlement_uncertain", result: null, payment: null }
  }
  const done = now().toISOString()
  await db
    .prepare("UPDATE pay_session SET status = ?, updated_at = ?, result = ?, payment = ?, detail = ? WHERE id = ?")
    .bind(outcome.status, done, outcome.result === null ? null : JSON.stringify(outcome.result), outcome.payment === null ? null : JSON.stringify(outcome.payment), outcome.detail, id)
    .run()

  switch (outcome.status) {
    case "paid":
      return jsonRes({ status: "paid", charged: true, ...verdictSummary(outcome.result as Record<string, unknown>), payment: outcome.payment }, 200)
    case "refused":
      return jsonRes({ status: "refused", charged: false, reason: (outcome.result as Record<string, unknown>)?.reason ?? null }, 200)
    case "pending":
      return jsonRes({ status: "pending", charged: false, detail: outcome.detail }, 503)
    default:
      return jsonRes({ status: "uncertain", charged: null, detail: outcome.detail, remediation: UNCERTAIN_REMEDIATION }, 502)
  }
}

/** Daily cron: drop sessions whose link expired more than PAY_SESSION_RETENTION_MS ago. Never throws. */
export async function prunePaySessions(db: PayDB | undefined, now: Date): Promise<void> {
  if (!db) return
  try {
    await ensureSchema(db)
    await db.prepare("DELETE FROM pay_session WHERE expires_at < ?").bind(new Date(now.getTime() - PAY_SESSION_RETENTION_MS).toISOString()).run()
  } catch {
    // housekeeping only
  }
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // No script-src restriction on purpose: wallet extensions inject their provider into the page, and a strict
  // script policy has broken that injection before. Framing is what a payment page must refuse.
  "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-robots-tag": "noindex, nofollow",
}

const STYLE = `
:root{--canvas:#0A0A0A;--panel:#0D0D0D;--rule:#1C1C1C;--text:#E6E6E6;--muted:#8A8A8A;--pass:#3DFF88;--wait:#FFB000;--fail:#FF4D4D;
--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--text);font-family:var(--mono);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:28px 16px 64px}
.boot{border:1px solid var(--rule);padding:12px 16px;color:var(--muted);font-size:12.5px}
.boot b{color:var(--pass);font-weight:600}
h1{font-size:22px;line-height:1.3;margin:28px 0 8px}
p{margin:0 0 14px}
.muted{color:var(--muted)}
.label{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 6px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;background:var(--panel);border:1px solid var(--rule);padding:14px 16px;font-family:var(--mono);font-size:14px}
.rows{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:18px 0;font-size:14px}
.rows span{color:var(--muted)}
.rows b{font-weight:500;word-break:break-all}
button,select{font-family:var(--mono);font-size:15px;border-radius:0}
button{background:var(--pass);color:var(--canvas);border:0;padding:14px 18px;font-weight:700;cursor:pointer;width:100%;margin-top:8px}
button:disabled{background:var(--rule);color:var(--muted);cursor:default}
select{background:var(--panel);color:var(--text);border:1px solid var(--rule);padding:10px;width:100%;margin-top:8px}
#log{min-height:1.7em;margin-top:14px}
.ok{color:var(--pass)}.warn{color:var(--wait)}.bad{color:var(--fail)}
.stamp{font-size:28px;font-weight:700;letter-spacing:.04em}
.note{border-top:1px solid var(--rule);margin-top:28px;padding-top:14px;color:var(--muted);font-size:13px}
a{color:var(--pass);text-decoration:none}a:hover{background:var(--pass);color:var(--canvas)}
:focus-visible{outline:2px solid var(--pass);outline-offset:3px}
@media (max-width:480px){.rows{grid-template-columns:1fr}.rows span{margin-top:6px}}
`

function shell(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" href="https://djzs.ai/favicon.svg"><style>${STYLE}</style></head>` +
    `<body><main class="wrap"><div class="boot">&gt;_ <b>DJZS</b> // AUDIT BEFORE ACT</div>${body}</main></body></html>`
  return new Response(html, { status, headers: PAGE_HEADERS })
}

const KIND_LABEL: Record<string, string> = { verify_pm_trade: "Prediction-market bet", verify_perp_trade: "Perpetual or spot trade" }

/** The thesis as stored, and the grid rows that describe the check (callers put them in one grid). */
function thesisBlock(row: SessionRow): { thesis: string; rows: string } {
  const args = parseJson<Record<string, unknown>>(row.args) ?? {}
  const agent = typeof args.agent_address === "string" ? `<span>Trust score</span><b>also recorded for agent ${esc(args.agent_address)}</b>` : ""
  return {
    thesis: `<div class="label">The exact thesis you are paying to audit</div><pre>${esc(args.intent)}</pre>`,
    rows: `<span>Check</span><b>${esc(KIND_LABEL[row.tool] ?? row.tool)}</b>${agent}`,
  }
}
const withRows = (t: { thesis: string; rows: string }) => `${t.thesis}<div class="rows">${t.rows}</div>`

/** GET /pay/:id */
export async function handlePayPage(db: PayDB | undefined, id: string, now: Date, expect: PayExpect): Promise<Response> {
  const gone = (msg: string, status: number) => shell("DJZS payment link", `<h1>${esc(msg)}</h1><p class="muted">Ask your assistant to run the audit again for a new link.</p>`, status)
  if (!PAY_SESSION_RE.test(id)) return gone("This payment link does not exist.", 404)
  if (!db) return gone("Payment links are unavailable right now. Nothing was charged.", 503)
  const row = await loadRow(db, id)
  if (!row) return gone("This payment link does not exist.", 404)
  const st = effectiveStatus(row, now)

  if (st === "paid") {
    const v = verdictSummary(parseJson<Record<string, unknown>>(row.result))
    const cls = v.verdict === "PASS" ? "ok" : v.verdict === "WAIT" ? "warn" : "bad"
    return shell("DJZS audit paid", `<h1>Paid. The audit is done.</h1>${withRows(thesisBlock(row))}` +
      `<div class="stamp ${cls}">${esc(v.verdict ?? "")}</div><p class="muted">risk score ${esc(v.risk_score ?? "")}</p>` +
      `<p>Go back to your chat and say you paid. It collects the full result and the receipt.</p>`, 200)
  }
  if (st === "refused") return shell("DJZS audit refused", `<h1>Refused as out of scope. Nothing was charged.</h1>${withRows(thesisBlock(row))}<p>It was sent to the wrong check. Ask your assistant to use the other one.</p>`, 200)
  if (st === "paying") return shell("DJZS payment in progress", `<h1>Payment in progress.</h1><p>Do not pay again. Go back to your chat and say you paid.</p>`, 200)
  if (st === "uncertain") return shell("DJZS payment not confirmed", `<h1 class="warn">The payment could not be confirmed.</h1><p>${esc(UNCERTAIN_REMEDIATION)}</p><p class="muted">pay_session ${esc(id)}</p>`, 200)
  if (st === "expired") return gone("This payment link has expired. Nothing was charged.", 410)

  const accepts = parseJson<unknown[]>(row.accepts) ?? []
  const data = JSON.stringify({ accepts, resource: parseJson(row.resource), expect }).replace(/</g, "\\u003c")
  const expires = row.expires_at.replace("T", " ").slice(0, 16) + " UTC"
  const t = thesisBlock(row)
  const body =
    `<h1>Pay 2.00 USDC to run this audit</h1>` +
    `<p>Your assistant asked DJZS to check a trade thesis. Pay here from your own wallet, then go back to your chat. The verdict and the receipt come back there.</p>` +
    t.thesis +
    `<div class="rows">${t.rows}<span>Price</span><b>2.00 USDC on Base</b><span>Paid to</span><b>DJZS treasury ${esc(expect.payTo)}</b><span>Link expires</span><b>${esc(expires)}</b></div>` +
    `<select id="wallet" hidden aria-label="Choose a wallet"></select>` +
    `<button id="pay" type="button">Connect wallet and pay 2.00 USDC</button>` +
    `<noscript><p class="warn">Paying needs JavaScript and a browser wallet such as Coinbase Wallet, Rabby or MetaMask.</p></noscript>` +
    `<div id="log" role="status" aria-live="polite"></div><div id="result"></div>` +
    `<div class="note">You sign one USDC authorization for exactly 2.00, payable only to the address above. Nothing is charged if the thesis is refused as out of scope or the audit cannot run. A paid audit anchors a permanent certificate. A verdict grades the reasoning, not the outcome, and is not financial advice.</div>` +
    `<script type="application/json" id="d">${data}</script><script>${PAGE_SCRIPT}</script>`
  return shell("Pay for a DJZS audit", body, 200)
}

// Runs in the browser. Plain ES2017, no imports: the page has to work with nothing but a wallet extension.
const PAGE_SCRIPT = `
(function(){
var D=JSON.parse(document.getElementById("d").textContent);
function $(i){return document.getElementById(i)}
function say(t,c){var el=$("log");el.textContent=t;el.className=c||""}
var found=[];
window.addEventListener("eip6963:announceProvider",function(e){if(!found.some(function(p){return p.info.uuid===e.detail.info.uuid})){found.push(e.detail);pickList()}});
window.dispatchEvent(new Event("eip6963:requestProvider"));
function pickList(){var s=$("wallet");if(found.length<2){s.hidden=true;return}s.innerHTML="";found.forEach(function(p,i){var o=document.createElement("option");o.value=String(i);o.textContent=p.info.name;s.appendChild(o)});s.hidden=false}
function provider(){if(found.length>=2)return found[Number($("wallet").value)||0].provider;if(found.length===1)return found[0].provider;return window.ethereum||null}
function hex32(){var a=new Uint8Array(32);crypto.getRandomValues(a);var h="0x";for(var i=0;i<a.length;i++)h+=(a[i]<16?"0":"")+a[i].toString(16);return h}
function b64(s){var b=new TextEncoder().encode(s),t="";for(var i=0;i<b.length;i++)t+=String.fromCharCode(b[i]);return btoa(t)}
function walletErr(e){if(e&&e.code===4001)return "You rejected the request in your wallet. Nothing was charged.";return (e&&e.message)?e.message:String(e)}
function show(out){
  var r=$("result");r.textContent="";
  if(out.status==="paid"){
    var s=document.createElement("div");s.className="stamp "+(out.verdict==="PASS"?"ok":out.verdict==="WAIT"?"warn":"bad");s.textContent=out.verdict||"";r.appendChild(s);
    var p=document.createElement("p");p.className="muted";p.textContent="risk score "+(out.risk_score==null?"":out.risk_score)+(out.payment&&out.payment.transaction?", payment tx "+out.payment.transaction.slice(0,10)+"...":"");r.appendChild(p);
    say("Paid. Go back to your chat and say you paid. It collects the full result and the receipt.","ok");$("pay").disabled=true;return}
  if(out.status==="refused"){say("Refused as out of scope. Nothing was charged. Ask your assistant to use the other check.","warn");$("pay").disabled=true;return}
  if(out.status==="processing"){say("A payment for this link is already in progress. Do not pay again.","warn");$("pay").disabled=true;return}
  if(out.status==="expired"){say("This link expired. Nothing was charged. Ask your assistant for a new link.","bad");$("pay").disabled=true;return}
  if(out.status==="uncertain"){say(out.remediation||"The payment could not be confirmed. Check your wallet before paying again.","bad");$("pay").disabled=true;return}
  if(out.detail==="invalid_exact_evm_payload_authorization_valid_before"){say("The signature expired before it reached the check. Nothing was charged. Try again and confirm in your wallet within 5 minutes.","bad");return}
  if(out.detail==="audit_failed_uncharged"){say("The audit could not run, so the payment was not taken. Nothing was charged. Try again in a minute.","bad");return}
  say("Payment not accepted"+(out.detail?" ("+out.detail+")":"")+". Nothing was charged. Check that the wallet holds 2.00 USDC on Base, then try again.","bad")}
$("pay").addEventListener("click",function(){
  var btn=$("pay");btn.disabled=true;
  (async function(){
    var acc=(D.accepts||[])[0],E=D.expect;
    if(!acc||acc.scheme!=="exact"||acc.network!==E.network||String(acc.amount)!==E.amount||String(acc.asset).toLowerCase()!==E.asset.toLowerCase()||String(acc.payTo).toLowerCase()!==E.payTo.toLowerCase()||!acc.extra||!acc.extra.name||!acc.extra.version)
      throw new Error("The quote on this page is not 2.00 USDC to the DJZS treasury on Base. Nothing was signed.");
    var pv=provider();if(!pv)throw new Error("No browser wallet found. Install Coinbase Wallet, Rabby or MetaMask, then reload this page.");
    say("Connecting your wallet...");
    var accounts=await pv.request({method:"eth_requestAccounts"});var from=accounts&&accounts[0];if(!from)throw new Error("The wallet returned no account.");
    say("Switching to Base...");
    var cid=await pv.request({method:"eth_chainId"});
    if(parseInt(cid,16)!==E.chainId){try{await pv.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x2105"}]})}catch(e){if(e&&e.code===4902){await pv.request({method:"wallet_addEthereumChain",params:[{chainId:"0x2105",chainName:"Base",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://mainnet.base.org"],blockExplorerUrls:["https://basescan.org"]}]})}else throw e}}
    var now=Math.floor(Date.now()/1000);
    var auth={from:from,to:acc.payTo,value:String(acc.amount),validAfter:"0",validBefore:String(now+Number(acc.maxTimeoutSeconds||300)),nonce:hex32()};
    var typed={types:{EIP712Domain:[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],
      TransferWithAuthorization:[{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}]},
      primaryType:"TransferWithAuthorization",domain:{name:acc.extra.name,version:acc.extra.version,chainId:E.chainId,verifyingContract:acc.asset},message:auth};
    say("Sign the 2.00 USDC authorization in your wallet...");
    var signature=await pv.request({method:"eth_signTypedData_v4",params:[from,JSON.stringify(typed)]});
    var payment=b64(JSON.stringify({x402Version:2,resource:D.resource,accepted:acc,payload:{authorization:auth,signature:signature}}));
    say("Paying and running the audit. This can take up to a minute. Keep this page open...");
    var res=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payment:payment})});
    var out=null;try{out=await res.json()}catch(e){}
    if(!out)throw new Error("The server answered "+res.status+" without a result. If 2.00 USDC left your wallet, do not pay again.");
    show(out);if(out.status==="pending")btn.disabled=false;
  })().catch(function(e){say(walletErr(e),"bad");btn.disabled=false});
});
})();
`
