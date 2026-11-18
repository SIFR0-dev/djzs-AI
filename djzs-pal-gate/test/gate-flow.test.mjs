/**
 * The gate, end to end: signed Tavus tool calls through the real routes into a REAL D1 (Miniflare's
 * SQLite, the same engine production runs), with the dry-run executor. Offline. The secrets here
 * are throwaway strings made up in this file; nothing is funded and nothing leaves the process.
 *
 * Why a real D1 and not a fake: the guarantees that matter are in the SQL (one claim, one
 * approval; one tool call, one decision; the budget checked inside the write). A fake that
 * "understands" those statements would be testing itself.
 *
 * Pins:
 *   FAIL CLOSED   no secret, no store, a bad signature, a closed gate or an unknown executor each
 *                 refuse before anything is approved; a mistyped GATE_MODE is closed, not open.
 *   KILL SWITCH   while the gate is closed no route calls an executor: the post-call action, the
 *                 operator's settle and the operator's approve all answer 409 and change nothing.
 *   A CODE IS NOT A KEY   a stranger who knows a real claim code cannot spend it on a smaller
 *                 amount or a different address; the claim stays open for the person it is for.
 *   RULE 1        PASS, WAIT and FAIL all answer 200 text/plain: the body is the sentence to speak.
 *                 Spoken lines carry no flag codes.
 *   RULE 2        a request beyond the limits is HELD and answered at once; a person approves or
 *                 denies it later; an approval by a person does not consume the automatic budget.
 *   RULE 3        a PASS reserves the claim and executes NOTHING; execution happens at the post-call
 *                 action, once, for that conversation only.
 *   ONE CLAIM, ONE APPROVAL   12 concurrent requests citing one claim: exactly one PASS.
 *   ONE CALL, ONE DECISION    a replay or 6 concurrent deliveries of one tool_call_id: one row, one answer.
 *                             The key is (conversation, tool_call_id): the same id in another conversation
 *                             is another call.
 *   NO APPROVAL IS STRANDED   an approval whose post-call action never came is visible to the operator
 *                             and can be settled or denied; a denial frees the claim and the budget.
 *   THE BUDGET HOLDS UNDER RACE  5 concurrent valid requests against a budget of 2: exactly 2 PASS.
 *   THE RECORD    every ledger row recomputes from its published preimages; no public route
 *                 returns a claim code, a Tavus id or reason text; no response carries raw error text.
 *
 * Run: npx tsx test/gate-flow.test.mjs
 */
import { createHash, createHmac } from "node:crypto"
import { Miniflare } from "miniflare"
import app from "../src/index.ts"

setTimeout(() => { console.error("GATE-FLOW: TIMEOUT after 240s"); process.exit(1) }, 240_000).unref()

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}

const SECRET = "test-only-tavus-secret"
const OPKEY = "test-only-operator-key"
const A = "0x" + "a".repeat(40)
const B = "0x" + "b".repeat(40)
const FLAG_WORDS = /GATE_CLOSED|_INVALID|_UNKNOWN|_VOID|_REDEEMED|_IN_USE|_EXPIRED|_MISMATCH|_ABSENT|OVER_AUTO|BUDGET_EXHAUSTED/

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  d1Databases: { A: "pg-a", B: "pg-b", C: "pg-c", C2: "pg-c2", D: "pg-d", E: "pg-e", F: "pg-f" },
})
const DB_KEYS = ["A", "B", "C", "C2", "D", "E", "F"]
const dbs = {}
for (const k of DB_KEYS) dbs[k] = await mf.getD1Database(k)

const baseEnv = (db, over = {}) => ({ DB: db, TAVUS_TOOL_SECRET: SECRET, OPERATOR_KEY: OPKEY, GATE_MODE: "open", EXECUTOR: "dry_run", AUTO_LIMIT_MICRO: "1000000", DAILY_BUDGET_MICRO: "5000000", ...over })
const sha256 = (s) => createHash("sha256").update(s).digest("hex")
const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex")

