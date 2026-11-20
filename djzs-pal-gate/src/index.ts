/**
 * djzs-pal-gate - a deterministic gate between a conversational agent and one money action.
 *
 * A Tavus PAL (or any agent that can call an HTTPS tool) asks to move USDC. This Worker is the only
 * thing between that request and the action. The model proposes; TypeScript decides (ruleset.ts);
 * every decision is recorded with the hashes to recompute it (intent.ts, store.ts).
 *
 * FOUR RULES THE TAVUS TOOL CONTRACT FORCES, and where each one lives:
 *
 *   1. A REFUSAL IS A SUCCESSFUL RESPONSE. Tavus feeds a tool result to the agent only on a 2xx; on
 *      any other status the agent just says the tool failed. So PASS, WAIT and FAIL all answer 200
 *      and the body is the sentence to speak. Non-2xx is reserved for "this was not a valid Tavus
 *      call" (bad signature, malformed envelope) and for the gate being unable to decide at all.
 *   2. NO HUMAN APPROVAL INSIDE THE CALL. A tool call may take at most 60 seconds. A request that
 *      needs a person is HELD and answered at once; the person resolves it later (/operator).
 *   3. NOTHING IRREVERSIBLE DURING THE CONVERSATION. A PASS reserves and stops. Execution happens
 *      when Tavus fires the post-call action (/tavus/post-call/settle), or when a person approves.
 *   4. THE AGENT ONLY HAS GATED TOOLS. Nothing here can enforce that; it is a property of the PAL's
 *      tool list. pal/ holds the two tool definitions, and the README says what must not be attached.
 *
 * GATE ORDER on the tool route, cheapest refusal first: configured -> size -> signature (raw
 * bytes) -> envelope -> store -> decide. The body is never parsed before its signature is checked.
 *
 * ROUTES
 *   GET  /health                               what is configured (booleans and public settings only)
 *   POST /tavus/tool/request_transfer          the gated tool. HMAC. 200 text/plain = the line to speak
 *                                              (?format=json for the full decision instead)
 *   POST /tavus/post-call/settle               the post-call action. HMAC. Executes this conversation's approvals
 *   GET  /ledger            /ledger/:id        the public record: every decision, with its preimages
 *   POST /operator/claims                      issue a claim                 (Bearer OPERATOR_KEY)
 *   POST /operator/claims/:id/void             cancel an open claim
 *   GET  /operator/holds                       requests waiting for a person
 *   GET  /operator/unsettled                   approved or mid-execution, not finished
 *   POST /operator/decisions/:id/resolve       { "action": "approve" | "deny" }
 *   POST /operator/conversations/:id/settle    run the post-call door by hand
 *
 * GATE_MODE IS THE KILL SWITCH. Anything but "open": tool calls answer WAIT, and every route that
 * would call an executor answers 409 gate_closed. Reading, issuing, voiding and denying still work.
 */
import { Hono, type Context } from "hono"
import { executorFor } from "./executor"
import { fault, json, logFault } from "./faults"
import { decideTransfer, gateOpen, resolveDecision, settleConversation, type GateVars } from "./gate"
import { canonicalCode, sha256Hex } from "./intent"
import { formatUsdc, microToNumber, numberToMicro, parseMicroVar, parseUsdc } from "./money"
import { RULESET_VERSION } from "./ruleset"
import { ensureSchema, getDecision, heldDecisions, insertClaim, recentDecisions, unsettledDecisions, voidClaim, type D1Like, type DecisionRow } from "./store"
import { MAX_BODY_BYTES, parseEnvelope, parsePostCallEnvelope, verifyTavusSignature } from "./tavus"

export interface Env extends GateVars {
  /** D1. Absent => every stateful route answers 503 store_unavailable. */
  DB?: D1Like
  /** Secret. The shared secret Tavus signs tool calls with. Absent => 503 gate_not_configured. */
  TAVUS_TOOL_SECRET?: string
  /** Secret. Bearer key for /operator. Absent => 503 operator_not_configured. */
  OPERATOR_KEY?: string
}

