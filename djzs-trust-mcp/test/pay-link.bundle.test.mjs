/**
 * Skills over MCP + the browser pay link, checked against the BUILT Worker bundle in Miniflare, through the real
 * /mcp transport, the real /pay routes and a local D1. ZERO keys, ZERO egress: the facilitator, the model, Irys
 * and the RPCs are stubbed exactly as in mcp-metadata.bundle.test.mjs.
 *
 * What it holds:
 *   skills    initialize declares io.modelcontextprotocol/skills and resources; skills/list returns the manifest;
 *             every file read through resources/read matches its digest and size; frontmatter matches SKILL.md;
 *             skills/get answers by URI and refuses an unknown one with -32602.
 *   x402      an unpaid paid-tool call keeps the x402 requirement byte-for-byte (content[0] and _meta["x402/error"])
 *             and ADDS a pay link; a call that carries a payment mints no link.
 *   page      GET /pay/:id shows the thesis escaped, refuses framing, and 404s a made-up id.
 *   money     a bad payment is refused before the session is claimed and settles nothing; a good payment settles
 *             exactly once and get_paid_audit returns PAID with the verdict and the receipt; paying again settles
 *             nothing; an out-of-scope thesis is refused and settles nothing; expired and in-progress sessions are
 *             answered as such; the daily cap stops minting without touching the x402 answer.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/pay-link.bundle.test.mjs
 */
import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { parseFrontmatter } from "../scripts/build-skills-bundle.mjs"

setTimeout(() => { console.error("PAY-LINK: TIMEOUT after 240s"); process.exit(1) }, 240_000).unref()

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 400)}` : ""}`) }
}

let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-pay-"))
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)

const F = (state, value, quote) => state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state }
const PM_X = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market", leverage: F("absent"), position_size: F("present", 250), stop_loss: F("present", "daily close below 66000"), take_profit: F("unknown"), invalidation_condition: F("present", "daily close below 66000"), resolution_engagement: F("unknown"), probability_basis: F("present", "implied 0.41 vs model 0.55"), edge_claim: F("unknown"), data_sources: F("unknown"), oracle_source: F("unknown"), confidence: F("unknown") }
const PERP_X = { agent_type: "trader", intended_action: "open", market_type: "perp", leverage: F("present", 5), position_size: F("present", 3000), stop_loss: F("present", 76200), take_profit: F("present", 83000), invalidation_condition: F("present", "daily close below 76,200"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("unknown"), thesis_statement: F("present", "funding reset after the weekend flush") }
const PM_INTENT = "BTC closes above 70k by Aug 29 <b>on ETF inflow</b> continuation; implied 0.41 vs model 0.55; stop on a daily close below 66000"
const PERP_INTENT = "Long BTC-PERP 5x, size 3000 USD on Binance, entry 78000, stop 76200, target 83000, because funding reset after the weekend flush"
const PAYER = "0x1111111111111111111111111111111111111111"
const TX = "0x" + "cd".repeat(32)
const TREASURY = "0xc1923748669dFC3a79497d0403A90a275161eCCA"

const kp = generateKeyPairSync("ed25519")
const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32)
const CDP_SECRET = Buffer.concat([seed, pub]).toString("base64")
const TOML = readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8")

const mode = { extraction: "pm", verify: "ok" }
const counts = { verify: 0, settle: 0 }
const jres = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } })

function worker(extraBindings = {}) {
  return new Miniflare({
    modules: true,
    modulesRoot: path.dirname(path.resolve(bundle)),
    scriptPath: path.resolve(bundle),
    compatibilityDate: TOML.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1],
    compatibilityFlags: JSON.parse((TOML.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])/m)?.[1] ?? "[]")),
    bindings: {
      ENVIRONMENT: "production",
      ANTHROPIC_API_KEY: "stub-not-a-key",
      DJZS_ATTESTER_KEY: "0x" + "11".repeat(32),
      IRYS_UPLOAD_KEY: "0x" + "33".repeat(32),
      BASE_RPC_URL: "https://rpc.stub.invalid/",
      CDP_API_KEY_ID: "organizations/stub/apiKeys/stub",
      CDP_API_KEY_SECRET: CDP_SECRET,
      ...extraBindings,
    },
    d1Databases: { TELEMETRY: "local-telemetry" },
    outboundService: async (req) => {
      const u = new URL(req.url)
      await req.arrayBuffer().catch(() => {})
      if (u.host === "api.cdp.coinbase.com") {
        const p = u.pathname.replace(/^.*\//, "")
        if (p === "supported") return jres({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })
        if (p === "verify") { counts.verify++; return mode.verify === "ok" ? jres({ isValid: true, payer: PAYER }) : jres({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER }) }
        if (p === "settle") { counts.settle++; return jres({ success: true, payer: PAYER, transaction: TX, network: "eip155:8453" }) }
      }
      if (u.host === "api.anthropic.com") return jres({ content: [{ type: "text", text: JSON.stringify(mode.extraction === "perp" ? PERP_X : PM_X) }] })
      if (u.host === "uploader.irys.xyz" || u.host === "devnet.irys.xyz") {
        if (u.pathname.startsWith("/tx/")) return jres({ id: "B".repeat(43) })
      }
      return new Response("blocked", { status: 599 })
    },
  })
}