let seq = 0
/** A signed Tavus callback, keys sorted the way Tavus sends them. */
function envelope({ name = "request_transfer", args = {}, tool_call_id, conversation_id = "c_main" } = {}) {
  return JSON.stringify({ arguments: typeof args === "string" ? args : JSON.stringify(args), conversation_id, inference_id: "inf_1", name, tool_call_id: tool_call_id ?? `call_${++seq}`, turn_idx: 1 })
}
async function post(path, body, env, { signature, headers = {} } = {}) {
  const res = await app.fetch(new Request(`https://gate.test${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-tavus-signature": signature ?? sign(body) }), ...headers } }), env)
  const text = await res.text()
  let jsonBody = null
  try { jsonBody = JSON.parse(text) } catch { /* text/plain */ }
  return { status: res.status, text, json: jsonBody, headers: res.headers }
}
const tool = (env, opts = {}, q = "") => post(`/tavus/tool/request_transfer${q}`, envelope(opts), env)
async function op(env, method, path, body, key = OPKEY) {
  const res = await app.fetch(new Request(`https://gate.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }) } }), env)
  const text = await res.text()
  let jsonBody = null
  try { jsonBody = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, text, json: jsonBody }
}
async function get(env, path) {
  const res = await app.fetch(new Request(`https://gate.test${path}`), env)
  const text = await res.text()
  let jsonBody = null
  try { jsonBody = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, text, json: jsonBody, headers: res.headers }
}
async function issue(env, { recipient = A, amount_usdc = "1.00", id, expires_at } = {}) {
  const r = await op(env, "POST", "/operator/claims", { recipient, amount_usdc, ...(id ? { id } : {}), ...(expires_at ? { expires_at } : {}) })
  if (r.status !== 201) throw new Error(`issue claim failed: ${r.status} ${r.text}`)
  return r.json.claim
}
const claimRow = (db, id) => db.prepare("SELECT * FROM pg_claim WHERE id = ?").bind(id).first()
const decisionRow = (db, id) => db.prepare("SELECT * FROM pg_decision WHERE id = ?").bind(id).first()
const count = async (db, where = "1=1") => (await db.prepare(`SELECT COUNT(*) AS n FROM pg_decision WHERE ${where}`).bind().first()).n
const good = (code, over = {}) => ({ recipient: A, amount_usdc: "1.00", reference: code, reason: "raffle prize from the meetup", ...over })

// ════ 1. FAIL CLOSED ════════════════════════════════════════════════════════════════════
{
  const env = baseEnv(dbs.A)
  const body = envelope({ args: good("PGNOPE1234") })

  const noSecret = await post("/tavus/tool/request_transfer", body, baseEnv(dbs.A, { TAVUS_TOOL_SECRET: undefined }))
  check(1, "no TAVUS_TOOL_SECRET: 503 gate_not_configured", noSecret.status === 503 && noSecret.json?.error === "gate_not_configured", noSecret.text)

  const badSig = await post("/tavus/tool/request_transfer", body, env, { signature: sign(body, "wrong-secret") })
  const noSig = await post("/tavus/tool/request_transfer", body, env, { signature: null })
  check(2, "a wrong or missing signature: 401 bad_signature, and nothing is written", badSig.status === 401 && badSig.json?.error === "bad_signature" && noSig.status === 401 && (await dbs.A.prepare("SELECT name FROM sqlite_master WHERE name = 'pg_decision'").bind().first()) === null)

  const noDb = await post("/tavus/tool/request_transfer", body, baseEnv(undefined))
  check(3, "no D1 binding: 503 store_unavailable (an approval that cannot be recorded is not an approval)", noDb.status === 503 && noDb.json?.error === "store_unavailable", noDb.text)

  const wrongTool = await post("/tavus/tool/request_transfer", envelope({ name: "something_else" }), env)
  check(4, "a signed call for a different tool: 400 wrong_tool", wrongTool.status === 400 && wrongTool.json?.error === "wrong_tool", wrongTool.text)

  const big = JSON.stringify({ arguments: "x".repeat(20_000), conversation_id: "c", name: "request_transfer", tool_call_id: "t_big" })
  const tooBig = await post("/tavus/tool/request_transfer", big, env)
  check(5, "a body over 16 KiB: 413 body_too_large", tooBig.status === 413 && tooBig.json?.error === "body_too_large", tooBig.text)

  const notJson = "{this is not json"
  const bad = await post("/tavus/tool/request_transfer", notJson, env)
  check(6, "a signed body that is not JSON: 400 invalid_json", bad.status === 400 && bad.json?.error === "invalid_json", bad.text)

  // A perfectly valid request against each closed spelling. "OPEN" and " open" are typos, and typos are closed.
  const c = await issue(env)
  let closedOk = true
  for (const mode of [undefined, "closed", "OPEN", " open", "true", ""]) {
    const r = await tool(baseEnv(dbs.A, { GATE_MODE: mode }), { args: good(c.id) })
    if (!(r.status === 200 && r.headers.get("x-palgate-verdict") === "WAIT" && r.headers.get("x-palgate-disposition") === "CLOSED" && r.text === "The gate is closed right now, so nothing can be released.")) closedOk = false
  }
  const claim = await claimRow(dbs.A, c.id)
  check(7, "GATE_MODE unset, \"closed\" or mistyped: a valid request gets WAIT, and its claim is untouched", closedOk && claim.state === "open" && claim.reserved_by === null && (await count(dbs.A, "state = 'final' AND flags = 'GATE_CLOSED'")) === 6)
}

// ════ 2. THE THREE VERDICTS ═════════════════════════════════════════════════════════════
let passDecisionId = null
let passClaimId = null
{
  const env = baseEnv(dbs.B)

  const need = await tool(env, { args: { recipient: A, amount_usdc: "1.00" } })
  check(8, "WAIT, missing fields: 200 text/plain, and the line says what is still needed", need.status === 200 && (need.headers.get("content-type") ?? "").startsWith("text/plain") && need.headers.get("x-palgate-verdict") === "WAIT" && need.headers.get("x-palgate-disposition") === "NEEDS_INFO" && need.text === "I can't release anything yet. I still need the claim code this payout is based on and your reason for the payout.", need.text)

  const unknown = await tool(env, { args: good("PG-0000-0000-0000-0000") })
  check(9, "RULE 1: a refusal is a 200. FAIL, unknown code: the line is plain language with no flag code", unknown.status === 200 && unknown.headers.get("x-palgate-verdict") === "FAIL" && unknown.text === "Refused. That claim code is not in the records." && !FLAG_WORDS.test(unknown.text), unknown.text)

  const c1 = await issue(env)
  const mismatch = await tool(env, { args: good(c1.id, { recipient: B }) })
  check(10, "FAIL: a real code cited for a different address", mismatch.status === 200 && mismatch.headers.get("x-palgate-verdict") === "FAIL" && mismatch.text === "Refused. That claim code belongs to a different wallet address.", mismatch.text)
  const tooMuch = await tool(env, { args: good(c1.id, { amount_usdc: "1.000001" }) })
  const tooLittle = await tool(env, { args: good(c1.id, { amount_usdc: "0.01" }) })
  const wrongAmount = "Refused. That is not the amount the claim code is for."
  check(11, "A CODE IS NOT A KEY: the right code and address for one micro more, or for one cent, are both refused", tooMuch.headers.get("x-palgate-verdict") === "FAIL" && tooMuch.text === wrongAmount && tooLittle.headers.get("x-palgate-verdict") === "FAIL" && tooLittle.text === wrongAmount, `${tooMuch.text} | ${tooLittle.text}`)
  check(12, "refused requests leave the claim open and unreserved, still payable to the person it is for", (await claimRow(dbs.B, c1.id)).state === "open" && (await claimRow(dbs.B, c1.id)).reserved_by === null)

  // An expired claim cannot be issued through the route (it refuses a past expiry), so it is planted directly.
  await dbs.B.prepare("INSERT INTO pg_claim (id, recipient, amount_micro, expires_at, issued_at, state) VALUES (?, ?, ?, ?, ?, 'open')").bind("PGEXPIRED01", A, 1_000_000, "2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z").run()
  const expired = await tool(env, { args: good("PGEXPIRED01") })
  check(13, "FAIL: an expired claim", expired.headers.get("x-palgate-verdict") === "FAIL" && expired.text === "Refused. That claim code has expired.", expired.text)

  const garbage = await tool(env, { args: "the model sent prose instead of JSON" })
  check(14, "arguments that are not JSON: WAIT naming all four things, never a 4xx", garbage.status === 200 && garbage.headers.get("x-palgate-verdict") === "WAIT" && garbage.text === "I can't release anything yet. I still need the wallet address to send to, the amount, the claim code this payout is based on, and your reason for the payout.", garbage.text)

  const ok = await tool(env, { args: good(c1.code), tool_call_id: "call_pass_1", conversation_id: "c_pass" })
  passDecisionId = ok.headers.get("x-palgate-decision")
  passClaimId = c1.id
  check(15, "PASS: the hyphenated code as a person would read it, 1.00 to the claim's own address", ok.status === 200 && ok.headers.get("x-palgate-verdict") === "PASS" && ok.text === "Approved by the gate: 1.00 USDC to the address ending in aaaa. This gate has no wallet attached, so no funds move.", ok.text)
  const d = await decisionRow(dbs.B, passDecisionId)
  const cl = await claimRow(dbs.B, c1.id)
  check(16, "RULE 3: the PASS reserved the claim for this decision and executed nothing", d.state === "approved" && d.execution === null && cl.state === "reserved" && cl.reserved_by === passDecisionId && cl.redeemed_at === null)

  const before = await count(dbs.B)
  const replay = await tool(env, { args: good(c1.code), tool_call_id: "call_pass_1", conversation_id: "c_pass" })
  check(17, "ONE CALL, ONE DECISION: the same tool_call_id again gets the same answer and writes nothing", replay.status === 200 && replay.text === ok.text && replay.headers.get("x-palgate-decision") === passDecisionId && (await count(dbs.B)) === before)
  const altered = await tool(env, { args: good(c1.code, { amount_usdc: "0.01" }), tool_call_id: "call_pass_1", conversation_id: "c_pass" })
  check(18, "a replay with different arguments under the same tool_call_id still gets the recorded answer", altered.text === ok.text && altered.headers.get("x-palgate-decision") === passDecisionId)

  const again = await tool(env, { args: good(c1.id) })
  check(19, "ONE CLAIM, ONE APPROVAL: the same claim under a new tool call is refused", again.headers.get("x-palgate-verdict") === "FAIL" && again.text === "Refused. That claim code is already tied to another request.", again.text)

  const c2 = await issue(env, { amount_usdc: "0.25" })
  const asJson = await tool(env, { args: good(c2.id, { amount_usdc: "0.25" }) }, "?format=json")
  const dj = asJson.json?.decision
  check(20, "?format=json returns the decision with both preimages, and both hashes recompute", asJson.status === 200 && dj?.verdict === "PASS" && sha256(dj.intent_preimage) === dj.intent_sha256 && sha256(dj.decision_preimage) === dj.decision_sha256 && dj.attested === false && asJson.json.say.startsWith("Approved by the gate: 0.25 USDC"), asJson.text)

  const ledger = await get(env, "/ledger")
  const blob = ledger.text
  check(21, "THE RECORD is public and lists every decided call", ledger.status === 200 && ledger.json.count === (await count(dbs.B, "state != 'pending'")) && ledger.headers.get("access-control-allow-origin") === "*")
  check(22, "no public route returns a claim code, a Tavus id or reason text", !blob.includes(c1.id) && !blob.includes(c2.id) && !blob.includes("PGEXPIRED01") && !blob.includes("c_pass") && !blob.includes("call_pass_1") && !blob.includes("raffle") && !blob.includes("claim_id") && !blob.includes("tool_call_id"))
  const one = await get(env, `/ledger/${passDecisionId}`)
  const none = await get(env, "/ledger/00000000-0000-0000-0000-000000000000")
  check(23, "/ledger/:id returns one decision; an unknown id is 404 not_found", one.status === 200 && one.json.decision.id === passDecisionId && one.json.decision.state === "approved" && none.status === 404 && none.json.error === "not_found")
}

// ════ 3. RACES ══════════════════════════════════════════════════════════════════════════
{
  const env = baseEnv(dbs.C)
  const c = await issue(env)
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => tool(env, { args: good(c.id), tool_call_id: `race_${i}`, conversation_id: `c_race_${i}` })))
  const verdicts = results.map((r) => r.headers.get("x-palgate-verdict"))
  const winners = results.filter((r) => r.headers.get("x-palgate-verdict") === "PASS")
  const cl = await claimRow(dbs.C, c.id)
  check(24, "12 concurrent requests citing one claim: exactly one PASS, eleven FAIL, none errored", results.every((r) => r.status === 200) && winners.length === 1 && verdicts.filter((v) => v === "FAIL").length === 11, verdicts.join(","))
  check(25, "the claim is reserved by the winner, and only one decision is approved", cl.state === "reserved" && cl.reserved_by === winners[0]?.headers.get("x-palgate-decision") && (await count(dbs.C, "state = 'approved'")) === 1 && (await count(dbs.C, "state = 'pending'")) === 0)

  const c2 = await issue(env)
  const same = await Promise.all(Array.from({ length: 6 }, () => tool(env, { args: good(c2.id), tool_call_id: "dup_1", conversation_id: "c_dup" })))
  const ids = new Set(same.map((r) => r.headers.get("x-palgate-decision")))
  const texts = new Set(same.map((r) => r.text))
  check(26, "6 concurrent deliveries of ONE tool_call_id: one decision row, one answer, one reservation", same.every((r) => r.status === 200) && ids.size === 1 && texts.size === 1 && (await count(dbs.C, "tool_call_id = 'dup_1'")) === 1 && (await claimRow(dbs.C, c2.id)).reserved_by === [...ids][0], [...texts].join(" | "))

  // Budget 2.00, five valid 1.00 requests on five different claims, all at once.
  const env2 = baseEnv(dbs.C2, { DAILY_BUDGET_MICRO: "2000000" })
  const claims = []
  for (let i = 0; i < 5; i++) claims.push(await issue(env2))
  const burst = await Promise.all(claims.map((cl2, i) => tool(env2, { args: good(cl2.id), tool_call_id: `budget_${i}`, conversation_id: `c_budget_${i}` })))
  const passes = burst.filter((r) => r.headers.get("x-palgate-verdict") === "PASS").length
  const holds = burst.filter((r) => r.headers.get("x-palgate-disposition") === "HOLD_FOR_HUMAN").length
  const spent = (await dbs.C2.prepare("SELECT COALESCE(SUM(amount_micro), 0) AS s FROM pg_decision WHERE resolved_by IS NULL AND state = 'approved'").bind().first()).s
  check(27, "THE BUDGET HOLDS UNDER RACE: 5 concurrent valid requests, budget 2.00: exactly 2 PASS, 3 held, 2.00 approved", burst.every((r) => r.status === 200) && passes === 2 && holds === 3 && spent === 2_000_000, `pass ${passes} hold ${holds} spent ${spent}`)
  check(28, "every one of the five claims is reserved (two approved, three waiting for a person), none double-used", (await dbs.C2.prepare("SELECT COUNT(*) AS n FROM pg_claim WHERE state = 'reserved'").bind().first()).n === 5 && (await count(dbs.C2, "state = 'held' AND flags = 'BUDGET_EXHAUSTED'")) === 3)
}