type Ctx = Context<{ Bindings: Env }>

// Not exported: workerd requires every named export of the entry module to be a handler, and
// refuses to start the Worker otherwise (test/bundle.test.mjs runs the built bundle to hold this).
const TOOL_NAME = "request_transfer"
const POST_CALL_TOOL_NAME = "settle_after_call"

const PUBLIC_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
}

// ── shared steps ──────────────────────────────────────────────────────────────────────────

type Parsed<E> = { ok: true; envelope: E } | { ok: false; error: "invalid_json" | "bad_envelope" }

/** Steps 1 to 4 of the gate order. Returns the verified envelope or the refusal to send. */
async function verifiedEnvelope<E extends { name: string }>(
  c: Ctx,
  expectedTool: string,
  parse: (raw: ArrayBuffer) => Parsed<E>,
): Promise<{ envelope: E } | { refusal: Response }> {
  const secret = c.env.TAVUS_TOOL_SECRET
  if (!secret) return { refusal: fault("gate_not_configured", 503) }
  const declared = Number(c.req.header("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { refusal: fault("body_too_large", 413) }
  const raw = await c.req.raw.arrayBuffer()
  if (raw.byteLength > MAX_BODY_BYTES) return { refusal: fault("body_too_large", 413) }
  if (!(await verifyTavusSignature(secret, raw, c.req.header("x-tavus-signature")))) return { refusal: fault("bad_signature", 401) }
  const parsed = parse(raw)
  if (!parsed.ok) return { refusal: fault(parsed.error, 400) }
  if (parsed.envelope.name !== expectedTool) return { refusal: fault("wrong_tool", 400, { expected: expectedTool }) }
  return { envelope: parsed.envelope }
}

async function store(c: Ctx): Promise<{ db: D1Like } | { refusal: Response }> {
  const db = c.env.DB
  if (!db) return { refusal: fault("store_unavailable", 503) }
  try {
    await ensureSchema(db)
  } catch (e) {
    logFault("ensureSchema", e)
    return { refusal: fault("store_error", 503) }
  }
  return { db }
}

/** Constant-time comparison of two strings through their digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  return diff === 0
}

async function operator(c: Ctx): Promise<Response | null> {
  const key = c.env.OPERATOR_KEY
  if (!key) return fault("operator_not_configured", 503)
  const header = c.req.header("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (presented === "" || !(await sameSecret(presented, key))) return fault("unauthorized", 401)
  return null
}

/** What a public route may show of a decision. No claim code, no Tavus ids, no reason text (none is stored). */
function publicDecision(r: DecisionRow) {
  return {
    id: r.id,
    ts: r.ts,
    state: r.state,
    verdict: r.verdict,
    disposition: r.disposition,
    flags: r.flags ? r.flags.split(",") : [],
    ruleset: r.ruleset,
    recipient: r.recipient,
    amount_usdc: r.amount_micro === null ? null : formatUsdc(numberToMicro(r.amount_micro)),
    amount_micro: r.amount_micro,
    conversation: r.conversation_tag,
    args_sha256: r.args_sha256,
    intent_preimage: r.intent_preimage,
    intent_sha256: r.intent_sha256,
    decision_preimage: r.decision_preimage,
    decision_sha256: r.decision_sha256,
    resolved_by: r.resolved_by,
    resolved_at: r.resolved_at,
    execution: r.execution ? (JSON.parse(r.execution) as unknown) : null,
    /** v0.1 writes no on-chain attestation. The two sha256 hashes above are the receipt. */
    attested: false,
  }
}

/** What the operator sees: the public view plus the claim code and the Tavus ids needed to act on it. */
function operatorDecision(r: DecisionRow) {
  return { ...publicDecision(r), claim_code: r.claim_id ? formatCode(r.claim_id) : null, conversation_id: r.conversation_id, tool_call_id: r.tool_call_id }
}

function formatCode(id: string): string {
  return id.startsWith("PG") && id.length === 18 ? `PG-${id.slice(2, 6)}-${id.slice(6, 10)}-${id.slice(10, 14)}-${id.slice(14, 18)}` : id
}

/** "PG" + 16 symbols of Crockford base32 from 16 random bytes: 80 bits. */
function newClaimId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = "PG"
  for (const b of bytes) out += alphabet[b & 31]
  return out
}

// ── app ───────────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) =>
  c.text(
    [
      "djzs-pal-gate",
      "A deterministic gate between a conversational agent and one money action.",
      "The model proposes. TypeScript decides. Every decision is recorded.",
      "",
      `ruleset: ${RULESET_VERSION}`,
      "record:  GET /ledger",
      "status:  GET /health",
    ].join("\n"),
  ),
)

