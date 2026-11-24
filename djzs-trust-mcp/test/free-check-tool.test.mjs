/**
 * check_thesis: the free MCP tool. Offline: a stub model and the in-memory D1 from try-route.test.mjs. No network.
 *
 * Pins what a walletless MCP client relies on:
 *   - a thesis gets the same verdict, score and verdict_hash that POST /try/verdict gives the same text;
 *   - the result is marked free and not attested, and names the paid tools as the way to a receipt;
 *   - every MCP caller shares ONE quota row with its own daily cap, inside the global cap;
 *   - past either cap the result is LIMIT_REACHED with isError, and no extraction runs;
 *   - no D1, or an extraction outage, is UNAVAILABLE with isError, never a throw, and the slot is released;
 *   - a thesis sent as the wrong kind is REFUSED_SCOPE, not a verdict;
 *   - nothing a client sends to the HTTP route can select the MCP quota row;
 *   - the description is ASCII.
 *
 * Run: npx tsx test/free-check-tool.test.mjs
 */
import { runCheckThesis, CHECK_THESIS_DESCRIPTION, CHECK_THESIS_KINDS } from "../src/free-check-tool.ts"
import { handleTryVerdict, mcpDailyLimit, utcDay, TRY_MCP_QUOTA_KEY, TRY_MCP_DAILY_LIMIT_DEFAULT } from "../src/try-route.ts"

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
const THESIS = "Kalshi, BTC closes above 70000 by Aug 29. Buying YES with 250 dollars because ETF inflows keep compounding and everyone knows it. Gut feel, roughly a 60 percent chance. I am out on a daily close below 66000."
const day = utcDay()
const post = (body) => new Request("https://mcp.djzs.ai/try/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

// 1. a verdict, and it is the route's verdict
{
  const db = fakeD1(), model = stubModel(PM_EXTRACTION), env = { TELEMETRY: db }
  const r = await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, env, model)
  const s = r.structuredContent
  check(1, "a thesis returns a verdict as structuredContent, not an error", r.isError === undefined && s.status === "OK" && ["PASS", "WAIT", "FAIL"].includes(s.verdict), JSON.stringify(s).slice(0, 200))
  check(2, "marked free and not attested", s.free === true && s.attested === false)
  check(3, "names the paid tools as the way to a receipt", /verify_pm_trade/.test(s.next) && /verify_perp_trade/.test(s.next))
  check(4, "the text content is the same object", JSON.parse(r.content[0].text).verdict_hash === s.verdict_hash)
  const route = await (await handleTryVerdict(post({ kind: "pm", intent: { thesis: THESIS }, anon: "a".repeat(32) }), { TELEMETRY: fakeD1() }, stubModel(PM_EXTRACTION))).json()
  check(5, "same verdict, score and verdict_hash as POST /try/verdict for the same text", route.verdict === s.verdict && route.risk_score === s.risk_score && route.verdict_hash === s.verdict_hash && route.intent_sha256 === s.intent_sha256, `${route.verdict_hash} vs ${s.verdict_hash}`)
  check(6, "it drew on the shared MCP row and the global row", db._verdict.get(`${day}|${TRY_MCP_QUOTA_KEY}`) === 1 && db._day.get(day) === 1)
  check(7, "one extraction for one check", model.calls() >= 1)
}

