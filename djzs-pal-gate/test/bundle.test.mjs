/**
 * The BUILT Worker bundle, running in workerd (Miniflare), with a real D1. Offline.
 *
 * Why this exists beside gate-flow.test.mjs: that file drives the source under Node. What ships is
 * the esbuild bundle running in workerd, with workerd's WebCrypto and workerd's D1 binding. This
 * file proves the shipped artifact does the same thing:
 *
 *   - a signature made with Node's HMAC verifies under workerd's crypto.subtle (and a wrong one does not);
 *   - the two receipt hashes computed in workerd recompute byte for byte under Node;
 *   - the conditional D1 batch holds under real concurrent requests: 8 at once on one claim, one PASS;
 *   - the bundle fails closed without its D1 binding, and answers closed for the config as committed
 *     unless that config says exactly "open";
 *   - ZERO EGRESS: the Worker makes no outbound request of any kind (every one would be counted);
 *   - the bundle contains no code that can sign or send a transaction;
 *   - the deploy is guarded the same way the repo's other two Workers are.
 *
 * The secrets here are throwaway strings made up in this file.
 *
 * miniflare is wrangler's own dependency (hoisted into node_modules); a wrangler bump that nests it
 * fails this import loudly, not silently.
 *
 * Run from djzs-pal-gate/:   npx tsx test/bundle.test.mjs
 *   DJZS_BUNDLE=<path/to/index.js>  to test an already-built bundle (CI passes the dry-run output);
 *   otherwise it builds one with `wrangler deploy --dry-run` (no login, no secrets, no deploy).
 */
import { execFileSync } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"

// A hung workerd request must fail the step, not hold the job for hours.
setTimeout(() => { console.error("BUNDLE: TIMEOUT after 240s"); process.exit(1) }, 240_000).unref()

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}

// ── bundle ──────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, "..")
let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-palgate-"))
  // DJZS_BUILD_ONLY: this builds a bundle and uploads nothing, so the predeploy guard stands down for it.
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: ROOT, env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)
const BUNDLE_TEXT = readFileSync(bundle, "utf8")

const TOML = readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")
const compatibilityDate = TOML.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
if (!compatibilityDate) throw new Error("wrangler.toml has no compatibility_date")
/** The [vars] exactly as committed. */
const tomlVar = (name) => TOML.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1]
const SHIPPED = { GATE_MODE: tomlVar("GATE_MODE"), EXECUTOR: tomlVar("EXECUTOR"), AUTO_LIMIT_MICRO: tomlVar("AUTO_LIMIT_MICRO"), DAILY_BUDGET_MICRO: tomlVar("DAILY_BUDGET_MICRO") }

const SECRET = "test-only-tavus-secret"
const OPKEY = "test-only-operator-key"
const A = "0x" + "a".repeat(40)
const egress = []

const mk = (vars, { db = true } = {}) =>
  new Miniflare({
    modules: true,
    modulesRoot: path.dirname(path.resolve(bundle)),
    scriptPath: path.resolve(bundle),
    compatibilityDate,
    bindings: { TAVUS_TOOL_SECRET: SECRET, OPERATOR_KEY: OPKEY, ...vars },
    ...(db ? { d1Databases: { DB: "pal-gate-bundle" } } : {}),
    // Every outbound request the Worker attempts lands here, is counted, and is refused.
    outboundService: async (req) => { egress.push(req.url); return new Response("egress refused", { status: 599 }) },
  })

const sha256 = (s) => createHash("sha256").update(s).digest("hex")
const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex")
let seq = 0
const envelope = ({ name = "request_transfer", args = {}, tool_call_id, conversation_id = "c_bundle" } = {}) =>
  JSON.stringify({ arguments: JSON.stringify(args), conversation_id, inference_id: "inf_1", name, tool_call_id: tool_call_id ?? `call_${++seq}`, turn_idx: 1 })