app.get("/health", (c) => {
  const executor = executorFor(c.env.EXECUTOR)
  return json({
    ok: true,
    service: "djzs-pal-gate",
    ruleset: RULESET_VERSION,
    gate_mode: gateOpen(c.env) ? "open" : "closed",
    executor: executor ? executor.mode : null,
    moves_funds: executor ? !executor.dry_run : false,
    store_bound: Boolean(c.env.DB),
    tavus_secret_set: Boolean(c.env.TAVUS_TOOL_SECRET),
    operator_key_set: Boolean(c.env.OPERATOR_KEY),
    limits: {
      auto_limit_usdc: formatUsdc(parseMicroVar(c.env.AUTO_LIMIT_MICRO)),
      daily_budget_usdc: formatUsdc(parseMicroVar(c.env.DAILY_BUDGET_MICRO)),
    },
    attested: false,
  })
})

app.post("/tavus/tool/request_transfer", async (c) => {
  const v = await verifiedEnvelope(c, TOOL_NAME, parseEnvelope)
  if ("refusal" in v) return v.refusal
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  let row: DecisionRow
  try {
    row = await decideTransfer(s.db, c.env, v.envelope)
  } catch (e) {
    // 5xx on purpose: Tavus retries once, and the retry resumes the same decision row.
    logFault("decideTransfer", e)
    return fault("store_error", 503)
  }
  const headers: Record<string, string> = {
    "x-palgate-decision": row.id,
    "x-palgate-verdict": row.verdict ?? "",
    "x-palgate-disposition": row.disposition ?? "",
    "x-palgate-ruleset": row.ruleset ?? "",
    "cache-control": "no-store",
  }
  if (c.req.query("format") === "json") return json({ ok: true, say: row.say, decision: publicDecision(row) }, 200, headers)
  // Rule 1: the body IS the sentence, for on_resolve "response_in_result". Always 200.
  return new Response(row.say ?? "", { status: 200, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } })
})

app.post("/tavus/post-call/settle", async (c) => {
  const v = await verifiedEnvelope(c, POST_CALL_TOOL_NAME, parsePostCallEnvelope)
  if ("refusal" in v) return v.refusal
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  try {
    const out = await settleConversation(s.db, c.env, v.envelope.conversation_id)
    // A closed gate is a 409, so Tavus does not retry into it. A missing executor is a 503 like
    // every other misconfiguration; Tavus retries that once and gets the same answer.
    if (!out.ok) return fault(out.error, out.error === "gate_closed" ? 409 : 503)
    return json({ ok: true, ...out.summary })
  } catch (e) {
    logFault("settleConversation", e)
    return fault("store_error", 503)
  }
})

// ── the public record ─────────────────────────────────────────────────────────────────────

app.options("/ledger", () => new Response(null, { status: 204, headers: PUBLIC_CORS }))
app.options("/ledger/:id", () => new Response(null, { status: 204, headers: PUBLIC_CORS }))