// 2. the shared cap
{
  const db = fakeD1(), model = stubModel(PM_EXTRACTION), env = { TELEMETRY: db, TRY_MCP_DAILY_LIMIT: "2" }
  await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, env, model)
  await runCheckThesis({ kind: "prediction_market", thesis: THESIS + " again" }, env, model)
  const before = model.calls()
  const r = await runCheckThesis({ kind: "prediction_market", thesis: THESIS + " third" }, env, model)
  check(8, "past the MCP cap: LIMIT_REACHED with isError", r.isError === true && r.structuredContent.status === "LIMIT_REACHED" && typeof r.structuredContent.resets_at === "string", JSON.stringify(r.structuredContent))
  check(9, "and no extraction ran for it", model.calls() === before)
  check(10, "the refusal names the paid tools", r.structuredContent.paid_tools.join() === "verify_pm_trade,verify_perp_trade")
  check(11, "the cap is one row for every MCP caller", db._verdict.size === 1 && db._verdict.get(`${day}|${TRY_MCP_QUOTA_KEY}`) === 2)
}
{
  const db = fakeD1(), model = stubModel(PM_EXTRACTION)
  const r = await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, { TELEMETRY: db, TRY_GLOBAL_DAILY_LIMIT: "0" }, model)
  check(12, "the global kill switch refuses the MCP door too", r.isError === true && r.structuredContent.status === "LIMIT_REACHED" && model.calls() === 0)
  const z = await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, { TELEMETRY: fakeD1(), TRY_MCP_DAILY_LIMIT: "0" }, model)
  check(13, "an MCP cap of 0 closes the MCP door alone", z.isError === true && z.structuredContent.status === "LIMIT_REACHED" && model.calls() === 0)
  check(14, "cap parsing: default, a set value, junk falls back", mcpDailyLimit({}) === TRY_MCP_DAILY_LIMIT_DEFAULT && mcpDailyLimit({ TRY_MCP_DAILY_LIMIT: "7" }) === 7 && mcpDailyLimit({ TRY_MCP_DAILY_LIMIT: "many" }) === TRY_MCP_DAILY_LIMIT_DEFAULT && mcpDailyLimit({ TRY_MCP_DAILY_LIMIT: "-3" }) === TRY_MCP_DAILY_LIMIT_DEFAULT)
}

// 3. failures are results, not throws
{
  const r = await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, {}, stubModel(PM_EXTRACTION))
  check(15, "no quota store: UNAVAILABLE with isError (fail closed)", r.isError === true && r.structuredContent.status === "UNAVAILABLE" && r.structuredContent.error === "quota_store_unavailable")
  const db = fakeD1()
  const o = await runCheckThesis({ kind: "prediction_market", thesis: THESIS }, { TELEMETRY: db }, throwingModel)
  check(16, "an extraction outage: UNAVAILABLE, no raw error text", o.isError === true && o.structuredContent.status === "UNAVAILABLE" && !/outage/.test(JSON.stringify(o.structuredContent)))
  check(17, "and the slot is released", (db._verdict.get(`${day}|${TRY_MCP_QUOTA_KEY}`) ?? 0) === 0 && (db._day.get(day) ?? 0) === 0)
}

// 4. scope
{
  const r = await runCheckThesis({ kind: "perp_or_spot", thesis: THESIS }, { TELEMETRY: fakeD1() }, stubModel(PM_EXTRACTION))
  check(18, "a prediction-market thesis sent as a perp is REFUSED_SCOPE, not a verdict", r.structuredContent.status === "OK" && r.structuredContent.verdict === "REFUSED_SCOPE", JSON.stringify(r.structuredContent).slice(0, 200))
}

// 5. the HTTP route cannot reach the MCP row
{
  const db = fakeD1()
  const res = await handleTryVerdict(post({ kind: "pm", intent: { thesis: THESIS }, anon: TRY_MCP_QUOTA_KEY, quotaKey: { id: TRY_MCP_QUOTA_KEY, limit: 999 }, internal: { quotaKey: { id: TRY_MCP_QUOTA_KEY, limit: 999 } } }), { TELEMETRY: db }, stubModel(PM_EXTRACTION))
  check(19, "a client cannot name the MCP row over HTTP", res.status === 400 && !db._verdict.has(`${day}|${TRY_MCP_QUOTA_KEY}`))
}

// 6. surface
check(20, "the description is ASCII", /^[\x20-\x7e]+$/.test(CHECK_THESIS_DESCRIPTION))
check(21, "it says free, no receipt, and names the paid tools", /FREE/.test(CHECK_THESIS_DESCRIPTION) && /does NOT write a receipt/.test(CHECK_THESIS_DESCRIPTION) && /verify_pm_trade/.test(CHECK_THESIS_DESCRIPTION))
check(22, "two kinds", CHECK_THESIS_KINDS.join() === "prediction_market,perp_or_spot")

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1) }
