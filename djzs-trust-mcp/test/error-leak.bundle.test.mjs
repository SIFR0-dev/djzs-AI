/**
 * No caller-facing response may carry raw error text. Driven against the BUILT Worker bundle in
 * Miniflare (workerd), through the real Hono routes, the real /mcp transport and the real
 * agents/x402 wrapper, with every dependency stubbed at the outbound-fetch layer.
 *
 * Why the bundle and not the handler: the leak paths are spread over index.ts (route catches,
 * health probes, MCP tools, the legacy x402 route), which cannot be imported under Node, and one
 * of them lives in a library (agents/x402 answers `Tool execution failed: ${String(e)}` for any
 * throw out of a paid tool). Only the bundle exercises all of them as they ship.
 *
 * How it proves a leak: every dependency fails with a message that contains a SENTINEL shaped like
 * a provider RPC URL with its key in the path (viem's HttpRequestError begins with the request
 * URL, and BASE_RPC_URL is a Worker secret). If any part of the sentinel reaches a response body
 * or header, the check fails. Run against origin/main's bundle this test is RED on the leak
 * checks; that is the regression it exists to hold.
 *
 * ZERO keys, ZERO egress. The CDP key is generated here and signs nothing real; the attester and
 * writer keys are throwaway hex; every outbound host is answered by a stub or refused (599).
 *
 * miniflare is wrangler's own dependency (hoisted into node_modules); a wrangler bump that nests it fails this
 * import loudly, not silently. The compatibility settings are read from wrangler.toml, and FACILITATOR_URL is
 * NOT set, so the canonical routes use the CDP default URL that ships.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/error-leak.bundle.test.mjs
 *   DJZS_BUNDLE=<path/to/index.js>  to test an already-built bundle (CI passes the dry-run output);
 *   otherwise it builds one with `wrangler deploy --dry-run` (no login, no secrets, no deploy).
 */
import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { encodePaymentSignatureHeader } from "@x402/core/http"

const SENTINEL_URL = "https://rpc.sentinel.invalid/v2/KEYSENTINEL0123456789abcdef"
const PARTS = ["KEYSENTINEL", "sentinel.invalid"]

// A hung workerd request must fail the step, not hold the job for hours.
setTimeout(() => { console.error("ERROR-LEAK: TIMEOUT after 240s"); process.exit(1) }, 240_000).unref()

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 220)}` : ""}`) }
}

// ── bundle ──────────────────────────────────────────────────────────────────────────
let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-leak-"))
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: path.resolve(import.meta.dirname, "..") })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)

// ── fixtures ────────────────────────────────────────────────────────────────────────
const F = (state, value, quote) => state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state }
const PM_X = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market", leverage: F("absent"), position_size: F("present", 250), stop_loss: F("present", "daily close below 66000"), take_profit: F("unknown"), invalidation_condition: F("present", "daily close below 66000"), resolution_engagement: F("unknown"), probability_basis: F("present", "implied 0.41 vs model 0.55"), edge_claim: F("unknown"), data_sources: F("unknown"), oracle_source: F("unknown"), confidence: F("unknown") }
const PM_INTENT = { market: "KXBTC-26AUG29-T70000", side: "YES", thesis: "BTC closes above 70k by Aug 29 on ETF inflow continuation", probability_basis: "implied 0.41 vs model 0.55", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" } }
const STRING_INTENT = "BTC closes above 70k by Aug 29 on ETF inflow continuation; implied 0.41 vs model 0.55; stop on a daily close below 66000"
const PERP_X = { agent_type: "trader", intended_action: "open", market_type: "perp", leverage: F("present", 5), position_size: F("present", 3000), stop_loss: F("present", 76200), take_profit: F("present", 83000), invalidation_condition: F("present", "daily close below 76,200"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("unknown"), thesis_statement: F("present", "funding reset after the weekend flush") }
const PAYER = "0x1111111111111111111111111111111111111111"
const TX = "0x" + "cd".repeat(32)

// A CDP-shaped Ed25519 secret (base64 of seed||public). It signs a JWT for a stub that never checks it.
const kp = generateKeyPairSync("ed25519")
const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32)
const CDP_SECRET = Buffer.concat([seed, pub]).toString("base64")

const TOML = readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8")
if (!/^compatibility_date\s*=/m.test(TOML)) throw new Error("wrangler.toml has no compatibility_date")

// ── stub world ──────────────────────────────────────────────────────────────────────
const mode = { supported: "ok", verify: "ok", settle: "ok", anthropic: "ok", extraction: "pm", subgraph: "500", irysGraphql: "errors", irysUpload: "500" }
const hits = { settle: 0 }
const blocked = new Set()
const jres = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } })

const mk = (extraBindings = {}) => new Miniflare({
  modules: true,
  modulesRoot: path.dirname(path.resolve(bundle)),
  scriptPath: path.resolve(bundle),
  compatibilityDate: TOML.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1],
  compatibilityFlags: JSON.parse((TOML.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])/m)?.[1] ?? "[]")),
  bindings: {
    ENVIRONMENT: "production",
    ANTHROPIC_API_KEY: "stub-not-a-key",
    DJZS_ATTESTER_KEY: "0x" + "11".repeat(32),
    DJZS_WRITER_KEY: "0x" + "22".repeat(32),
    IRYS_UPLOAD_KEY: "0x" + "33".repeat(32),
    BASE_RPC_URL: SENTINEL_URL,
    SUBGRAPH_URL: SENTINEL_URL + "/subgraph",
    CDP_API_KEY_ID: "organizations/stub/apiKeys/stub",
    CDP_API_KEY_SECRET: CDP_SECRET,
    ...extraBindings,
  },
  d1Databases: { TELEMETRY: "local-telemetry" },
  outboundService: async (req) => {
    const u = new URL(req.url)
    if (u.host === "facilitator.test" || u.host === "api.cdp.coinbase.com") {
      const p = u.pathname.replace(/^.*\//, "")
      await req.arrayBuffer().catch(() => {})
      if (p === "supported") return mode.supported === "500" ? new Response(`upstream said no ${SENTINEL_URL}`, { status: 500 }) : jres({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })
      // "junk": the facilitator says no with free text and a non-address payer, both carrying the sentinel.
      if (p === "verify") return mode.verify === "junk" ? jres({ isValid: false, invalidReason: `rejected: ${SENTINEL_URL}`, payer: SENTINEL_URL }) : jres({ isValid: true, payer: PAYER })
      if (p === "settle") {
        hits.settle++
        if (mode.settle === "declineJunk") return jres({ success: false, errorReason: `nope ${SENTINEL_URL}`, payer: SENTINEL_URL, transaction: "", network: "eip155:8453" })
        return mode.settle === "http500" ? new Response(`settle blew up ${SENTINEL_URL}`, { status: 500 }) : jres({ success: true, payer: PAYER, transaction: TX, network: "eip155:8453" })
      }
    }
    if (u.host === "api.anthropic.com") {
      return mode.anthropic === "401"
        ? new Response(`{"error":{"message":"invalid x-api-key at ${SENTINEL_URL}"}}`, { status: 401 })
        : jres({ content: [{ type: "text", text: JSON.stringify(mode.extraction === "perp" ? PERP_X : PM_X) }] })
    }
    if (u.host === "rpc.sentinel.invalid") {
      if (u.pathname.endsWith("/subgraph")) {
        if (mode.subgraph === "badjson") return new Response(`<html>${SENTINEL_URL}`, { status: 200 })
        if (mode.subgraph === "nullrow") return jres({ data: { agent: { id: "x", totalAudits: 1, audits: [null], flags: [] } } })
        return mode.subgraph === "graphql" ? jres({ errors: [{ message: `boom ${SENTINEL_URL}` }] }) : new Response(`subgraph said no ${SENTINEL_URL}`, { status: 500 })
      }
      return new Response(`rpc said no ${SENTINEL_URL}`, { status: 500 })
    }
    if (u.host === "uploader.irys.xyz" || u.host === "devnet.irys.xyz") {
      if (u.pathname.endsWith("/graphql")) {
        if (mode.irysGraphql === "badjson") return new Response(`<html>${SENTINEL_URL}`, { status: 200 })
        if (mode.irysGraphql === "500") return new Response(`irys index said no ${SENTINEL_URL}`, { status: 500 })
        return jres({ errors: [{ message: `irys said no ${SENTINEL_URL}` }] })
      }
      if (mode.irysUpload === "ok" && u.pathname.startsWith("/tx/")) return jres({ id: "B".repeat(43) })
      return new Response(`irys upload rejected ${SENTINEL_URL}`, { status: 500 })
    }
    blocked.add(u.host)
    return new Response("blocked", { status: 599 })
  },
})