app.get("/ledger", async (c) => {
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const n = Number(c.req.query("limit") ?? "50")
  const limit = Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50
  const rows = await recentDecisions(s.db, limit)
  return json({ ok: true, ruleset: RULESET_VERSION, count: rows.length, decisions: rows.map(publicDecision) }, 200, PUBLIC_CORS)
})

app.get("/ledger/:id", async (c) => {
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const row = await getDecision(s.db, c.req.param("id"))
  if (!row || row.state === "pending") return fault("not_found", 404)
  return json({ ok: true, decision: publicDecision(row) }, 200, PUBLIC_CORS)
})

// ── the operator ──────────────────────────────────────────────────────────────────────────

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json()
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

app.post("/operator/claims", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const body = await jsonBody(c)
  if (!body) return fault("invalid_json", 400)

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : ""
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) return fault("bad_request", 400, { field: "recipient" })
  const amount = parseUsdc(body.amount_usdc)
  if (amount.state !== "present") return fault("bad_request", 400, { field: "amount_usdc" })

  let expires_at: string | null = null
  if (body.expires_at !== undefined && body.expires_at !== null) {
    const t = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN
    if (!Number.isFinite(t) || t <= Date.now()) return fault("bad_request", 400, { field: "expires_at" })
    expires_at = new Date(t).toISOString() // one format, so expiry compares as text
  }

  let id: string
  if (body.id === undefined || body.id === null) id = newClaimId()
  else {
    const given = typeof body.id === "string" ? canonicalCode(body.id) : null
    if (!given) return fault("bad_request", 400, { field: "id" })
    id = given
  }

  const issued_at = new Date().toISOString()
  const created = await insertClaim(s.db, { id, recipient: recipient.toLowerCase(), amount_micro: microToNumber(amount.micro), expires_at, issued_at })
  if (!created) return fault("conflict", 409)
  return json({ ok: true, claim: { id, code: formatCode(id), recipient: recipient.toLowerCase(), amount_usdc: formatUsdc(amount.micro), expires_at, issued_at, state: "open" } }, 201)
})

app.post("/operator/claims/:id/void", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const id = canonicalCode(c.req.param("id"))
  if (!id) return fault("bad_request", 400, { field: "id" })
  if (!(await voidClaim(s.db, id))) return fault("conflict", 409)
  return json({ ok: true, id, state: "void" })
})

app.get("/operator/holds", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const rows = await heldDecisions(s.db)
  // The operator sees the claim code and the Tavus ids; the public ledger never does.
  return json({ ok: true, count: rows.length, holds: rows.map(operatorDecision) })
})

app.get("/operator/unsettled", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const rows = await unsettledDecisions(s.db)
  return json({ ok: true, count: rows.length, unsettled: rows.map(operatorDecision) })
})

app.post("/operator/decisions/:id/resolve", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const body = await jsonBody(c)
  const action = body?.action
  if (action !== "approve" && action !== "deny") return fault("bad_request", 400, { field: "action", allowed: ["approve", "deny"] })
  const out = await resolveDecision(s.db, c.env, c.req.param("id"), action)
  if (!out.ok) return fault(out.error, out.error === "not_found" ? 404 : out.error === "executor_unavailable" ? 503 : 409)
  return json({ ok: true, decision: publicDecision(out.decision) })
})

app.post("/operator/conversations/:id/settle", async (c) => {
  const denied = await operator(c)
  if (denied) return denied
  const s = await store(c)
  if ("refusal" in s) return s.refusal
  const out = await settleConversation(s.db, c.env, c.req.param("id"))
  if (!out.ok) return fault(out.error, out.error === "gate_closed" ? 409 : 503)
  return json({ ok: true, ...out.summary })
})

app.notFound(() => fault("not_found", 404))
app.onError((e) => {
  logFault("onError", e)
  return fault("internal_error", 500)
})

export default app