async function read(res) {
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* text/plain */ }
  return { status: res.status, text, json, headers: res.headers }
}
const post = async (mf, p, body, headers = {}) => read(await mf.dispatchFetch(`http://gate.test${p}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }))
const tool = (mf, opts, signature) => { const body = envelope(opts); return post(mf, "/tavus/tool/request_transfer", body, { "x-tavus-signature": signature ?? sign(body) }) }
const op = (mf, p, body) => post(mf, p, body === undefined ? undefined : JSON.stringify(body), { authorization: `Bearer ${OPKEY}` })
const get = async (mf, p) => read(await mf.dispatchFetch(`http://gate.test${p}`))
const good = (code, over = {}) => ({ recipient: A, amount_usdc: "1.00", reference: code, reason: "raffle prize from the meetup", ...over })
const OPEN = { GATE_MODE: "open", EXECUTOR: "dry_run", AUTO_LIMIT_MICRO: "1000000", DAILY_BUDGET_MICRO: "5000000" }

// ════ 1. the config as committed ════════════════════════════════════════════════════════
{
  const mf = mk(SHIPPED)
  const health = await get(mf, "/health")
  const expectClosed = SHIPPED.GATE_MODE !== "open"
  check(1, `as committed (GATE_MODE "${SHIPPED.GATE_MODE}", EXECUTOR "${SHIPPED.EXECUTOR}"): /health says the same, and no funds can move`, health.status === 200 && health.json.service === "djzs-pal-gate" && health.json.gate_mode === (expectClosed ? "closed" : "open") && health.json.executor === (SHIPPED.EXECUTOR === "dry_run" ? "dry_run" : null) && health.json.moves_funds === false && health.json.store_bound === true, health.text)
  check(2, "/health carries no secret", !health.text.includes(SECRET) && !health.text.includes(OPKEY))
  await mf.dispose()
}

// ════ 2. closed ═════════════════════════════════════════════════════════════════════════
{
  const mf = mk({ ...OPEN, GATE_MODE: "closed" })
  const claim = (await op(mf, "/operator/claims", { recipient: A, amount_usdc: "1.00" })).json?.claim
  const r = await tool(mf, { args: good(claim?.id) })
  check(3, "closed: a valid, signed request is answered WAIT in plain words, HTTP 200", r.status === 200 && r.headers.get("x-palgate-verdict") === "WAIT" && r.headers.get("x-palgate-disposition") === "CLOSED" && r.text === "The gate is closed right now, so nothing can be released.", r.text)
  const settleBody = envelope({ name: "settle_after_call", conversation_id: "c_bundle" })
  const settle = await post(mf, "/tavus/post-call/settle", settleBody, { "x-tavus-signature": sign(settleBody) })
  check(4, "closed: the post-call action answers 409 gate_closed", settle.status === 409 && settle.json?.error === "gate_closed", settle.text)
  await mf.dispose()
}

// ════ 3. open, dry run ══════════════════════════════════════════════════════════════════
{
  const mf = mk(OPEN)
  const issued = await op(mf, "/operator/claims", { recipient: A, amount_usdc: "1.00" })
  const claim = issued.json?.claim
  check(5, "the operator issues a claim (workerd's getRandomValues makes the code)", issued.status === 201 && /^PG[0-9A-HJKMNP-TV-Z]{16}$/.test(claim?.id ?? ""), issued.text)

  const body = envelope({ args: good(claim.id), tool_call_id: "call_sig" })
  const wrong = await post(mf, "/tavus/tool/request_transfer", body, { "x-tavus-signature": sign(body, "another-secret") })
  const missing = await post(mf, "/tavus/tool/request_transfer", body)
  const tampered = await post(mf, "/tavus/tool/request_transfer", body.replace("1.00", "9.00"), { "x-tavus-signature": sign(body) })
  check(6, "workerd's crypto.subtle refuses a wrong signature, a missing one, and a body changed after signing", wrong.status === 401 && missing.status === 401 && tampered.status === 401 && wrong.json?.error === "bad_signature")

  const ok = await post(mf, "/tavus/tool/request_transfer", body, { "x-tavus-signature": sign(body) })
  const id = ok.headers.get("x-palgate-decision")
  check(7, "a signature made with Node's HMAC verifies in workerd, and the request PASSES", ok.status === 200 && ok.headers.get("x-palgate-verdict") === "PASS" && (ok.headers.get("content-type") ?? "").startsWith("text/plain") && ok.text === "Approved by the gate: 1.00 USDC to the address ending in aaaa. This gate has no wallet attached, so no funds move.", ok.text)
  const replay = await post(mf, "/tavus/tool/request_transfer", body, { "x-tavus-signature": sign(body) })
  check(8, "a replay of the same signed request gets the same decision", replay.status === 200 && replay.headers.get("x-palgate-decision") === id && replay.text === ok.text)

  const one = (await get(mf, `/ledger/${id}`)).json?.decision
  check(9, "the receipt hashes computed in workerd recompute byte for byte under Node", one && sha256(one.intent_preimage) === one.intent_sha256 && sha256(one.decision_preimage) === one.decision_sha256 && one.state === "approved" && one.execution === null, JSON.stringify(one))
  check(10, "the intent preimage names the action, the asset and the chain, and carries the code only as a hash", one.intent_preimage === `palgate.intent.v1|action=transfer|asset=USDC|chain_id=8453|recipient=${A}|amount_micro=1000000|reference_sha256=${sha256(claim.id)}|reason_sha256=${sha256("raffle prize from the meetup")}` && !JSON.stringify(one).includes(claim.id), one.intent_preimage)

  const settleBody = envelope({ name: "settle_after_call", conversation_id: "c_bundle", tool_call_id: "post_1" })
  const settle = await post(mf, "/tavus/post-call/settle", settleBody, { "x-tavus-signature": sign(settleBody) })
  const again = await post(mf, "/tavus/post-call/settle", settleBody, { "x-tavus-signature": sign(settleBody) })
  const after = (await get(mf, `/ledger/${id}`)).json?.decision
  check(11, "the post-call action executes the approval once, in dry run; a second delivery executes nothing", settle.status === 200 && settle.json.executed === 1 && again.json.executed === 0 && after.state === "executed" && after.execution.mode === "dry_run" && after.execution.ref === `dryrun:${id}`, `${settle.text} ${again.text}`)

  const raceClaim = (await op(mf, "/operator/claims", { recipient: A, amount_usdc: "1.00" })).json.claim
  const race = await Promise.all(Array.from({ length: 8 }, (_, i) => tool(mf, { args: good(raceClaim.id), tool_call_id: `race_${i}`, conversation_id: `c_race_${i}` })))
  const verdicts = race.map((r) => r.headers.get("x-palgate-verdict"))
  check(12, "8 concurrent requests on one claim, in workerd against D1: exactly one PASS", race.every((r) => r.status === 200) && verdicts.filter((v) => v === "PASS").length === 1 && verdicts.filter((v) => v === "FAIL").length === 7, verdicts.join(","))

  const ledger = await get(mf, "/ledger")
  check(13, "the public ledger lists every decision and no claim code", ledger.status === 200 && ledger.json.count === 9 && !ledger.text.includes(claim.id) && !ledger.text.includes(raceClaim.id) && !ledger.text.includes("c_bundle"))
  await mf.dispose()
}

// ════ 4. no store ═══════════════════════════════════════════════════════════════════════
{
  const mf = mk(OPEN, { db: false })
  const r = await tool(mf, { args: good("PGANYTHING01") })
  const health = await get(mf, "/health")
  check(14, "without the D1 binding the bundle fails closed: 503 store_unavailable", r.status === 503 && r.json?.error === "store_unavailable" && health.json.store_bound === false, r.text)
  await mf.dispose()
}

// ════ 5. what the bundle cannot do ══════════════════════════════════════════════════════
check(15, "ZERO EGRESS: across every request above, the Worker made no outbound request", egress.length === 0, egress.join(", "))
const SENDERS = ["eth_sendRawTransaction", "eth_sendTransaction", "privateKeyToAccount", "signTransaction", "sendRawTransaction"]
const found = SENDERS.filter((s) => BUNDLE_TEXT.includes(s))
check(16, "the bundle contains no code that signs or sends a transaction", found.length === 0, found.join(", "))

// ════ 6. how it deploys ═════════════════════════════════════════════════════════════════
const BUILD_COMMAND = TOML.match(/^\[build\]\s*\ncommand\s*=\s*"([^"]+)"/m)?.[1] ?? ""
check(17, "wrangler.toml declares the repo's predeploy guard as its [build] command, and the path resolves from this directory", BUILD_COMMAND === "node ../djzs-trust-mcp/scripts/predeploy-guard.mjs" && existsSync(path.resolve(ROOT, "..", "djzs-trust-mcp", "scripts", "predeploy-guard.mjs")), BUILD_COMMAND || "no [build] command found")
check(18, "no route and no custom domain is declared: the hostname is the operator's ruling", !/^\s*routes?\s*=/m.test(TOML) && !/custom_domain/.test(TOML) && /^workers_dev\s*=\s*true/m.test(TOML))

console.log(failures.length ? `\nBUNDLE: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nBUNDLE: PASS (${pass} checks, ${(BUNDLE_TEXT.length / 1024).toFixed(0)} KiB bundle)`)
process.exit(failures.length ? 1 : 0)