const mf = mk()

// ── drivers ─────────────────────────────────────────────────────────────────────────
let world2 = null // a second Worker whose DJZS_WRITER_KEY is a scalar outside the curve order (created on demand)
const leaked = (text, headers) => PARTS.some((p) => text.includes(p) || [...headers.entries()].some(([k, v]) => `${k}: ${v}`.includes(p)))

async function http(url, init) {
  const res = await mf.dispatchFetch(url, init)
  const text = await res.text()
  let body = {}
  try { body = JSON.parse(text) } catch { /* the checks say so */ }
  return { status: res.status, text, body, headers: res.headers }
}

async function payHeader(url) {
  const ch = await (await mf.dispatchFetch(url, { method: "POST", body: "" })).json()
  return encodePaymentSignatureHeader({ x402Version: 2, resource: ch.resource, accepted: ch.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } })
}

const MCP = "https://mcp.djzs.ai/mcp"
const MCPH = { "content-type": "application/json", accept: "application/json, text/event-stream" }
const sse = (t) => { const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t) }
async function mcpSession() {
  const init = await mf.dispatchFetch(MCP, { method: "POST", headers: MCPH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "leak-test", version: "0" } } }) })
  await init.text()
  const sid = init.headers.get("mcp-session-id")
  const h = sid ? { ...MCPH, "mcp-session-id": sid } : MCPH
  await (await mf.dispatchFetch(MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text()
  return h
}
async function mcpCall(h, name, args, meta) {
  const res = await mf.dispatchFetch(MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }) })
  const text = await res.text()
  let body = {}
  try { body = sse(text) } catch { /* the checks say so */ }
  return { status: res.status, text, body, headers: res.headers, tool: body.result?.content?.[0]?.text ?? "" }
}

