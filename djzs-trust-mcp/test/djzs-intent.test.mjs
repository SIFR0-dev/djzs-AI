/**
 * djzs-intent: the v2 EIP-712 binding key for BOTH paid routes. Offline, no key, no network.
 *
 * Pins:
 *   - the PM golden receipt of 2026-09-01 still recomputes to its published intent_hash;
 *   - a perp intent (instrument, no market) maps and hashes instead of throwing. Until
 *     2026-09-27 it threw AFTER settlement, so a paying perp caller was charged and answered 503;
 *   - the perp mapping is exactly the documented one: market=instrument, exit_condition from
 *     invalidation else stop_loss, levels bound through params_hash, and absent levels render empty;
 *   - two perp intents that differ only in a level differ in intent_hash;
 *   - THE ROUTE DECIDES THE ACTION CLASS (ruled 2026-10-21), never the body's fields: the perp route
 *     always attests perp_trade (market = instrument, falling back to market), the pm route always
 *     pm_trade, and an unknown route throws;
 *   - a missing or empty market, side or thesis is refused by a NAMED error (IntentUnbindableError),
 *     not by viem happening to throw on `undefined` (ruled 2026-10-21).
 *
 * Run: npx tsx test/djzs-intent.test.mjs
 */
import { keccak256 } from "viem"
import { ACTIONS, IntentUnbindableError, REQUIRED_TEXT_FIELDS, intentHash, perpParamsPreimage, toDJZSIntent } from "../src/djzs-intent.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

// 1. PM golden (site/verify.html SAMPLE, receipt of 2026-09-01)
const PM = {
  market: "KXBTCD-26SEP0217-T76999.99", side: "YES",
  thesis: "BTC spot ~$77,263 (Coinbase 2026-09-01T20:08Z) sits ~0.34% above the $77,000 line; absent a close under $77,000 at the Sep 2 settlement, KXBTCD-26SEP0217-T76999.99 resolves YES.",
  probability_basis: "spot $77,263 vs $77,000 strike = +0.34% ITM; Kalshi book unquoted so implied N/A; model P(YES) approx 0.70; basis Coinbase spot 2026-09-01T20:08Z",
  size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "BTC hourly close below $77,000 on Coinbase before the Sep 2 settlement" },
}
check(1, "PM golden intent_hash unchanged", intentHash(toDJZSIntent(PM)) === "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb206")
check(2, "PM maps to pm_trade, and \"pm\" is the default route (tests/q3/q3-log.ts calls with the intent alone)", toDJZSIntent(PM).action === "pm_trade" && toDJZSIntent(PM, "pm").action === "pm_trade" && intentHash(toDJZSIntent(PM)) === intentHash(toDJZSIntent(PM, "pm")))

// 2. perp (the route's own discovery intent)
const PERP = {
  instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000,
  size_usd: 3000, venue: "Binance",
  thesis: "Funding reset to 2% after the weekend flush; 80K held on the daily close; ETF inflows resumed. Invalidation: daily close below 76,200. Oracle: Binance mark price.",
}
let perpStruct = null, perpHash = null, threw = null
try { perpStruct = toDJZSIntent(PERP, "perp"); perpHash = intentHash(perpStruct) } catch (e) { threw = e }
check(3, "perp intent maps and hashes (regression: threw after settlement)", threw === null && typeof perpHash === "string" && perpHash.length === 66)
check(4, "perp action is perp_trade and ACTIONS lists it", perpStruct?.action === "perp_trade" && ACTIONS.includes("perp_trade"))
check(5, "market = instrument, venue kept, thesis kept", perpStruct?.market === "BTC-PERP" && perpStruct?.venue === "Binance" && perpStruct?.thesis === PERP.thesis)
check(6, "probability_basis is data_sources or empty", perpStruct?.probability_basis === "")
check(7, "size in cents, max_loss 0 (documented, not derived)", perpStruct?.size_usd_cents === 300000n && perpStruct?.max_loss_usd_cents === 0n)
check(8, "exit_condition falls back to the stop", perpStruct?.exit_condition === "stop_loss 76200")
const preimage = perpParamsPreimage(PERP)
check(9, "params preimage is the documented rendering", preimage === "leverage=5|entry=78900|stop_loss=76200|take_profit=83000")
check(10, "params_hash = keccak256(utf8(preimage))", perpStruct?.params_hash === keccak256(new TextEncoder().encode(preimage)))

// 3. mapping details
const withInvalidation = toDJZSIntent({ ...PERP, invalidation: "daily close below 76,200" }, "perp")
check(11, "invalidation wins over the stop for exit_condition", withInvalidation.exit_condition === "daily close below 76,200")
const sparse = toDJZSIntent({ instrument: "ETH-USD", side: "SHORT", thesis: "x" }, "perp")
check(12, "absent levels render empty and hash without throwing", perpParamsPreimage({ instrument: "ETH-USD", side: "SHORT", thesis: "x" }) === "leverage=|entry=|stop_loss=|take_profit=" && sparse.exit_condition === "" && intentHash(sparse).length === 66)
check(13, "data_sources feeds probability_basis", toDJZSIntent({ ...PERP, data_sources: "Binance funding, Coinglass OI" }, "perp").probability_basis === "Binance funding, Coinglass OI")

