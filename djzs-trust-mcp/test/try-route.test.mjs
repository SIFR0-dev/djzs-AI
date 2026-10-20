/**
 * /try - the free, wallet-capped verdict route. Offline: stub model, in-memory D1, a throwaway
 * signing key (Hardhat account #0, public, unfunded). No network.
 *
 * Pins the contract the page relies on:
 *   - the signed text is address + UTC day + intent sha256, exactly TRY_MESSAGE_FORMAT filled in;
 *   - a wrong signer, a wrong day, or a signature for a different intent is refused before any
 *     slot is reserved or any extraction runs;
 *   - 5 per wallet per day, then 429; the global cap, then 429 with the wallet slot released;
 *   - a pipeline failure releases the slot; a scope refusal keeps it;
 *   - a verdict carries the same binding keys the paid route would (intent_sha256, intent_hash),
 *     attested:false, and the paid route's offer;
 *   - no D1 binding => 503 before the model is called (fail closed).
 *
 * Run: npx tsx test/try-route.test.mjs
 */
import { privateKeyToAccount } from "viem/accounts"
import { handleTryQuota, handleTryVerdict, tryMessage, TRY_MESSAGE_FORMAT, TRY_DAILY_LIMIT, utcDay } from "../src/try-route.ts"
import { intentSha256 } from "../src/engine-adapter.ts"
import { intentHash, toDJZSIntent } from "../src/djzs-intent.ts"
import { RESOURCE_URL, PERP_RESOURCE_URL } from "../src/http-x402-bazaar.v2.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}

// ── in-memory D1 that understands exactly the statements try-route issues ──
function fakeD1() {
  const verdict = new Map() // `${day}|${address}` -> n
  const day = new Map() // day -> n
  return {
    _verdict: verdict, _day: day,
    prepare(sql) {
      return {
        bind(...v) {
          const first = async () => {
            if (sql.startsWith("SELECT n FROM try_verdict")) { const n = verdict.get(`${v[0]}|${v[1]}`); return n === undefined ? null : { n } }
            if (sql.startsWith("SELECT n FROM try_day")) { const n = day.get(v[0]); return n === undefined ? null : { n } }
            if (sql.startsWith("INSERT INTO try_verdict")) {
              const k = `${v[0]}|${v[1]}`, limit = v[4], cur = verdict.get(k)
              if (cur === undefined) { verdict.set(k, 1); return { n: 1 } }
              if (cur < limit) { verdict.set(k, cur + 1); return { n: cur + 1 } }
              return null
            }
            if (sql.startsWith("INSERT INTO try_day")) {
              const limit = v[1], cur = day.get(v[0])
              if (cur === undefined) { day.set(v[0], 1); return { n: 1 } } // SQLite: the INSERT half ignores the DO UPDATE's WHERE
              if (cur < limit) { day.set(v[0], cur + 1); return { n: cur + 1 } }
              return null
            }
            throw new Error("fake D1: unexpected first(): " + sql)
          }
          const run = async () => {
            if (sql.startsWith("CREATE TABLE")) return {}
            if (sql.startsWith("UPDATE try_verdict SET n = n - 1")) { const k = `${v[0]}|${v[1]}`; const cur = verdict.get(k) ?? 0; if (cur > 0) verdict.set(k, cur - 1); return {} }
            if (sql.startsWith("UPDATE try_day SET n = n - 1")) { const cur = day.get(v[0]) ?? 0; if (cur > 0) day.set(v[0], cur - 1); return {} }
            throw new Error("fake D1: unexpected run(): " + sql)
          }
          return { run, first }
        },
      }
    },
  }
}

// Hardhat account #0: a published test key. Nothing is funded, nothing leaves this process.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")

const PM_INTENT = {
  market: "KXBTC-26AUG29-T70000", side: "YES",
  thesis: "BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it",
  probability_basis: "gut feel, roughly a 60 percent chance", size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
}
const PM_EXTRACTION = {
  agent_type: "trader", intended_action: "buy YES on KXBTC-26AUG29-T70000", audit_context: "prediction_market",
  leverage: { state: "absent" }, position_size: { state: "present", value: 250 },
  stop_loss: { state: "present", value: "daily close below 66000" }, take_profit: { state: "unknown" },
  invalidation_condition: { state: "present", value: "daily close below 66000" }, resolution_engagement: { state: "unknown" },
  probability_basis: { state: "absent", quote: "gut feel, roughly a 60 percent chance" }, edge_claim: { state: "absent", quote: "everyone knows it" },
  data_sources: { state: "unknown" }, oracle_source: { state: "unknown" }, confidence: { state: "unknown" },
}
const stubModel = (payload) => { let calls = 0; const fn = async () => { calls++; return JSON.stringify(payload) }; fn.calls = () => calls; return fn }
const throwingModel = async () => { throw new Error("extraction outage (test)") }

