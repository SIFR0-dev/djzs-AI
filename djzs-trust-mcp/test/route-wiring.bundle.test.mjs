/**
 * Which resource does each paid URL serve? Driven against the BUILT Worker bundle in Miniflare (workerd),
 * through the real Hono routes, with every outbound host stubbed or refused.
 *
 * Why this exists. ResourceSpec.route selects the class of the permanent, non-revocable attestation
 * (pm_trade or perp_trade) and ResourceSpec.rulesetVersion names the ruleset it is scored under. The unit
 * tests pin the mapping and the handler tests pass `spec` explicitly, so NOTHING pinned the connection that
 * chooses the spec per URL: dropping `PERP_RESOURCE` from the perp mount, passing it on the PM mount, or
 * changing the handler's default survived tsc and every other CI step (found by mutation in the 2026-10-21
 * review). This test posts one paid call to each URL and pins what comes out.
 *
 * Per URL: the 402 challenge names ITS resource (url and description), and a paid call with the route's
 * published example body returns the PINNED intent_hash (the PM example under the pm_trade mapping, the perp
 * example under the perp_trade mapping). The same bodies under the other class hash differently, so a
 * swapped wiring changes the number.
 *
 * ZERO keys, ZERO egress. The CDP key is generated here and signs nothing real; the attester key is throwaway
 * hex; every outbound host is answered by a stub or refused (599).
 *
 * Run from djzs-trust-mcp/:   npx tsx test/route-wiring.bundle.test.mjs
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

setTimeout(() => { console.error("ROUTE-WIRING: TIMEOUT after 120s"); process.exit(1) }, 120_000).unref()

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 240)}` : ""}`) }
}

let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-wiring-"))
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)

// ── fixtures ───────────────────────────────────────────────────────────────────
const TOML = readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8")
const PAYER = "0x1111111111111111111111111111111111111111"
const TX = "0x" + "cd".repeat(32)
const F = (state, value) => state === "present" ? { state, value } : { state }
const PM_X = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market", leverage: F("absent"), position_size: F("present", 250), stop_loss: F("present", "daily close below 66000"), take_profit: F("unknown"), invalidation_condition: F("present", "daily close below 66000"), resolution_engagement: F("unknown"), probability_basis: F("present", "implied 0.41 vs model 0.55"), edge_claim: F("unknown"), data_sources: F("unknown"), oracle_source: F("unknown"), confidence: F("unknown") }
const PERP_X = { agent_type: "trader", intended_action: "open", market_type: "perp", leverage: F("present", 5), position_size: F("present", 3000), stop_loss: F("present", 76200), take_profit: F("present", 83000), invalidation_condition: F("present", "daily close below 76,200"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("unknown"), thesis_statement: F("present", "funding reset after the weekend flush") }
// the two routes' published example bodies (their 402 challenges carry exactly these)
const PM_INTENT = { market: "KXBTC-26AUG29-T70000", side: "YES", thesis: "BTC closes above 70k by Aug 29 on ETF inflow continuation", probability_basis: "implied 0.41 vs model 0.55", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" } }
const PERP_INTENT = { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance", thesis: "Funding reset to 2% after the weekend flush; 80K held on the daily close; ETF inflows resumed. Invalidation: daily close below 76,200. Oracle: Binance mark price." }
// the pinned keys: the PM example under pm_trade, the perp example under perp_trade (djzs-intent.test.mjs pins the perp one too)
const PM_PINNED = "0xd2fad3105347d1bbaeb21390b6960403f76605da6cd1450590ab71e3360dd933"
const PERP_PINNED = "0xb7fbfdab14efbc842bd235439b995791f160610b266ea154dd52a43631ed8c19"

// A CDP-shaped Ed25519 secret (base64 of seed||public). It signs a JWT for a stub that never checks it.
const kp = generateKeyPairSync("ed25519")
const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32)
const CDP_SECRET = Buffer.concat([seed, pub]).toString("base64")

let extraction = PM_X
let settleHits = 0
const blocked = new Set()
const jres = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } })
const mf = new Miniflare({
  modules: true, modulesRoot: path.dirname(path.resolve(bundle)), scriptPath: path.resolve(bundle),
  compatibilityDate: TOML.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1],
  compatibilityFlags: JSON.parse(TOML.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])/m)?.[1] ?? "[]"),
  bindings: { ENVIRONMENT: "production", ANTHROPIC_API_KEY: "stub-not-a-key", DJZS_ATTESTER_KEY: "0x" + "11".repeat(32), CDP_API_KEY_ID: "organizations/stub/apiKeys/stub", CDP_API_KEY_SECRET: CDP_SECRET },
  d1Databases: { TELEMETRY: "local-telemetry" },
  outboundService: async (req) => {
    const u = new URL(req.url)
    await req.arrayBuffer().catch(() => {})
    if (u.host === "api.cdp.coinbase.com") {
      const p = u.pathname.replace(/^.*\//, "")
      if (p === "supported") return jres({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })
      if (p === "verify") return jres({ isValid: true, payer: PAYER })
      if (p === "settle") { settleHits++; return jres({ success: true, payer: PAYER, transaction: TX, network: "eip155:8453" }) }
    }
    if (u.host === "api.anthropic.com") return jres({ content: [{ type: "text", text: JSON.stringify(extraction) }] })
    blocked.add(u.host)
    return new Response("blocked", { status: 599 })
  },
})

async function challenge(url) {
  const res = await mf.dispatchFetch(url, { method: "POST", body: "" })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
async function paid(url, intent) {
  const ch = await challenge(url)
  const header = encodePaymentSignatureHeader({ x402Version: 2, resource: ch.body.resource, accepted: ch.body.accepts[0], payload: { signature: "0x" + "00".repeat(65), authorization: {} } })
  const before = settleHits
  const res = await mf.dispatchFetch(url, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header }, body: JSON.stringify({ intent }) })
  const text = await res.text()
  let body = {}
  try { body = JSON.parse(text) } catch { /* the checks say so */ }
  return { status: res.status, body, text, settled: settleHits - before, challenge: ch }
}

