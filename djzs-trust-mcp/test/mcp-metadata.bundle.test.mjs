/**
 * MCP handshake + tool metadata, checked against the BUILT Worker bundle in Miniflare, through the
 * real /mcp transport. Holds the directory-compatibility fixes of 2026-11-20:
 *   - initialize returns serverInfo.title / description / websiteUrl / icons (SVG + >=128px) and
 *     non-empty instructions, with name/version and the tools capability unchanged;
 *   - every tool declares boolean readOnlyHint / destructiveHint / idempotentHint / openWorldHint,
 *     a title, and an outputSchema;
 *   - every SUCCESSFUL call returns structuredContent that the SDK accepts against that schema
 *     (a paid result is validated after settlement, so a schema miss would cost the payer a verdict).
 *
 * ZERO keys, ZERO egress: every outbound host is stubbed or refused, like error-leak.bundle.test.mjs.
 * Run from djzs-trust-mcp/:   npx tsx test/mcp-metadata.bundle.test.mjs
 *   DJZS_BUNDLE=<path/to/index.js> to test an already-built bundle; otherwise it builds one with
 *   `wrangler deploy --dry-run` (no login, no secrets, no deploy).
 */
import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"

setTimeout(() => { console.error("MCP-METADATA: TIMEOUT after 180s"); process.exit(1) }, 180_000).unref()

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}

let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-meta-"))
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)

const F = (state, value, quote) => state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state }
const PM_X = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market", leverage: F("absent"), position_size: F("present", 250), stop_loss: F("present", "daily close below 66000"), take_profit: F("unknown"), invalidation_condition: F("present", "daily close below 66000"), resolution_engagement: F("unknown"), probability_basis: F("present", "implied 0.41 vs model 0.55"), edge_claim: F("unknown"), data_sources: F("unknown"), oracle_source: F("unknown"), confidence: F("unknown") }
const PERP_X = { agent_type: "trader", intended_action: "open", market_type: "perp", leverage: F("present", 5), position_size: F("present", 3000), stop_loss: F("present", 76200), take_profit: F("present", 83000), invalidation_condition: F("present", "daily close below 76,200"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("unknown"), thesis_statement: F("present", "funding reset after the weekend flush") }
const PM_INTENT = "BTC closes above 70k by Aug 29 on ETF inflow continuation; implied 0.41 vs model 0.55; stop on a daily close below 66000"
const PERP_INTENT = "Long BTC-PERP 5x, size 3000 USD on Binance, entry 78000, stop 76200, target 83000, because funding reset after the weekend flush"
const PAYER = "0x1111111111111111111111111111111111111111"
const AGENT = "0x2222222222222222222222222222222222222222"
const TX = "0x" + "cd".repeat(32)

const kp = generateKeyPairSync("ed25519")
const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32)
const CDP_SECRET = Buffer.concat([seed, pub]).toString("base64")
const TOML = readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8")

const mode = { extraction: "pm", subgraph: "ok" }
const jres = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } })
const audits = [...Array(9).fill({ verdict: "PASS" }), ...Array(3).fill({ verdict: "FAIL" }), { verdict: "WAIT" }]

const mf = new Miniflare({
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
    BASE_RPC_URL: "https://rpc.stub.invalid/",
    SUBGRAPH_URL: "https://subgraph.stub.invalid/",
    CDP_API_KEY_ID: "organizations/stub/apiKeys/stub",
    CDP_API_KEY_SECRET: CDP_SECRET,
  },
  d1Databases: { TELEMETRY: "local-telemetry" },
  outboundService: async (req) => {
    const u = new URL(req.url)
    await req.arrayBuffer().catch(() => {})
    if (u.host === "facilitator.test" || u.host === "api.cdp.coinbase.com") {
      const p = u.pathname.replace(/^.*\//, "")
      if (p === "supported") return jres({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })
      if (p === "verify") return jres({ isValid: true, payer: PAYER })
      if (p === "settle") return jres({ success: true, payer: PAYER, transaction: TX, network: "eip155:8453" })
    }
    if (u.host === "api.anthropic.com") return jres({ content: [{ type: "text", text: JSON.stringify(mode.extraction === "perp" ? PERP_X : PM_X) }] })
    if (u.host === "subgraph.stub.invalid") {
      if (mode.subgraph === "none") return jres({ data: { agent: null } })
      return jres({ data: { agent: { id: AGENT, totalAudits: 13, passCount: 9, failCount: 4, latestVerdict: "PASS", latestRiskScore: 10, audits, flags: [{ code: "DJZS-S01" }] } } })
    }
    if (u.host === "uploader.irys.xyz" || u.host === "devnet.irys.xyz") {
      if (u.pathname.endsWith("/graphql")) return jres({ data: { transactions: { edges: [{ node: { id: "A".repeat(43), timestamp: 1763600000000, tags: [{ name: "verdict", value: "PASS" }, { name: "tier", value: "micro" }, { name: "audit-id", value: "00000000-0000-4000-8000-000000000000" }] } }] } } })
      if (u.pathname.startsWith("/tx/")) return jres({ id: "B".repeat(43) })
    }
    return new Response("blocked", { status: 599 })
  },
})