// ════ 4. HOLDS AND THE OPERATOR ═════════════════════════════════════════════════════════
{
  const env = baseEnv(dbs.D)
  const big = await issue(env, { amount_usdc: "5.00" })
  const held = await tool(env, { args: good(big.id, { amount_usdc: "5.00" }), conversation_id: "c_hold" })
  const heldId = held.headers.get("x-palgate-decision")
  check(29, "RULE 2: a valid request over the auto limit is HELD and answered at once", held.status === 200 && held.headers.get("x-palgate-verdict") === "WAIT" && held.headers.get("x-palgate-disposition") === "HOLD_FOR_HUMAN" && held.text === "That request matches the records, but it is more than I can release on my own. A person has to approve it, and nothing moves until they do.", held.text)
  check(30, "the held request keeps its claim reserved, and nothing has executed", (await decisionRow(dbs.D, heldId)).state === "held" && (await claimRow(dbs.D, big.id)).reserved_by === heldId)

  const noKeyCfg = await op(baseEnv(dbs.D, { OPERATOR_KEY: undefined }), "GET", "/operator/holds")
  const wrongKey = await op(env, "GET", "/operator/holds", undefined, "not-the-key")
  const noHeader = await op(env, "GET", "/operator/holds", undefined, null)
  check(31, "/operator: 503 when no key is configured, 401 for a wrong or missing key", noKeyCfg.status === 503 && noKeyCfg.json.error === "operator_not_configured" && wrongKey.status === 401 && wrongKey.json.error === "unauthorized" && noHeader.status === 401)

  const holds = await op(env, "GET", "/operator/holds")
  check(32, "the operator sees the hold, with the claim code the public ledger never shows", holds.status === 200 && holds.json.count === 1 && holds.json.holds[0].id === heldId && holds.json.holds[0].claim_code === big.code && holds.json.holds[0].amount_usdc === "5.00")

  const badAction = await op(env, "POST", `/operator/decisions/${heldId}/resolve`, { action: "maybe" })
  const approve = await op(env, "POST", `/operator/decisions/${heldId}/resolve`, { action: "approve" })
  const after = await decisionRow(dbs.D, heldId)
  const exec = JSON.parse(after.execution ?? "{}")
  check(33, "a person approves: the dry-run executor runs once, the decision is executed, the claim is redeemed", badAction.status === 400 && approve.status === 200 && after.state === "executed" && after.resolved_by === "operator" && exec.outcome === "done" && exec.mode === "dry_run" && exec.ref === `dryrun:${heldId}` && (await claimRow(dbs.D, big.id)).state === "redeemed")
  const twice = await op(env, "POST", `/operator/decisions/${heldId}/resolve`, { action: "approve" })
  const missing = await op(env, "POST", "/operator/decisions/00000000-0000-0000-0000-000000000000/resolve", { action: "approve" })
  check(34, "approving it again is 409 conflict; an unknown decision is 404", twice.status === 409 && twice.json.error === "conflict" && missing.status === 404)
  const autoSpent = (await dbs.D.prepare("SELECT COALESCE(SUM(amount_micro), 0) AS s FROM pg_decision WHERE resolved_by IS NULL AND state IN ('approved','executing','executed','execution_uncertain')").bind().first()).s
  check(35, "an approval by a person does not consume the gate's own daily budget", autoSpent === 0)

  const big2 = await issue(env, { amount_usdc: "3.00" })
  const held2 = await tool(env, { args: good(big2.id, { amount_usdc: "3.00" }) })
  const held2Id = held2.headers.get("x-palgate-decision")
  const deny = await op(env, "POST", `/operator/decisions/${held2Id}/resolve`, { action: "deny" })
  const freed = await claimRow(dbs.D, big2.id)
  check(36, "a person denies: the decision is denied and the claim goes back to open", deny.status === 200 && deny.json.decision.state === "denied" && freed.state === "open" && freed.reserved_by === null)
  const denyAgain = await op(env, "POST", `/operator/decisions/${held2Id}/resolve`, { action: "deny" })
  check(37, "denying it again is 409 conflict", denyAgain.status === 409)

  const explicit = await op(env, "POST", "/operator/claims", { recipient: A, amount_usdc: "0.50", id: "house-raffle-0001" })
  const dupe = await op(env, "POST", "/operator/claims", { recipient: A, amount_usdc: "0.50", id: "HOUSE RAFFLE 0001" })
  check(38, "a claim can be issued under a chosen code; the same code again (any spelling) is 409", explicit.status === 201 && explicit.json.claim.id === "HOUSERAFFLE0001" && dupe.status === 409)
  const badClaims = await Promise.all([
    op(env, "POST", "/operator/claims", { recipient: "0x123", amount_usdc: "1.00" }),
    op(env, "POST", "/operator/claims", { recipient: "0x" + "0".repeat(40), amount_usdc: "1.00" }),
    op(env, "POST", "/operator/claims", { recipient: A, amount_usdc: "0" }),
    op(env, "POST", "/operator/claims", { recipient: A, amount_usdc: "1.00", expires_at: "2020-01-01T00:00:00Z" }),
    op(env, "POST", "/operator/claims", { recipient: A, amount_usdc: "1.00", id: "no" }),
  ])
  check(39, "a claim with a bad address, the zero address, a zero amount, a past expiry or an unusable code is 400", badClaims.every((r) => r.status === 400 && r.json.error === "bad_request"), badClaims.map((r) => r.status).join(","))
  const generated = await issue(env)
  check(40, "a generated code is PG plus 16 symbols (80 bits), shown hyphenated", /^PG[0-9A-HJKMNP-TV-Z]{16}$/.test(generated.id) && /^PG(-[0-9A-HJKMNP-TV-Z]{4}){4}$/.test(generated.code))

  const voided = await op(env, "POST", `/operator/claims/${explicit.json.claim.id}/void`)
  const voidAgain = await op(env, "POST", `/operator/claims/${explicit.json.claim.id}/void`)
  const citeVoid = await tool(env, { args: good("HOUSERAFFLE0001", { amount_usdc: "0.50" }) })
  check(41, "an open claim can be voided once; citing it afterwards is refused as cancelled", voided.status === 200 && voidAgain.status === 409 && citeVoid.headers.get("x-palgate-verdict") === "FAIL" && citeVoid.text === "Refused. That claim code was cancelled.", citeVoid.text)
  const voidReserved = await op(env, "POST", `/operator/claims/${big.id}/void`)
  check(42, "a claim that is not open (here: redeemed) cannot be voided", voidReserved.status === 409)
}