const day = utcDay()
async function sign(acct, intent) { return acct.signMessage({ message: tryMessage(acct.address, day, intentSha256(intent)) }) }
function post(body) { return new Request("https://mcp.djzs.ai/try/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }
async function j(res) { return { status: res.status, body: await res.json(), headers: res.headers } }

// 1. message text
check(1, "signed text is TRY_MESSAGE_FORMAT filled in", tryMessage("0xA", "2026-09-27", "0xS") === TRY_MESSAGE_FORMAT.replace("{address}", "0xA").replace("{day}", "2026-09-27").replace("{intent_sha256}", "0xS"))
check(2, "the text names the cap and that nothing moves", TRY_MESSAGE_FORMAT.includes(`${TRY_DAILY_LIMIT} per wallet per UTC day`) && TRY_MESSAGE_FORMAT.includes("No funds move"))

// 2. quota surface
{
  const db = fakeD1()
  const env = { TELEMETRY: db }
  const q0 = await j(await handleTryQuota(new Request("https://mcp.djzs.ai/try/quota"), env))
  check(3, "GET /try/quota without an address: format, limit, day, offers", q0.status === 200 && q0.body.message_format === TRY_MESSAGE_FORMAT && q0.body.limit === TRY_DAILY_LIMIT && q0.body.day === day && q0.body.receipt.pm.url === RESOURCE_URL && q0.body.receipt.perp.url === PERP_RESOURCE_URL)
  check(4, "CORS: any origin may read the quota", q0.headers.get("Access-Control-Allow-Origin") === "*")
  const q1 = await j(await handleTryQuota(new Request(`https://mcp.djzs.ai/try/quota?address=${account.address.toLowerCase()}`), env))
  check(5, "fresh wallet: used 0, remaining 5, address checksummed", q1.status === 200 && q1.body.used === 0 && q1.body.remaining === 5 && q1.body.address === account.address)
  const qb = await j(await handleTryQuota(new Request("https://mcp.djzs.ai/try/quota?address=0x123"), env))
  check(6, "malformed address is 400", qb.status === 400 && qb.body.error === "bad_address")
  const pre = await handleTryQuota(new Request("https://mcp.djzs.ai/try/quota", { method: "OPTIONS" }), env)
  check(7, "preflight is 204 with CORS", pre.status === 204 && pre.headers.get("Access-Control-Allow-Methods")?.includes("GET"))
}

// 3. refusals before any work
{
  const db = fakeD1()
  const model = stubModel(PM_EXTRACTION)
  const env = { TELEMETRY: db }
  const sig = await sign(account, PM_INTENT)
  const wrongSigner = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: OTHER.address, day, signature: sig }), env, model))
  check(8, "signature by another wallet: 401, no extraction, no slot", wrongSigner.status === 401 && wrongSigner.body.error === "bad_signature" && model.calls() === 0 && db._verdict.size === 0)
  const otherIntent = await j(await handleTryVerdict(post({ kind: "pm", intent: { ...PM_INTENT, size_usd: 251 }, address: account.address, day, signature: sig }), env, model))
  check(9, "same signature, different intent: 401 (the hash is bound)", otherIntent.status === 401 && model.calls() === 0)
  const wrongDay = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day: "2020-01-01", signature: sig }), env, model))
  check(10, "wrong day: 400 with the server's day", wrongDay.status === 400 && wrongDay.body.error === "day_mismatch" && wrongDay.body.day === day)
  const badKind = await j(await handleTryVerdict(post({ kind: "spot", intent: PM_INTENT, address: account.address, day, signature: sig }), env, model))
  check(11, "unknown kind: 400", badKind.status === 400 && badKind.body.error === "bad_kind")
  const noDb = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: sig }), { }, model))
  check(12, "no quota store: 503 before the model runs (fail closed)", noDb.status === 503 && noDb.body.error === "quota_store_unavailable" && model.calls() === 0)
  const big = await j(await handleTryVerdict(post({ kind: "pm", intent: { ...PM_INTENT, thesis: "x".repeat(5000) }, address: account.address, day, signature: sig }), env, model))
  check(13, "oversized intent: 413", big.status === 413)
}