const MCP = "https://mcp.djzs.ai/mcp"
const MCPH = { "content-type": "application/json", accept: "application/json, text/event-stream" }
const sse = (t) => { const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t) }
let nextId = 10
async function rpc(h, method, params) {
  const res = await mf.dispatchFetch(MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) })
  const text = await res.text()
  let body = {}
  try { body = sse(text) } catch { /* checks report it */ }
  return { res, text, body }
}
async function session() {
  const init = await rpc(MCPH, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "meta-test", version: "0" } })
  const sid = init.res.headers.get("mcp-session-id")
  const h = sid ? { ...MCPH, "mcp-session-id": sid } : MCPH
  await (await mf.dispatchFetch(MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text()
  return { h, init }
}
async function paidCall(h, name, args) {
  const first = await rpc(h, "tools/call", { name, arguments: args })
  const ch = first.body.result?._meta?.["x402/error"]
  if (!ch?.accepts?.[0]) return { first }
  const token = btoa(JSON.stringify({ x402Version: 2, resource: ch.resource, accepted: ch.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } }))
  return { first, paid: await rpc(h, "tools/call", { name, arguments: args, _meta: { "x402/payment": token } }) }
}
const ok = (r) => r && !r.body.error && r.body.result && r.body.result.isError !== true && r.body.result.structuredContent && typeof r.body.result.structuredContent === "object"

try {
  console.log("1. initialize: serverInfo + instructions")
  const { h, init } = await session()
  const info = init.body.result?.serverInfo ?? {}
  check("name and version unchanged", info.name === "djzs-trust-mcp" && info.version === "1.0.0", JSON.stringify(info))
  check("title present", typeof info.title === "string" && info.title.length >= 3, info.title)
  check("description present", typeof info.description === "string" && info.description.length >= 40, info.description)
  check("websiteUrl is https", /^https:\/\//.test(info.websiteUrl ?? ""), info.websiteUrl)
  const icons = info.icons ?? []
  check("an SVG or >=128px icon", icons.some((i) => i.mimeType === "image/svg+xml" || (i.sizes ?? []).some((s) => Number(s.split("x")[0]) >= 128)), JSON.stringify(icons))
  check("instructions present", typeof init.body.result?.instructions === "string" && init.body.result.instructions.length >= 80, init.body.result?.instructions)
  check("tools capability kept", !!init.body.result?.capabilities?.tools, JSON.stringify(init.body.result?.capabilities))

  console.log("2. tools/list: annotations, titles, output schemas")
  const list = await rpc(h, "tools/list", {})
  const tools = list.body.result?.tools ?? []
  check("four tools", tools.length === 4, tools.map((t) => t.name).join(","))
  for (const t of tools) {
    const a = t.annotations ?? {}
    check(`${t.name}: four boolean hints`, ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every((k) => typeof a[k] === "boolean"), JSON.stringify(a))
    check(`${t.name}: title`, typeof t.title === "string" && t.title.length > 0 && !/DJZS|\(/.test(t.title) || t.name === "query_pol_certificates", t.title)
    check(`${t.name}: outputSchema object`, t.outputSchema?.type === "object", JSON.stringify(t.outputSchema)?.slice(0, 120))
    const props = t.inputSchema?.properties ?? {}
    const missing = []
    const walk = (p, pre) => { for (const [k, v] of Object.entries(p)) { if (!v.description) missing.push(pre + k); if (v.properties) walk(v.properties, `${pre}${k}.`) } }
    walk(props, "")
    check(`${t.name}: every input described`, missing.length === 0, missing.join(","))
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]))
  check("query tools are read-only", by.query_pol_certificates?.readOnlyHint === true && by.query_agent_trust?.readOnlyHint === true)
  check("paid tools are not read-only and not idempotent", by.verify_pm_trade?.readOnlyHint === false && by.verify_perp_trade?.idempotentHint === false)

  console.log("3. successful calls carry structuredContent the SDK accepts")
  const pol = await rpc(h, "tools/call", { name: "query_pol_certificates", arguments: {} })
  check("query_pol_certificates", ok(pol) && pol.body.result.structuredContent.total_returned === 1, pol.text.slice(0, 300))
  const trust = await rpc(h, "tools/call", { name: "query_agent_trust", arguments: { agentAddress: AGENT } })
  check("query_agent_trust (OK)", ok(trust) && trust.body.result.structuredContent.status === "OK", trust.text.slice(0, 300))
  mode.subgraph = "none"
  const none = await rpc(h, "tools/call", { name: "query_agent_trust", arguments: { agentAddress: AGENT } })
  check("query_agent_trust (no_history)", ok(none) && none.body.result.structuredContent.status === "no_history", none.text.slice(0, 300))
  mode.subgraph = "ok"
  const pm = await paidCall(h, "verify_pm_trade", { intent: PM_INTENT })
  check("verify_pm_trade: unpaid call is a payment-required error", pm.first.body.result?.isError === true, pm.first.text.slice(0, 200))
  check("verify_pm_trade: paid call returns a verdict as structuredContent", ok(pm.paid) && typeof pm.paid.body.result.structuredContent.verdict === "string", pm.paid?.text.slice(0, 400))
  mode.extraction = "perp"
  const perp = await paidCall(h, "verify_perp_trade", { intent: PERP_INTENT, bracket: { side: "long", entry: 78000, stop: 76200, target: 83000, taker_fee_bps: 4.5 } })
  check("verify_perp_trade: paid call returns a verdict as structuredContent", ok(perp.paid) && typeof perp.paid.body.result.structuredContent.verdict === "string", perp.paid?.text.slice(0, 400))
} finally {
  await mf.dispose()
}

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length) { console.error(`MCP-METADATA: FAIL (${failures.length})`); process.exit(1) }
console.log("MCP-METADATA: PASS")