// 4. sensitivity: a level change changes the key
const bumped = intentHash(toDJZSIntent({ ...PERP, stop_loss: 76100 }, "perp"))
check(14, "changing one level changes intent_hash", bumped !== perpHash)
const reordered = intentHash(toDJZSIntent({ thesis: PERP.thesis, venue: PERP.venue, size_usd: PERP.size_usd, take_profit: PERP.take_profit, stop_loss: PERP.stop_loss, entry: PERP.entry, leverage: PERP.leverage, side: PERP.side, instrument: PERP.instrument }, "perp"))
check(15, "key order of the wire object does not change intent_hash", reordered === perpHash)

// 5. THE ROUTE DECIDES the action class (ruled 2026-10-21). Section 2's PERP is the perp route's own example.
//    Pinned from production's mapping (post-settlement.test.ts PERP_INTENT_HASH_PINNED): the perp route's
//    example body must hash exactly as it did when the class was inferred from the body.
const PERP_PINNED = "0xb7fbfdab14efbc842bd235439b995791f160610b266ea154dd52a43631ed8c19"
check(16, "perp route + the published perp example: hash unchanged from production's mapping", perpHash === PERP_PINNED, String(perpHash))

const hashOrNull = (i, r) => { try { return intentHash(toDJZSIntent(i, r)) } catch { return null } }

// 5a. perp route: ALWAYS perp_trade, whatever keys the body carries
const { instrument: _drop, ...PERP_MARKET_ONLY_BASE } = PERP
const marketOnly = { ...PERP_MARKET_ONLY_BASE, market: "BTC-PERP" }
const marketOnlyStruct = toDJZSIntent(marketOnly, "perp")
check(17, "perp route, body with `market` and no `instrument`: perp_trade (was pm_trade), market = market", marketOnlyStruct.action === "perp_trade" && marketOnlyStruct.market === "BTC-PERP")
check(18, "…its levels are bound through params_hash exactly as for `instrument`", marketOnlyStruct.params_hash === perpStruct.params_hash && marketOnlyStruct.params_hash !== "0x" + "00".repeat(32))
check(19, "…and it is the SAME intent as the `instrument` spelling, so the SAME intent_hash", hashOrNull(marketOnly, "perp") === PERP_PINNED)
const both = { ...PERP, market: "KXBTC-OTHER" }
check(20, "perp route, body with BOTH keys: perp_trade, market = instrument (instrument wins)", toDJZSIntent(both, "perp").action === "perp_trade" && toDJZSIntent(both, "perp").market === "BTC-PERP" && hashOrNull(both, "perp") === PERP_PINNED)
check(21, "perp route, neither key: no market, so it cannot bind (the route refuses it uncharged)", hashOrNull({ side: "LONG", thesis: "x" }, "perp") === null)
check(22, "perp route, a non-string `instrument` falls back to `market`", toDJZSIntent({ ...PERP, instrument: 7, market: "ETH-PERP" }, "perp").market === "ETH-PERP")

// 5b. pm route: ALWAYS pm_trade, whatever keys the body carries
const pmWithPerpKeys = { ...PM, instrument: "BTC-PERP", leverage: 5 }
check(23, "pm route, body that ALSO carries `instrument`: still pm_trade, hash unchanged", toDJZSIntent(pmWithPerpKeys, "pm").action === "pm_trade" && hashOrNull(pmWithPerpKeys, "pm") === hashOrNull(PM, "pm"))
check(24, "pm route, a perp-shaped body (instrument, no market): cannot bind. It was attested as perp_trade under the PM ruleset", hashOrNull(PERP, "pm") === null)

// 5c. the class is a property of the route, so it cannot be steered from the body
const keysets = [PM, PERP, marketOnly, both, pmWithPerpKeys]
const actionOf = (k, r) => { try { return toDJZSIntent(k, r).action } catch (e) { return e instanceof IntentUnbindableError ? "REFUSED" : "THREW" } }
check(25, "across five body shapes the pm route yields pm_trade or a named refusal, never perp_trade", keysets.every((k) => ["pm_trade", "REFUSED"].includes(actionOf(k, "pm"))) && keysets.filter((k) => actionOf(k, "pm") === "pm_trade").length === 4)
check(26, "across five body shapes the perp route yields perp_trade or a named refusal, never pm_trade", keysets.every((k) => ["perp_trade", "REFUSED"].includes(actionOf(k, "perp"))) && keysets.filter((k) => actionOf(k, "perp") === "perp_trade").length === 5)
check(27, "an unknown route throws instead of defaulting to a class", ["", "PM", "perp_trade", null].every((r) => { try { toDJZSIntent(PM, r); return false } catch { return true } }))