// ════ 5. THE POST-CALL DOOR ═════════════════════════════════════════════════════════════
{
  const env = baseEnv(dbs.E)
  const c1 = await issue(env)
  const c2 = await issue(env)
  const p1 = await tool(env, { args: good(c1.id), conversation_id: "c_one" })
  const p2 = await tool(env, { args: good(c2.id), conversation_id: "c_two" })
  const id1 = p1.headers.get("x-palgate-decision")
  const id2 = p2.headers.get("x-palgate-decision")
  const settleBody = envelope({ name: "settle_after_call", args: {}, conversation_id: "c_one", tool_call_id: "post_1" })

  const badSig = await post("/tavus/post-call/settle", settleBody, env, { signature: sign(settleBody, "nope") })
  const wrongName = await post("/tavus/post-call/settle", envelope({ name: "request_transfer", conversation_id: "c_one" }), env)
  check(43, "the post-call route takes only a signed settle_after_call", badSig.status === 401 && wrongName.status === 400 && wrongName.json.error === "wrong_tool")

  const noExec = await post("/tavus/post-call/settle", settleBody, baseEnv(dbs.E, { EXECUTOR: "usdc_live" }))
  check(44, "an EXECUTOR this version does not ship: 503 executor_unavailable, and nothing changes", noExec.status === 503 && noExec.json.error === "executor_unavailable" && (await decisionRow(dbs.E, id1)).state === "approved" && (await claimRow(dbs.E, c1.id)).state === "reserved")

  const settle = await post("/tavus/post-call/settle", settleBody, env)
  const d1 = await decisionRow(dbs.E, id1)
  check(45, "RULE 3: the post-call action executes this conversation's approval, once", settle.status === 200 && settle.json.executed === 1 && settle.json.failed === 0 && settle.json.uncertain === 0 && d1.state === "executed" && JSON.parse(d1.execution).ref === `dryrun:${id1}` && (await claimRow(dbs.E, c1.id)).state === "redeemed")
  check(46, "the other conversation's approval is untouched", (await decisionRow(dbs.E, id2)).state === "approved" && (await claimRow(dbs.E, c2.id)).state === "reserved")
  const settleAgain = await post("/tavus/post-call/settle", settleBody, env)
  const racing = await Promise.all(Array.from({ length: 4 }, () => op(env, "POST", "/operator/conversations/c_two/settle")))
  const executedTwo = racing.reduce((n, r) => n + (r.json?.executed ?? 0), 0)
  check(47, "settling again executes nothing; four racing settles of the other conversation execute it exactly once", settleAgain.json.executed === 0 && racing.every((r) => r.status === 200) && executedTwo === 1 && (await decisionRow(dbs.E, id2)).state === "executed", `executed ${executedTwo}`)

  const spent = await tool(env, { args: good(c1.id) })
  check(48, "a redeemed claim cited again is refused as already paid", spent.headers.get("x-palgate-verdict") === "FAIL" && spent.text === "Refused. That claim code has already been paid out.", spent.text)

  const noExecPass = await tool(baseEnv(dbs.E, { EXECUTOR: "usdc_live" }), { args: good((await issue(env)).id) })
  check(49, "with no usable executor a PASS still says plainly that no funds move", noExecPass.headers.get("x-palgate-verdict") === "PASS" && noExecPass.text.endsWith("so no funds move."), noExecPass.text)
}