// 4. a verdict
{
  const db = fakeD1()
  const model = stubModel(PM_EXTRACTION)
  const env = { TELEMETRY: db }
  const sig = await sign(account, PM_INTENT)
  const r = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: sig }), env, model))
  check(14, "200 with a PASS/WAIT/FAIL verdict", r.status === 200 && r.body.ok === true && ["PASS", "WAIT", "FAIL"].includes(r.body.verdict), JSON.stringify(r.body).slice(0, 200))
  check(15, "this intent FAILS (unsourced probability + no edge, DJZS-M03 + M04)", r.body.verdict === "FAIL" && r.body.flags.includes("DJZS-M03") && r.body.flags.includes("DJZS-M04"), JSON.stringify(r.body.flags))
  check(16, "flags_detail names the codes in plain language with evidence", r.body.flags_detail.every((f) => typeof f.name === "string" && typeof f.description === "string") && r.body.flags_detail.some((f) => typeof f.evidence === "string"))
  check(17, "binding keys match the paid route's", r.body.intent_sha256 === intentSha256(PM_INTENT) && r.body.intent_hash === intentHash(toDJZSIntent(PM_INTENT)))
  check(18, "not attested; the offer points at the PM route at 2.00 USDC on Base", r.body.attested === false && r.body.receipt.url === RESOURCE_URL && r.body.receipt.price === "2.00 USDC" && r.body.receipt.network === "eip155:8453")
  check(19, "quota: used 1 of 5", r.body.quota.used === 1 && r.body.quota.remaining === 4 && r.body.quota.limit === 5)
  check(20, "one extraction (N=3 samples) per call, nothing more", model.calls() === 3, `calls=${model.calls()}`)
  check(21, "tally rides along for the receipt comparison", r.body.tally && r.body.tally.ruleset === "DJZS-PM-v1.0")
  check(22, "CORS on the verdict", r.headers.get("Access-Control-Allow-Origin") === "*")
}

// 5. per-wallet cap
{
  const db = fakeD1()
  const model = stubModel(PM_EXTRACTION)
  const env = { TELEMETRY: db }
  const sig = await sign(account, PM_INTENT)
  let last
  for (let i = 0; i < TRY_DAILY_LIMIT; i++) last = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: sig }), env, model))
  check(23, "five verdicts succeed; the fifth shows remaining 0", last.status === 200 && last.body.quota.used === 5 && last.body.quota.remaining === 0)
  const sixth = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: sig }), env, model))
  check(24, "the sixth is 429 wallet_quota_exhausted, offer attached, no extraction", sixth.status === 429 && sixth.body.error === "wallet_quota_exhausted" && sixth.body.receipt.url === RESOURCE_URL && model.calls() === 15, `calls=${model.calls()}`)
  const other = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: OTHER.address, day, signature: await sign(OTHER, PM_INTENT) }), env, model))
  check(25, "another wallet is unaffected", other.status === 200 && other.body.quota.used === 1)
}

// 6. global cap
{
  const db = fakeD1()
  const model = stubModel(PM_EXTRACTION)
  const env = { TELEMETRY: db, TRY_GLOBAL_DAILY_LIMIT: "1" }
  const first = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: await sign(account, PM_INTENT) }), env, model))
  const second = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: OTHER.address, day, signature: await sign(OTHER, PM_INTENT) }), env, model))
  check(26, "global cap: first served, second 429 free_tier_exhausted_today", first.status === 200 && second.status === 429 && second.body.error === "free_tier_exhausted_today")
  check(27, "the refused wallet's slot was released", db._verdict.get(`${day}|${OTHER.address}`) === 0 && model.calls() === 3)
  const q = await j(await handleTryQuota(new Request("https://mcp.djzs.ai/try/quota"), env))
  check(28, "quota surface reports global_remaining 0", q.body.global_remaining === 0)
}

// 6b. kill switch: TRY_GLOBAL_DAILY_LIMIT "0" refuses the day's FIRST call too
{
  const db = fakeD1()
  const model = stubModel(PM_EXTRACTION)
  const env = { TELEMETRY: db, TRY_GLOBAL_DAILY_LIMIT: "0" }
  const r = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: await sign(account, PM_INTENT) }), env, model))
  check(31, "limit 0: first call of the day is 429, no extraction, no slot taken, no day row", r.status === 429 && r.body.error === "free_tier_exhausted_today" && model.calls() === 0 && db._verdict.size === 0 && db._day.size === 0)
}

// 7. pipeline failure releases; scope refusal keeps
{
  const db = fakeD1()
  const env = { TELEMETRY: db }
  const boom = await j(await handleTryVerdict(post({ kind: "pm", intent: PM_INTENT, address: account.address, day, signature: await sign(account, PM_INTENT) }), env, throwingModel))
  check(29, "extraction outage: 503, slot released, day count released", boom.status === 503 && boom.body.slot_released === true && db._verdict.get(`${day}|${account.address}`) === 0 && db._day.get(day) === 0)
  const model = stubModel(PM_EXTRACTION) // a PM extraction sent to the perp route is out of scope
  const refused = await j(await handleTryVerdict(post({ kind: "perp", intent: PM_INTENT, address: account.address, day, signature: await sign(account, PM_INTENT) }), env, model))
  check(30, "out of scope on the perp route: 200 REFUSED_SCOPE, slot kept", refused.status === 200 && refused.body.verdict === "REFUSED_SCOPE" && refused.body.quota.used === 1 && db._verdict.get(`${day}|${account.address}`) === 1)
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join("\n")); process.exit(1) }