const PM_URL = "https://mcp.djzs.ai/x402/verify_pm_trade"
const PERP_URL = "https://mcp.djzs.ai/x402/verify_perp_trade"
try {
  console.log("1. each URL's 402 challenge names ITS resource")
  const pmCh = await challenge(PM_URL), perpCh = await challenge(PERP_URL)
  check("pm URL: 402 with resource.url = the pm URL", pmCh.status === 402 && pmCh.body.resource?.url === PM_URL, `${pmCh.status} ${pmCh.body.resource?.url}`)
  check("perp URL: 402 with resource.url = the perp URL", perpCh.status === 402 && perpCh.body.resource?.url === PERP_URL, `${perpCh.status} ${perpCh.body.resource?.url}`)
  check("pm URL: the description is the prediction-market one, not the perp one", /prediction-market trade intent/i.test(pmCh.body.resource?.description ?? "") && !/perpetual/i.test(pmCh.body.resource?.description ?? ""), pmCh.body.resource?.description)
  check("perp URL: the description is the perpetual-or-spot one", /perpetual or spot/i.test(perpCh.body.resource?.description ?? ""), perpCh.body.resource?.description)
  check("the two challenges differ (a shared spec would make them equal but for the URL)", JSON.stringify(pmCh.body.extensions) !== JSON.stringify(perpCh.body.extensions))

  console.log("2. a paid call to each URL, the published example body, returns the PINNED class's intent_hash")
  extraction = PERP_X
  const p = await paid(PERP_URL, PERP_INTENT)
  check("perp URL, paid: 200, charged once", p.status === 200 && p.settled === 1 && p.body.charged === true, `${p.status} settle+${p.settled} ${p.text.slice(0, 160)}`)
  check("perp URL: intent_hash is the PINNED perp_trade key", p.body.intent_hash === PERP_PINNED, String(p.body.intent_hash))
  extraction = PM_X
  const m = await paid(PM_URL, PM_INTENT)
  check("pm URL, paid: 200, charged once", m.status === 200 && m.settled === 1 && m.body.charged === true, `${m.status} settle+${m.settled} ${m.text.slice(0, 160)}`)
  check("pm URL: intent_hash is the PINNED pm_trade key (the perp mapping would give this body a different one)", m.body.intent_hash === PM_PINNED, String(m.body.intent_hash))
  check("the two keys differ", m.body.intent_hash !== p.body.intent_hash)

  console.log("3. the other class's body is refused uncharged on each URL (the route decides, never the body)")
  extraction = PM_X
  const pmGetsPerp = await paid(PM_URL, PERP_INTENT)
  check("pm URL, a perp-shaped body: 400 intent_unbindable, not settled", pmGetsPerp.status === 400 && pmGetsPerp.body.error === "intent_unbindable" && pmGetsPerp.settled === 0, `${pmGetsPerp.status} settle+${pmGetsPerp.settled}`)
  extraction = PERP_X
  const perpGetsPm = await paid(PERP_URL, PM_INTENT)
  check("perp URL, a pm-shaped body: binds as perp_trade (its `market` is the market), a DIFFERENT key from the pm example under pm_trade", perpGetsPm.status === 200 && perpGetsPm.body.intent_hash !== PM_PINNED && /^0x[0-9a-f]{64}$/.test(perpGetsPm.body.intent_hash), `${perpGetsPm.status} ${perpGetsPm.body.intent_hash}`)

  // The attester has no funded key here, so the attestation (fail-open) tries the public Base RPCs and is refused (599): expected.
  const allowed = new Set(["mainnet.base.org", "base-rpc.publicnode.com", "devnet.irys.xyz"])
  const stray = [...blocked].filter((h) => !allowed.has(h))
  check("no outbound host beyond the public Base RPCs / devnet Irys was reached", stray.length === 0, stray.join(", "))
} finally {
  await mf.dispose()
}

if (failures.length) {
  console.error(`\nROUTE-WIRING: FAIL (${failures.length} of ${checks} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nROUTE-WIRING: PASS (${checks} checks)`)