// ── scenarios ───────────────────────────────────────────────────────────────────────
try {
  const pmUrl = "https://mcp.djzs.ai/x402/verify_pm_trade"
  const hdr = await payHeader(pmUrl)
  const post = (url, h, intent) => http(url, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": h }, body: JSON.stringify({ intent }) })

  console.log("1. canonical PM route, paid: the attestation fails and viem's message begins with the RPC URL")
  {
    const o = await post(pmUrl, hdr, PM_INTENT)
    check("200 with the verdict, charged:true", o.status === 200 && o.body.charged === true && typeof o.body.verdict === "string", `${o.status} ${o.text}`)
    check("eas_error is the fixed code attestation_failed", o.body.eas_error === "attestation_failed", o.body.eas_error)
    check("NO part of the RPC URL / key in the body or headers", !leaked(o.text, o.headers), o.text)
  }

  console.log("2. canonical PM route, paid: extraction fails with a 401 whose body contains the sentinel")
  {
    mode.anthropic = "401"; const s0 = hits.settle
    const o = await post(pmUrl, hdr, PM_INTENT)
    mode.anthropic = "ok"
    check("503 AUDIT_UNAVAILABLE, detail audit_unavailable, and nothing settled (so settled:false is true)", o.status === 503 && o.body.error === "AUDIT_UNAVAILABLE" && o.body.detail === "audit_unavailable" && hits.settle === s0, `${o.status} ${o.text}`)
    check("NO part of the sentinel in the response", !leaked(o.text, o.headers), o.text)
  }

  console.log("3. canonical PM route, paid: settlePayment throws (the facilitator's 500 body contains the sentinel)")
  {
    mode.settle = "http500"
    const o = await post(pmUrl, hdr, PM_INTENT)
    mode.settle = "ok"
    check("502 SETTLEMENT_UNCERTAIN, settled:null charged:null, never settled:false", o.status === 502 && o.body.error === "SETTLEMENT_UNCERTAIN" && o.body.settled === null && o.body.charged === null && !/"settled"\s*:\s*false/.test(o.text), `${o.status} ${o.text}`)
    check("NO part of the sentinel in the response", !leaked(o.text, o.headers), o.text)
  }

  console.log("4. canonical PM route: an intent that cannot be bound is refused before settlement")
  {
    const s0 = hits.settle
    const o = await post(pmUrl, hdr, { side: "YES", size_usd: 250 })
    check("400 intent_unbindable, charged:false, settlePayment never called", o.status === 400 && o.body.error === "intent_unbindable" && o.body.charged === false && hits.settle === s0, `${o.status} ${o.text}`)
  }

  console.log("5. legacy /x402/verify, paid: extraction fails; then settlePayment throws")
  {
    const legacyUrl = "https://mcp.djzs.ai/x402/verify"
    const h = await payHeader(legacyUrl)
    mode.anthropic = "401"
    let o = await post(legacyUrl, h, STRING_INTENT)
    mode.anthropic = "ok"
    check("402 AUDIT_FAILED, detail extraction_failed", o.status === 402 && o.body.error === "AUDIT_FAILED" && o.body.detail === "extraction_failed", `${o.status} ${o.text.slice(0, 200)}`)
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
    mode.settle = "http500"
    o = await post(legacyUrl, h, STRING_INTENT)
    mode.settle = "ok"
    check("502 SETTLEMENT_UNCERTAIN, settled:null charged:null, and NO fresh 402 challenge that would invite a second payment", o.status === 502 && o.body.error === "SETTLEMENT_UNCERTAIN" && o.body.settled === null && o.body.charged === null && !o.headers.get("payment-required"), `${o.status} ${o.text.slice(0, 200)}`)
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
  }

  console.log("6. /health/x402: the facilitator answers 500 with the sentinel; then the attester's RPC fails")
  {
    mode.supported = "500"
    let o = await http("https://mcp.djzs.ai/health/x402", { method: "GET" })
    mode.supported = "ok"
    check("502 with detail facilitator_unavailable", o.status === 502 && o.body.detail === "facilitator_unavailable", `${o.status} ${o.text.slice(0, 200)}`)
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
    o = await http("https://mcp.djzs.ai/health/x402", { method: "GET" })
    check("attester.error is the fixed code attester_balance_unavailable", o.body.attester?.error === "attester_balance_unavailable", `${o.status} ${o.text.slice(0, 240)}`)
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 240))
  }

  console.log("7. /health/writer: the RPC fails (BASE_RPC_URL is the sentinel)")
  {
    const o = await http("https://mcp.djzs.ai/health/writer", { method: "GET" })
    check("authorization_detail is a fixed phrase", typeof o.body.authorization_detail === "string" && /^(rpc error: (over rate limit|timeout|auth rejected by provider|nonce conflict|no result|unclassified)|config error: BASE_RPC_URL malformed|ok)$/.test(o.body.authorization_detail), `${o.status} ${o.text.slice(0, 240)}`)
    check("NO part of the sentinel (and no provider host)", !leaked(o.text, o.headers), o.text.slice(0, 240))
  }

  console.log("8. /mcp free tools: the subgraph fails twice (HTTP 500, then GraphQL errors), the Irys index returns errors")
  {
    const h = await mcpSession()
    let o = await mcpCall(h, "query_agent_trust", { agentAddress: PAYER })
    check("query_agent_trust, HTTP 500 upstream: detail subgraph_http_500", /subgraph_http_500/.test(o.tool), o.tool.slice(0, 200))
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
    mode.subgraph = "graphql"
    o = await mcpCall(h, "query_agent_trust", { agentAddress: PAYER })
    mode.subgraph = "500"
    check("query_agent_trust, GraphQL errors upstream: detail subgraph_graphql_error", /subgraph_graphql_error/.test(o.tool), o.tool.slice(0, 200))
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
    o = await mcpCall(h, "query_pol_certificates", { limit: 1 })
    check("query_pol_certificates, errors upstream: the code irys_graphql_error", /irys_graphql_error/.test(o.tool), o.tool.slice(0, 200))
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 200))
  }

  console.log("9. /mcp paid tool, a valid payment: extraction throws inside the handler")
  {
    const h = await mcpSession()
    const first = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT })
    const challenge = first.body.result?._meta?.["x402/error"]
    check("without a payment the tool answers a payment-required error", challenge?.error === "PAYMENT_REQUIRED" && Array.isArray(challenge?.accepts), first.text.slice(0, 200))
    if (challenge?.accepts?.[0]) {
      const token = btoa(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } }))
      const s0 = hits.settle
      mode.anthropic = "401"
      const o = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT }, { "x402/payment": token })
      mode.anthropic = "ok"
      check("the result is the fixed TOOL_ERROR, isError (so withX402 does not settle)", /TOOL_ERROR/.test(o.tool) && o.body.result?.isError === true && hits.settle === s0, `${o.tool.slice(0, 200)} settle +${hits.settle - s0}`)
      check("NO part of the sentinel, and not 'Tool execution failed: ...'", !leaked(o.text, o.headers) && !/Tool execution failed/.test(o.text), o.text.slice(0, 240))

      // And the happy path with a failing Irys upload: the anchor error is a code.
      const ok = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT }, { "x402/payment": token })
      check("with a working model the verdict returns and pol_certificate.detail is anchor_failed", /anchor_failed/.test(ok.tool), ok.tool.slice(0, 300))
      check("NO part of the sentinel", !leaked(ok.text, ok.headers), ok.text.slice(0, 300))
    }
  }

  console.log("10. /mcp paid tool: the FACILITATOR says no with free text and a non-address payer (agents/x402 builds that result itself)")
  {
    const h = await mcpSession()
    const first = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT })
    const challenge = first.body.result?._meta?.["x402/error"]
    const token = btoa(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } }))
    mode.verify = "junk"
    let o = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT }, { "x402/payment": token })
    mode.verify = "ok"
    const e1 = o.body.result?._meta?.["x402/error"]
    check("verify refused: error becomes the fixed PAYMENT_FAILED, payer (not an address) is dropped", e1?.error === "PAYMENT_FAILED" && !("payer" in (e1 ?? {})), JSON.stringify(e1).slice(0, 200))
    check("NO part of the sentinel in content[0].text or _meta", !leaked(o.text, o.headers), o.text.slice(0, 240))
    mode.settle = "declineJunk"
    o = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT }, { "x402/payment": token })
    mode.settle = "ok"
    const e2 = o.body.result?._meta?.["x402/error"]
    check("settle declined with free text: error becomes the fixed PAYMENT_FAILED", e2?.error === "PAYMENT_FAILED", JSON.stringify(e2).slice(0, 200))
    check("NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 240))
    o = await mcpCall(h, "verify_pm_trade", { intent: STRING_INTENT }, { "x402/payment": token })
    check("a good payment still returns the verdict with a clean receipt (tx, payer)", /"verdict"/.test(o.tool) && o.body.result?._meta?.["x402/payment-response"]?.transaction === TX && o.body.result?._meta?.["x402/payment-response"]?.payer === PAYER, o.text.slice(0, 200))
  }

  console.log("11. legacy /x402/verify: the facilitator refuses with free text and a non-address payer")
  {
    const legacyUrl = "https://mcp.djzs.ai/x402/verify"
    const h = await payHeader(legacyUrl)
    mode.verify = "junk"
    const o = await post(legacyUrl, h, STRING_INTENT)
    mode.verify = "ok"
    const hdrBody = o.headers.get("payment-required") ? Buffer.from(o.headers.get("payment-required"), "base64").toString("utf8") : ""
    check("402 INVALID_PAYMENT, and no payer in the body", o.status === 402 && o.body.error === "INVALID_PAYMENT" && !o.body.payer, o.text.slice(0, 200))
    check("NO part of the sentinel in the body, the headers or the decoded PAYMENT-REQUIRED header", !leaked(o.text, o.headers) && !PARTS.some((p) => hdrBody.includes(p)), o.text.slice(0, 200))
  }

  console.log("12. an unhandled route error: the app's own handler answers the same fixed text")
  {
    world2 = mk({ DJZS_WRITER_KEY: "0x" + "00".repeat(32) })
    const r = await world2.dispatchFetch("https://mcp.djzs.ai/health/writer", { method: "GET" })
    const text = await r.text()
    check("500 with the fixed text and nothing else", r.status === 500 && text === "Internal Server Error", `${r.status} ${text.slice(0, 120)}`)
  }

  console.log("13. legacy /x402/verify, paid, with an agent_address: the trust-score write cannot lose a paid verdict (out-of-range writer key)")
  {
    mode.irysUpload = "ok"
    const legacyUrl = "https://mcp.djzs.ai/x402/verify"
    const ch = await (await world2.dispatchFetch(legacyUrl, { method: "POST", body: "" })).json()
    const hdr2 = encodePaymentSignatureHeader({ x402Version: 2, resource: ch.resource, accepted: ch.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } })
    const res = await world2.dispatchFetch(legacyUrl, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": hdr2 }, body: JSON.stringify({ intent: STRING_INTENT, agent_address: PAYER }) })
    const text = await res.text()
    mode.irysUpload = "500"
    let body = {}
    try { body = JSON.parse(text) } catch { /* the checks say so */ }
    check("200 with the verdict (not a bare 500 after the payer was charged)", res.status === 200 && typeof body.verdict === "string", `${res.status} ${text.slice(0, 200)}`)
    check("the certificate anchored and trust_score reports the failure as a fixed code", body.pol_certificate?.status === "anchored" && body.trust_score?.status === "error" && body.trust_score?.detail === "trust_write_failed", JSON.stringify({ pol: body.pol_certificate?.status, ts: body.trust_score }).slice(0, 240))
    check("nothing of the key or the error in the response", !PARTS.some((p) => text.includes(p)) && !/valid private key|got 0/.test(text), text.slice(0, 200))
  }

  console.log("14. every guarded /mcp tool, driven through a throwing dependency (a tool that lost its guard would return the raw text)")
  {
    const h = await mcpSession()
    // verify_perp_trade, paid, extraction fails
    const first = await mcpCall(h, "verify_perp_trade", { intent: STRING_INTENT })
    const challenge = first.body.result?._meta?.["x402/error"]
    const token = btoa(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } }))
    const s0 = hits.settle
    mode.anthropic = "401"
    let o = await mcpCall(h, "verify_perp_trade", { intent: STRING_INTENT }, { "x402/payment": token })
    mode.anthropic = "ok"
    check("verify_perp_trade: the result is the fixed TOOL_ERROR, isError, not settled", /TOOL_ERROR/.test(o.tool) && o.body.result?.isError === true && hits.settle === s0, `${o.tool.slice(0, 200)} settle +${hits.settle - s0}`)
    check("verify_perp_trade: NO part of the sentinel, not 'Tool execution failed'", !leaked(o.text, o.headers) && !/Tool execution failed/.test(o.text), o.text.slice(0, 240))
    // verify_perp_trade, paid, a perp-shaped extraction, the Irys upload rejects with the sentinel
    mode.extraction = "perp"
    o = await mcpCall(h, "verify_perp_trade", { intent: STRING_INTENT }, { "x402/payment": token })
    mode.extraction = "pm"
    check("verify_perp_trade: the verdict returns and pol_certificate.detail is anchor_failed", /anchor_failed/.test(o.tool), o.tool.slice(0, 300))
    check("verify_perp_trade: NO part of the sentinel", !leaked(o.text, o.headers), o.text.slice(0, 300))
    // query_pol_certificates: the Irys index connection is lost (fetch rejects, outside any try in the tool)
    mode.irysGraphql = "badjson" // .json() throws OUTSIDE any try in the tool
    o = await mcpCall(h, "query_pol_certificates", { limit: 1 })
    mode.irysGraphql = "errors"
    check("query_pol_certificates: an exception outside its own try becomes the fixed TOOL_ERROR", /TOOL_ERROR/.test(o.tool) && o.body.result?.isError === true, o.tool.slice(0, 200))
    // query_agent_trust: a malformed subgraph row throws OUTSIDE the tool's own try
    const realSub = mode.subgraph
    mode.subgraph = "nullrow"
    o = await mcpCall(h, "query_agent_trust", { agentAddress: PAYER })
    mode.subgraph = realSub
    check("query_agent_trust: an exception outside its own try becomes the fixed TOOL_ERROR", /TOOL_ERROR/.test(o.tool) && o.body.result?.isError === true, o.tool.slice(0, 200))
  }

  console.log("15. paths the stub world used to never reach (an unreadable answer, a non-2xx index, a decline with free text, the real writer failing)")
  {
    const h = await mcpSession()
    mode.subgraph = "badjson" // .json() throws INSIDE the tool's try: its own catch answers
    let o = await mcpCall(h, "query_agent_trust", { agentAddress: PAYER })
    mode.subgraph = "500"
    check("query_agent_trust: an unreadable subgraph answer -> subgraph_unreachable, no body echoed", /subgraph_unreachable/.test(o.tool) && !leaked(o.text, o.headers), o.tool.slice(0, 200))
    mode.irysGraphql = "500"
    o = await mcpCall(h, "query_pol_certificates", { limit: 1 })
    mode.irysGraphql = "errors"
    check("query_pol_certificates: a non-2xx Irys index -> irys_http_500, no body echoed", /irys_http_500/.test(o.tool) && !leaked(o.text, o.headers), o.tool.slice(0, 200))

    const legacyUrl = "https://mcp.djzs.ai/x402/verify"
    const lh = await payHeader(legacyUrl)
    mode.supported = "500"
    o = await post(legacyUrl, lh, STRING_INTENT)
    mode.supported = "ok"
    check("legacy: the facilitator cannot initialise -> 503 FACILITATOR_UNAVAILABLE, fixed code, no body echoed", o.status === 503 && o.body.error === "FACILITATOR_UNAVAILABLE" && o.body.detail === "facilitator_unavailable" && !leaked(o.text, o.headers), `${o.status} ${o.text.slice(0, 200)}`)
    mode.settle = "declineJunk"
    o = await post(legacyUrl, lh, STRING_INTENT)
    mode.settle = "ok"
    check("legacy: settle declined with free text -> the free text is not relayed", o.status === 402 && !leaked(o.text, o.headers) && o.body.error === "SETTLEMENT_FAILED", `${o.status} ${o.text.slice(0, 200)}`)
    o = await post(legacyUrl, lh, STRING_INTENT)
    check("legacy: the Irys upload rejects with the sentinel -> 200 with the verdict and pol_certificate.detail anchor_failed", o.status === 200 && o.body.pol_certificate?.detail === "anchor_failed" && !leaked(o.text, o.headers), `${o.status} ${o.text.slice(0, 240)}`)

    // the REAL trust writer (valid throwaway key) against an RPC that is the sentinel: viem's error begins with the URL
    mode.irysUpload = "ok"
    const res = await mf.dispatchFetch(legacyUrl, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": lh }, body: JSON.stringify({ intent: STRING_INTENT, agent_address: PAYER }) })
    const text = await res.text()
    mode.irysUpload = "500"
    let body = {}
    try { body = JSON.parse(text) } catch { /* the checks say so */ }
    check("legacy: the real trust-score write fails -> trust_score.detail trust_write_failed, the verdict still returned", res.status === 200 && body.pol_certificate?.status === "anchored" && body.trust_score?.status === "error" && body.trust_score?.detail === "trust_write_failed", `${res.status} ${text.slice(0, 280)}`)
    check("legacy: NO part of the RPC URL in that response", !PARTS.some((p) => text.includes(p)), text.slice(0, 240))
  }

  console.log("16. the only outbound hosts the Worker was refused are the public fallback RPCs and devnet Irys")
  {
    const allowed = new Set(["mainnet.base.org", "base-rpc.publicnode.com", "devnet.irys.xyz"])
    const stray = [...blocked].filter((h) => !allowed.has(h))
    check("no unexpected outbound host (a new dependency calling out would show here)", stray.length === 0, stray.join(", "))
  }
} finally {
  await mf.dispose()
  if (world2) await world2.dispose()
}

console.log(`\nunrelated egress refused (599): ${[...blocked].join(", ") || "none"}`)
if (failures.length) {
  console.error(`\nERROR-LEAK: FAIL (${failures.length} of ${checks} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nERROR-LEAK: PASS (${checks} checks)`)