// ════ 6. THE KILL SWITCH, AND THE WAY OUT OF EVERY STATE ════════════════════════════════
{
  const env = baseEnv(dbs.F)
  const closed = baseEnv(dbs.F, { GATE_MODE: "closed" })
  const autoSpent = async () => (await dbs.F.prepare("SELECT COALESCE(SUM(amount_micro), 0) AS s FROM pg_decision WHERE resolved_by IS NULL AND state IN ('approved','executing','executed','execution_uncertain')").bind().first()).s

  // The same tool_call_id in two conversations is two calls, not a replay.
  const k1 = await issue(env)
  const k2 = await issue(env)
  const first = await tool(env, { args: good(k1.id), tool_call_id: "call_1", conversation_id: "c_alpha" })
  const second = await tool(env, { args: good(k2.id), tool_call_id: "call_1", conversation_id: "c_beta" })
  const idA = first.headers.get("x-palgate-decision")
  const idB = second.headers.get("x-palgate-decision")
  check(50, "the idempotency key is (conversation, tool_call_id): the same id in another conversation gets its own decision", first.headers.get("x-palgate-verdict") === "PASS" && second.headers.get("x-palgate-verdict") === "PASS" && idA !== idB && (await claimRow(dbs.F, k1.id)).reserved_by === idA && (await claimRow(dbs.F, k2.id)).reserved_by === idB)

  // An over-limit request, held while the gate is still open.
  const big = await issue(env, { amount_usdc: "4.00" })
  const held = await tool(env, { args: good(big.id, { amount_usdc: "4.00" }), conversation_id: "c_gamma" })
  const heldId = held.headers.get("x-palgate-decision")

  const unsettled = await op(env, "GET", "/operator/unsettled")
  const mine = unsettled.json?.unsettled ?? []
  check(51, "an approval waiting for its post-call action is visible to the operator, with the conversation to settle", unsettled.status === 200 && unsettled.json.count === 2 && mine.some((d) => d.id === idA && d.conversation_id === "c_alpha" && d.claim_code === k1.code && d.state === "approved") && mine.some((d) => d.id === idB && d.conversation_id === "c_beta"))
  const noKey = await op(env, "GET", "/operator/unsettled", undefined, null)
  check(52, "/operator/unsettled needs the operator key", noKey.status === 401)

  // The gate closes with two approvals and one hold outstanding.
  const settleBody = envelope({ name: "settle_after_call", args: {}, conversation_id: "c_alpha", tool_call_id: "post_alpha" })
  const postCall = await post("/tavus/post-call/settle", settleBody, closed)
  const byHand = await op(closed, "POST", "/operator/conversations/c_alpha/settle")
  const approveClosed = await op(closed, "POST", `/operator/decisions/${heldId}/resolve`, { action: "approve" })
  const untouched = (await decisionRow(dbs.F, idA)).state === "approved" && (await decisionRow(dbs.F, heldId)).state === "held" && (await claimRow(dbs.F, k1.id)).state === "reserved" && (await claimRow(dbs.F, big.id)).state === "reserved"
  check(53, "KILL SWITCH: closed, the post-call action, the operator's settle and the operator's approve all answer 409 gate_closed", postCall.status === 409 && postCall.json.error === "gate_closed" && byHand.status === 409 && byHand.json.error === "gate_closed" && approveClosed.status === 409 && approveClosed.json.error === "gate_closed", `${postCall.status} ${byHand.status} ${approveClosed.status}`)
  check(54, "and nothing executed: no decision changed state, every claim is still reserved, no execution was recorded", untouched && (await count(dbs.F, "execution IS NOT NULL")) === 0 && (await count(dbs.F, "state IN ('executing','executed')")) === 0)

  // A closed gate still lets a person say no.
  const before = await autoSpent()
  const denyApproved = await op(closed, "POST", `/operator/decisions/${idB}/resolve`, { action: "deny" })
  const denyHeld = await op(closed, "POST", `/operator/decisions/${heldId}/resolve`, { action: "deny" })
  const k2After = await claimRow(dbs.F, k2.id)
  check(55, "a person can deny while the gate is closed: an approval that has not executed, and a hold", denyApproved.status === 200 && denyApproved.json.decision.state === "denied" && denyHeld.status === 200 && denyHeld.json.decision.state === "denied")
  check(56, "denying an approval frees its claim and gives its amount back to the day's budget", k2After.state === "open" && k2After.reserved_by === null && before === 2_000_000 && (await autoSpent()) === 1_000_000 && (await claimRow(dbs.F, big.id)).state === "open")
  const approveApproved = await op(env, "POST", `/operator/decisions/${idA}/resolve`, { action: "approve" })
  check(57, "\"approve\" is only for a hold: an approval the gate already made is settled, not approved again", approveApproved.status === 409 && approveApproved.json.error === "conflict" && (await decisionRow(dbs.F, idA)).state === "approved")

  // The gate reopens: the outstanding approval settles once, and can no longer be denied.
  const settled = await op(env, "POST", "/operator/conversations/c_alpha/settle")
  const denyExecuted = await op(env, "POST", `/operator/decisions/${idA}/resolve`, { action: "deny" })
  check(58, "reopened, the outstanding approval settles once; an executed decision cannot be denied", settled.status === 200 && settled.json.executed === 1 && (await decisionRow(dbs.F, idA)).state === "executed" && (await claimRow(dbs.F, k1.id)).state === "redeemed" && denyExecuted.status === 409)
  const lateSettle = await op(env, "POST", "/operator/conversations/c_beta/settle")
  check(59, "a denied approval is not executed by a later settle", lateSettle.status === 200 && lateSettle.json.executed === 0 && (await decisionRow(dbs.F, idB)).state === "denied" && (await op(env, "GET", "/operator/unsettled")).json.count === 0)

  // A denial racing the settle of the same approval: exactly one of them lands.
  const k3 = await issue(env)
  const racing = await tool(env, { args: good(k3.id), conversation_id: "c_delta" })
  const raceId = racing.headers.get("x-palgate-decision")
  const [rSettle, rDeny] = await Promise.all([op(env, "POST", "/operator/conversations/c_delta/settle"), op(env, "POST", `/operator/decisions/${raceId}/resolve`, { action: "deny" })])
  const raced = await decisionRow(dbs.F, raceId)
  const k3After = await claimRow(dbs.F, k3.id)
  const executedWon = raced.state === "executed" && rSettle.json.executed === 1 && rDeny.status === 409 && k3After.state === "redeemed"
  const deniedWon = raced.state === "denied" && rSettle.json.executed === 0 && rDeny.status === 200 && k3After.state === "open"
  check(60, "a denial racing a settle of the same approval: exactly one lands, and the claim agrees with it", executedWon !== deniedWon, `${raced.state} settle ${rSettle.text} deny ${rDeny.status} claim ${k3After.state}`)

  // The post-call action comes from no LLM turn, so it may carry no tool_call_id, inference_id or turn_idx.
  const k4 = await issue(env)
  const lean = await tool(env, { args: good(k4.id), conversation_id: "c_epsilon" })
  const leanBody = JSON.stringify({ conversation_id: "c_epsilon", name: "settle_after_call" })
  const leanSettle = await post("/tavus/post-call/settle", leanBody, env)
  check(61, "a post-call body carrying only the name and the conversation settles that conversation", leanSettle.status === 200 && leanSettle.json.executed === 1 && (await decisionRow(dbs.F, lean.headers.get("x-palgate-decision"))).state === "executed", leanSettle.text)
}