const BASE = "https://mcp.djzs.ai"
const MCPH = { "content-type": "application/json", accept: "application/json, text/event-stream" }
const sse = (t) => { const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t) }
let nextId = 100
async function rpc(mf, method, params) {
  const res = await mf.dispatchFetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) })
  const text = await res.text()
  let body = {}
  try { body = sse(text) } catch { /* the checks report it */ }
  return { res, text, body }
}
async function init(mf) {
  const r = await rpc(mf, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pay-test", version: "0" } })
  await (await mf.dispatchFetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text()
  return r
}
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex")
function token(accepted, resource) {
  const now = Math.floor(Date.now() / 1000)
  return Buffer.from(JSON.stringify({
    x402Version: 2, resource, accepted,
    payload: { signature: "0x" + "00".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: String(accepted.amount), validAfter: "0", validBefore: String(now + 300), nonce: "0x" + "11".repeat(32) } },
  })).toString("base64")
}
const post = (mf, id, body) => mf.dispatchFetch(`${BASE}/pay/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })

const mf = worker()
try {
  console.log("1. initialize declares the skills extension and resources")
  const initR = await init(mf)
  const caps = initR.body.result?.capabilities ?? {}
  check("extensions carries io.modelcontextprotocol/skills", !!caps.extensions?.["io.modelcontextprotocol/skills"], JSON.stringify(caps))
  check("resources capability declared", !!caps.resources, JSON.stringify(caps))
  check("tools capability kept", !!caps.tools)

  console.log("2. skills/list, resources/read, skills/get")
  const list = await rpc(mf, "skills/list", {})
  const skills = list.body.result?.skills ?? []
  check("skills/list returns resultType complete, ttlMs and cacheScope", list.body.result?.resultType === "complete" && Number.isInteger(list.body.result?.ttlMs) && typeof list.body.result?.cacheScope === "string", list.text.slice(0, 300))
  const s = skills.find((x) => x.frontmatter?.name === "djzs-trade-audit")
  check("djzs-trade-audit is listed at skill://djzs-trade-audit/SKILL.md", s?.uri === "skill://djzs-trade-audit/SKILL.md", JSON.stringify(skills).slice(0, 300))
  check("the MetaMask skill is not served", !skills.some((x) => x.frontmatter?.name === "djzs-audit-gate"))
  const onDisk = readFileSync(path.resolve(import.meta.dirname, "..", "..", "skills", "djzs-trade-audit", "SKILL.md"), "utf8")
  for (const r of s?.resources ?? []) {
    const read = await rpc(mf, "resources/read", { uri: r.uri })
    const c = read.body.result?.contents?.[0]
    const bytes = Buffer.from(c?.text ?? "", "utf8")
    check(`${r.uri}: served bytes match the manifest digest and size`, `sha256:${sha(c?.text ?? "")}` === r.digest && bytes.length === r.size, `${r.digest} ${r.size} vs ${sha(c?.text ?? "")} ${bytes.length}`)
    if (r.uri.endsWith("/SKILL.md")) {
      check("SKILL.md served byte-identical to skills/ on disk, as text/markdown", c?.text === onDisk && c?.mimeType === "text/markdown")
      check("frontmatter in the listing equals the served SKILL.md frontmatter, field by field", JSON.stringify(s.frontmatter) === JSON.stringify(parseFrontmatter(c?.text ?? "")))
    }
  }
  check("manifest includes SKILL.md", (s?.resources ?? []).some((r) => r.uri === s?.uri))
  const got = await rpc(mf, "skills/get", { uri: "skill://djzs-trade-audit/SKILL.md" })
  check("skills/get returns the same entry", JSON.stringify(got.body.result?.skill) === JSON.stringify(s) && got.body.result?.resultType === "complete", got.text.slice(0, 300))
  const unknown = await rpc(mf, "skills/get", { uri: "skill://nope/SKILL.md" })
  check("skills/get on an unknown URI is -32602", unknown.body.error?.code === -32602, unknown.text.slice(0, 200))
  const rl = await rpc(mf, "resources/list", {})
  check("resources/list includes the skill file", (rl.body.result?.resources ?? []).some((r) => r.uri === "skill://djzs-trade-audit/SKILL.md"), rl.text.slice(0, 300))

  console.log("3. an unpaid paid-tool call keeps the x402 requirement and adds a pay link")
  const unpaid = await rpc(mf, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT } })
  const ur = unpaid.body.result ?? {}
  const xe = ur._meta?.["x402/error"]
  check("still isError with the x402 PAYMENT_REQUIRED requirement", ur.isError === true && xe?.error === "PAYMENT_REQUIRED" && xe?.accepts?.[0]?.payTo === TREASURY && xe?.accepts?.[0]?.amount === "2000000", unpaid.text.slice(0, 300))
  check("content[0] is still exactly the x402 payload", JSON.stringify(JSON.parse(ur.content?.[0]?.text ?? "null")) === JSON.stringify(xe))
  const link = ur._meta?.["ai.djzs/pay"]
  check("_meta carries the pay link", typeof link?.url === "string" && /^https:\/\/mcp\.djzs\.ai\/pay\/ps_[A-Za-z0-9_-]{22}$/.test(link.url) && link.url.endsWith(link.pay_session), JSON.stringify(link))
  check("the text names the link and get_paid_audit", ur.content?.length === 2 && ur.content[1].text.includes(link?.url) && ur.content[1].text.includes("get_paid_audit"), ur.content?.[1]?.text)
  check("the link text is ASCII", /^[\x09\x0a\x20-\x7e]+$/.test(ur.content?.[1]?.text ?? "é"))
  const id = link?.pay_session

  const db = await mf.getD1Database("TELEMETRY")
  const rows = async () => (await db.prepare("SELECT COUNT(*) AS n FROM pay_session").first()).n
  const before = await rows()
  const agentPaid = await rpc(mf, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT }, _meta: { "x402/payment": token(xe.accepts[0], xe.resource) } })
  check("an x402 payer is unaffected: paid in one call, no pay link minted", agentPaid.body.result?.isError !== true && !agentPaid.body.result?._meta?.["ai.djzs/pay"] && (await rows()) === before, agentPaid.text.slice(0, 300))
  const settledByAgent = counts.settle

  console.log("4. the page")
  const page = await mf.dispatchFetch(`${BASE}/pay/${id}`)
  const html = await page.text()
  check("GET /pay/:id is 200 html", page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"))
  check("the thesis is shown escaped", html.includes("&lt;b&gt;on ETF inflow&lt;/b&gt;") && !html.includes("<b>on ETF inflow</b>"))
  check("framing refused, no referrer, no store", page.headers.get("x-frame-options") === "DENY" && (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") && page.headers.get("referrer-policy") === "no-referrer" && page.headers.get("cache-control") === "no-store")
  check("the page names the price and the treasury", html.includes("2.00 USDC") && html.includes(TREASURY))
  const fake = await mf.dispatchFetch(`${BASE}/pay/ps_AAAAAAAAAAAAAAAAAAAAAA`)
  check("a made-up id is 404", fake.status === 404)
  const junk = await mf.dispatchFetch(`${BASE}/pay/not-an-id`)
  check("a malformed id is 404", junk.status === 404)

  console.log("5. money")
  const pending = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: id } })
  check("get_paid_audit before paying: PENDING with the link", pending.body.result?.structuredContent?.status === "PENDING" && pending.body.result.structuredContent.pay_url === link.url, pending.text.slice(0, 300))
  const bad = await post(mf, id, { payment: "!!" })
  check("a malformed payment is 400 and nothing is verified", bad.status === 400)
  mode.verify = "bad"
  const v0 = counts.settle
  const refusedPay = await post(mf, id, { payment: token(xe.accepts[0], xe.resource) })
  const refusedBody = await refusedPay.json()
  check("an underfunded payment is refused at preflight with the facilitator's reason, nothing settled", refusedPay.status === 402 && refusedBody.status === "pending" && refusedBody.detail === "insufficient_funds" && refusedBody.charged === false && counts.settle === v0, JSON.stringify(refusedBody))
  mode.verify = "ok"
  const paid = await post(mf, id, { payment: token(xe.accepts[0], xe.resource) })
  const paidBody = await paid.json()
  check("a good payment: 200 paid with the verdict and the settlement", paid.status === 200 && paidBody.status === "paid" && typeof paidBody.verdict === "string" && paidBody.payment?.transaction === TX && paidBody.charged === true, JSON.stringify(paidBody).slice(0, 300))
  check("settled exactly once", counts.settle === settledByAgent + 1, `${counts.settle} vs ${settledByAgent + 1}`)
  const collected = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: id } })
  const cs = collected.body.result?.structuredContent ?? {}
  check("get_paid_audit: PAID with the full audit and the receipt", cs.status === "PAID" && cs.charged === true && typeof cs.audit?.verdict === "string" && typeof cs.audit?.verdict_hash === "string" && cs.payment?.transaction === TX && collected.body.result?.isError !== true, collected.text.slice(0, 400))
  const again = await post(mf, id, { payment: token(xe.accepts[0], xe.resource) })
  const againBody = await again.json()
  check("paying again settles nothing and says it is already paid", again.status === 200 && againBody.already === true && counts.settle === settledByAgent + 1, JSON.stringify(againBody).slice(0, 200))
  const paidPage = await (await mf.dispatchFetch(`${BASE}/pay/${id}`)).text()
  check("the page now says paid", paidPage.includes("Paid. The audit is done."))

  console.log("6. out of scope, expired, in progress")
  mode.extraction = "perp"
  const wrong = await rpc(mf, "tools/call", { name: "verify_pm_trade", arguments: { intent: PERP_INTENT } })
  const wid = wrong.body.result?._meta?.["ai.djzs/pay"]?.pay_session
  const wxe = wrong.body.result?._meta?.["x402/error"]
  const s1 = counts.settle
  const wrongPay = await post(mf, wid, { payment: token(wxe.accepts[0], wxe.resource) })
  const wrongBody = await wrongPay.json()
  check("a perp thesis paid through the PM tool is refused and settles nothing", wrongBody.status === "refused" && wrongBody.charged === false && counts.settle === s1, JSON.stringify(wrongBody))
  const wrongRead = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: wid } })
  check("get_paid_audit: REFUSED_SCOPE, not charged", wrongRead.body.result?.structuredContent?.status === "REFUSED_SCOPE" && wrongRead.body.result.structuredContent.charged === false)
  mode.extraction = "pm"

  const fresh = await rpc(mf, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT } })
  const fid = fresh.body.result?._meta?.["ai.djzs/pay"]?.pay_session
  const fxe = fresh.body.result?._meta?.["x402/error"]
  await db.prepare("UPDATE pay_session SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), fid).run()
  const expPage = await mf.dispatchFetch(`${BASE}/pay/${fid}`)
  const expPay = await post(mf, fid, { payment: token(fxe.accepts[0], fxe.resource) })
  const expRead = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: fid } })
  check("an expired link: page 410, payment 410, EXPIRED, nothing settled", expPage.status === 410 && expPay.status === 410 && expRead.body.result?.structuredContent?.status === "EXPIRED" && counts.settle === s1)

  const busy = await rpc(mf, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT } })
  const bid = busy.body.result?._meta?.["ai.djzs/pay"]?.pay_session
  const bxe = busy.body.result?._meta?.["x402/error"]
  await db.prepare("UPDATE pay_session SET status = 'paying', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), bid).run()
  const busyPay = await post(mf, bid, { payment: token(bxe.accepts[0], bxe.resource) })
  const busyRead = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: bid } })
  check("a session already being paid: 409, PROCESSING, nothing settled", busyPay.status === 409 && busyRead.body.result?.structuredContent?.status === "PROCESSING" && counts.settle === s1)
  await db.prepare("UPDATE pay_session SET updated_at = ? WHERE id = ?").bind(new Date(Date.now() - 11 * 60 * 1000).toISOString(), bid).run()
  const staleRead = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: bid } })
  check("a claim with no outcome after 10 minutes reads UNCERTAIN, never not-charged", staleRead.body.result?.structuredContent?.status === "UNCERTAIN" && staleRead.body.result.structuredContent.charged === null)

  const nf = await rpc(mf, "tools/call", { name: "get_paid_audit", arguments: { pay_session: "ps_BBBBBBBBBBBBBBBBBBBBBB" } })
  check("get_paid_audit on an unknown session: NOT_FOUND as an error result", nf.body.result?.isError === true && nf.body.result?.structuredContent?.status === "NOT_FOUND")
} finally {
  await mf.dispose()
}

console.log("7. the daily cap stops minting, never the x402 answer")
const capped = worker({ PAY_LINK_DAILY_LIMIT: "1" })
try {
  await init(capped)
  const a = await rpc(capped, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT } })
  const b = await rpc(capped, "tools/call", { name: "verify_pm_trade", arguments: { intent: PM_INTENT } })
  check("first call under the cap gets a link", !!a.body.result?._meta?.["ai.djzs/pay"])
  check("over the cap: no link, the x402 requirement unchanged", !b.body.result?._meta?.["ai.djzs/pay"] && b.body.result?._meta?.["x402/error"]?.error === "PAYMENT_REQUIRED" && b.body.result?.content?.length === 1, b.text.slice(0, 300))
} finally {
  await capped.dispose()
}

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length) { console.error(`PAY-LINK: FAIL (${failures.length})`); process.exit(1) }
console.log("PAY-LINK: PASS")