// 6. A MISSING OR EMPTY market, side or thesis is refused by a NAMED error (ruled 2026-10-21), on both routes.
//    viem would throw on `undefined` and null but binds "" without complaint, so before this a body with
//    thesis: "" was settled, attested and permanent. The message is a fixed vocabulary; it never carries the body.
const SENTINEL = "SENTINEL-BODY-TEXT-0123456789"
function unbindable(i, r) { try { toDJZSIntent(i, r); return null } catch (e) { return e instanceof IntentUnbindableError ? e : { notNamed: e } } }
const FIELDS = REQUIRED_TEXT_FIELDS
check(28, "the guarded fields are exactly market, side, thesis", FIELDS.join() === "market,side,thesis")
const baseFor = { pm: { ...PM }, perp: { ...PERP } }
const marketKey = { pm: "market", perp: "instrument" }
let namedAll = true, wrongField = [], leaked = false, instances = 0
for (const route of ["pm", "perp"]) {
  for (const field of FIELDS) {
    const key = field === "market" ? marketKey[route] : field
    for (const [problem, mutate] of [["missing", (b) => { delete b[key] }], ["missing", (b) => { b[key] = undefined }], ["missing", (b) => { b[key] = null }], ["empty", (b) => { b[key] = "" }]]) {
      const body = { ...baseFor[route], extra: SENTINEL }; mutate(body)
      if (route === "perp" && field === "market") delete body.market
      const e = unbindable(body, route)
      instances++
      if (!e || e.notNamed) { namedAll = false; wrongField.push(`${route}/${key}/${problem}: ${e ? String(e.notNamed) : "no throw"}`); continue }
      if (e.field !== field || e.problem !== problem && !(problem === "missing" && e.problem === "missing")) wrongField.push(`${route}/${key}/${problem}: got ${e.field}/${e.problem}`)
      if (e.message.includes(SENTINEL)) leaked = true
    }
  }
}
check(29, `${instances} missing/undefined/null/empty cases on both routes each throw IntentUnbindableError`, namedAll && instances === 24, wrongField.join(" | "))
check(30, "each names the right field and the right problem (missing vs empty)", wrongField.length === 0, wrongField.join(" | "))
check(31, "the message is `intent_unbindable: <field> is <missing|empty>` and never carries any of the body", !leaked && unbindable({ ...PM, thesis: "" }, "pm").message === "intent_unbindable: thesis is empty" && unbindable({ ...PM, side: null }, "pm").message === "intent_unbindable: side is missing")
const e0 = unbindable({ ...PM, thesis: "" }, "pm")
check(32, "it is an Error with a stable name, field and problem a caller can switch on", e0 instanceof Error && e0.name === "IntentUnbindableError" && e0.field === "thesis" && e0.problem === "empty")

// 6a. perp: the refusal comes AFTER the instrument -> market fallback
const { instrument: _noInstrument, ...PERP_NO_INSTRUMENT } = PERP
check(33, "perp, neither instrument nor market: market is missing (named), not an opaque viem error", unbindable(PERP_NO_INSTRUMENT, "perp")?.field === "market" && unbindable(PERP_NO_INSTRUMENT, "perp")?.problem === "missing")
check(34, "perp, `market` only: the fallback supplies the market, so it still binds", unbindable({ ...PERP_NO_INSTRUMENT, market: "BTC-PERP" }, "perp") === null)
check(35, "perp, instrument is an EMPTY string: a string wins the fallback, so market is empty (named); `market` is not consulted", unbindable({ ...PERP, instrument: "", market: "ETH-PERP" }, "perp")?.problem === "empty")
check(36, "perp, instrument is not a string and `market` is empty: empty (named)", unbindable({ ...PERP, instrument: 7, market: "" }, "perp")?.problem === "empty")

// 6b. what is NOT refused, so the next reader does not have to guess
check(37, "a whitespace-only thesis is not empty: it still binds (a separate ruling if it should not)", unbindable({ ...PM, thesis: " " }, "pm") === null)
check(38, "a non-string thesis/side/market is not refused here: it still binds, to a colliding hash (the 2026-10-20 mistyped-values finding stays open)", unbindable({ ...PM, thesis: 0 }, "pm") === null && unbindable({ ...PM, side: false }, "pm") === null)
check(39, "an absent venue / probability_basis / bounds is NOT refused: they have documented defaults", unbindable({ market: "m", side: "YES", thesis: "t" }, "pm") === null)

// 6c. nothing that bound before binds differently now
check(40, "the PM golden and the perp example still produce their pinned keys (the guard only ever removes bodies)", hashOrNull(PM, "pm") === "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb206" && hashOrNull(PERP, "perp") === PERP_PINNED)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join("\n")); process.exit(1) }