// ════ 7. THE RECORD, AND WHAT A FAILURE MAY SAY ═════════════════════════════════════════
{
  let rows = 0
  let expected = 0
  let recomputed = 0
  for (const k of DB_KEYS) {
    expected += await count(dbs[k], "state != 'pending'")
    const ledger = await get(baseEnv(dbs[k]), "/ledger?limit=200")
    for (const d of ledger.json.decisions) {
      rows++
      if (sha256(d.intent_preimage) === d.intent_sha256 && sha256(d.decision_preimage) === d.decision_sha256 && d.decision_preimage.includes(`intent_sha256=${d.intent_sha256}`) && d.decision_preimage.includes(`verdict=${d.verdict}`) && d.decision_preimage.endsWith(`ruleset=${d.ruleset}`)) recomputed++
    }
  }
  check(62, `every decision in every database is on its ledger (${rows}), and each one recomputes from its published preimages`, rows === expected && rows >= 40 && recomputed === rows, `${recomputed}/${rows} of ${expected}`)
  check(63, "no decision was left undecided", (await Promise.all(DB_KEYS.map((k) => count(dbs[k], "state = 'pending'")))).every((n) => n === 0))

  const SENTINEL = "https://db.sentinel.invalid/v1/KEYSENTINEL0123456789abcdef0123456789"
  const brokenDb = { prepare() { throw new Error(`D1_ERROR: upstream ${SENTINEL}`) }, batch() { throw new Error(SENTINEL) } }
  const errors = []
  const origError = console.error
  console.error = (...a) => errors.push(a.join(" "))
  const broken = await tool(baseEnv(brokenDb), { args: good("PGANYTHING01") })
  const brokenLedger = await get(baseEnv(brokenDb), "/ledger")
  console.error = origError
  check(64, "a store failure answers a fixed code and no raw error text; the log line is scrubbed", broken.status === 503 && broken.json.error === "store_error" && !broken.text.includes("sentinel") && !broken.text.includes("KEYSENTINEL") && brokenLedger.status === 503 && !brokenLedger.text.includes("sentinel") && errors.length > 0 && errors.every((l) => !l.includes("KEYSENTINEL") && !l.includes("sentinel.invalid")), `${broken.text} || ${errors.join(" / ")}`)

  const health = await get(baseEnv(dbs.A), "/health")
  check(65, "/health reports what is configured without a secret in it", health.status === 200 && health.json.gate_mode === "open" && health.json.executor === "dry_run" && health.json.moves_funds === false && health.json.attested === false && health.json.tavus_secret_set === true && health.json.limits.auto_limit_usdc === "1.00" && !health.text.includes(SECRET) && !health.text.includes(OPKEY))
  const closedHealth = await get(baseEnv(undefined, { GATE_MODE: undefined, TAVUS_TOOL_SECRET: undefined, OPERATOR_KEY: undefined, EXECUTOR: undefined }), "/health")
  check(66, "/health with nothing configured: closed, no executor, nothing bound", closedHealth.json.gate_mode === "closed" && closedHealth.json.executor === null && closedHealth.json.store_bound === false && closedHealth.json.tavus_secret_set === false)
  const nf = await get(baseEnv(dbs.A), "/nope")
  const wrongMethod = await get(baseEnv(dbs.A), "/tavus/tool/request_transfer")
  check(67, "unknown paths and wrong methods answer 404 not_found with a fixed code", nf.status === 404 && nf.json.error === "not_found" && wrongMethod.status === 404)
}

await mf.dispose()
console.log(failures.length ? `\nGATE-FLOW: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nGATE-FLOW: PASS (${pass} checks)`)
process.exit(failures.length ? 1 : 0)
