/**
 * /try/market: which market is this id? Offline: records captured from the venues on 2026-11-24 and a fake
 * getter. No network, no key, no model.
 *
 * Pins what the page relies on before a receipt is paid for:
 *   - a Kalshi market ticker, a Kalshi event ticker, a Polymarket slug and either venue's URL all resolve;
 *   - the answer carries the venue's own title and whether the market is open, closed or settled;
 *   - an id no venue knows is found:false (200), and an id with no venue shape makes no network call;
 *   - a venue that cannot be reached is reached:false, never an error, and is not kept in the cache;
 *   - one open YES/NO contract also carries the venue's bid, ask, last trade and week-ago price, in cents;
 *     an event, a shut market and a named-outcome market carry none; a week-ago read that fails is null;
 *   - no side is picked and nothing is recommended.
 *
 * Run: npx tsx test/try-market-lookup.test.mjs
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { candidates, lookupMarket, handleTryMarket, fromKalshiMarket, kalshiWeekAgo, cents, TRY_MARKET_TTL_SECONDS } from "../src/try-market-lookup.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}
const fx = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures-try-market-lookup.json", import.meta.url)), "utf8"))

// A fake venue: answers the four captured records, 404 or [] for everything else, and counts calls.
const NOW = new Date("2026-11-24T01:00:00Z") // week ago = 1794877200
function venue({ down = false, candlesDown = false } = {}) {
  const calls = []
  const get = async (url) => {
    calls.push(url)
    if (down) return null
    if (url.includes("/candlesticks")) return candlesDown ? null : { status: 200, data: fx.kalshi_candles }
    if (url.includes("/markets?slug=will-example-happen-by-2027")) return { status: 200, data: fx.polymarket_market_open }
    if (url.includes("/markets?slug=team-a-vs-team-b")) return { status: 200, data: fx.polymarket_market_named }
    if (url.endsWith("/markets/KXFEDDECISION-26DEC-H0")) return { status: 200, data: fx.kalshi_market_open }
    if (url.endsWith("/markets/KXNVDACEO-29JAN-JENS")) return { status: 200, data: fx.kalshi_market_settled }
    if (url.endsWith("/events/KXFEDDECISION-26DEC")) return { status: 200, data: fx.kalshi_event }
    if (url.includes("kalshi")) return { status: 404, data: { error: { code: "not_found" } } }
    if (url.includes("/events?slug=fed-decision-in-december")) return { status: 200, data: fx.polymarket_event }
    if (url.includes(`/markets?slug=${fx.polymarket_market[0].slug}`)) return { status: 200, data: fx.polymarket_market }
    return { status: 200, data: [] }
  }
  return { get, calls }
}

// ── shapes ──
check(1, "a Kalshi ticker tries Kalshi first", candidates("KXFEDDECISION-26DEC-H0")[0].venue === "kalshi")
check(2, "a lower-case ticker is still tried as Kalshi", candidates("kxfeddecision-26dec-h0").some((c) => c.venue === "kalshi" && c.id === "KXFEDDECISION-26DEC-H0"))
check(3, "a slug tries Polymarket first", candidates("fed-decision-in-december")[0].venue === "polymarket")
check(4, "a Polymarket URL yields its slug", candidates("https://polymarket.com/event/fed-decision-in-december?tid=1")[0].id === "fed-decision-in-december")
check(5, "a Kalshi URL yields the ticker from its path", candidates("https://kalshi.com/markets/kxfeddecision/fed-meeting/kxfeddecision-26dec").some((c) => c.id === "KXFEDDECISION-26DEC"))
check(6, "a sentence is not an id", candidates("the fed one in december").length === 0)
check(7, "another site's URL is not an id", candidates("https://example.com/markets/KXFEDDECISION-26DEC").length === 0)
check(8, "script text is not an id", candidates("<img src=x onerror=1>").length === 0)

// ── lookups ──
let v = venue(), r = await lookupMarket("KXFEDDECISION-26DEC-H0", v.get)
check(9, "an open Kalshi market resolves with the venue's title", r.found && r.market.venue === "kalshi" && r.market.level === "market" && /Federal Reserve/.test(r.market.title) && r.market.state === "open", JSON.stringify(r.market))
check(10, "it names the outcome and the closing day", r.market.outcome === "Fed maintains rate" && r.market.closes === "2026-12-09")
r = await lookupMarket("KXNVDACEO-29JAN-JENS", venue().get)
check(11, "a finalized market is settled", r.found && r.market.state === "settled" && r.market.outcome === "Jensen Huang", JSON.stringify(r.market))
r = await lookupMarket("KXFEDDECISION-26DEC", venue().get)
check(12, "an event ticker resolves at event level", r.found && r.market.level === "event" && r.market.title === "Fed decision in Dec 2026?" && r.market.state === "open")
r = await lookupMarket("fed-decision-in-december", venue().get)
check(13, "a Polymarket event slug resolves, and a closed one is not open", r.found && r.market.venue === "polymarket" && r.market.level === "event" && r.market.state !== "open", JSON.stringify(r.market))
r = await lookupMarket(fx.polymarket_market[0].slug, venue().get)
check(14, "a Polymarket market slug resolves at market level", r.found && r.market.level === "market" && r.market.title === fx.polymarket_market[0].question)
r = await lookupMarket("KXNOSUCHTHING-99", venue().get)
check(15, "an unknown id is reached but not found", r.reached === true && r.found === false && r.market === null)
r = await lookupMarket("KXFEDDECISION-26DEC-H0", venue({ down: true }).get)
check(16, "a venue that cannot be reached is reached:false, not an error", r.ok === true && r.reached === false && r.found === false)
const all = JSON.stringify([await lookupMarket("KXFEDDECISION-26DEC-H0", venue().get), await lookupMarket("fed-decision-in-december", venue().get)])
check(17, "no side is picked and nothing is recommended", !/"side"|recommend|should|probab|odds/i.test(all), all.slice(0, 200))
check(18, "venue text is cleaned and capped", fromKalshiMarket({ market: { ticker: "KXA-1", title: "A\u0000 title " + " x".repeat(400), status: "active" } }).title.length <= 164)
check(19, "a record with a bad id or no title is refused", fromKalshiMarket({ market: { ticker: "bad id", title: "T" } }) === null && fromKalshiMarket({ market: { ticker: "KXA-1", title: "" } }) === null)

// ── the quote ──
r = await lookupMarket("KXFEDDECISION-26DEC-H0", venue().get, NOW)
check(27, "an open Kalshi contract carries bid, ask and last in cents", r.market.quote && r.market.quote.yes_bid === 3 && r.market.quote.yes_ask === 4 && r.market.quote.last === 4, JSON.stringify(r.market.quote))
check(28, "its week-ago price is the last daily close at or before seven days back", r.market.quote.week_ago === 7 && r.market.quote.read_at === NOW.toISOString(), JSON.stringify(r.market.quote))
r = await lookupMarket("KXFEDDECISION-26DEC-H0", venue({ candlesDown: true }).get, NOW)
check(29, "a week-ago read that fails leaves null and the rest intact", r.found && r.market.quote.week_ago === null && r.market.quote.yes_ask === 4)
check(30, "a settled market and an event carry no quote", (await lookupMarket("KXNVDACEO-29JAN-JENS", venue().get, NOW)).market.quote === undefined && (await lookupMarket("KXFEDDECISION-26DEC", venue().get, NOW)).market.quote === undefined)
r = await lookupMarket("will-example-happen-by-2027", venue().get, NOW)
check(31, "an open Polymarket YES/NO market carries the quote and a week-ago price from the venue's own change figure", r.market.quote && r.market.quote.yes_bid === 44 && r.market.quote.yes_ask === 46 && r.market.quote.last === 45 && r.market.quote.week_ago === 20, JSON.stringify(r.market.quote))
check(32, "a named-outcome market has no YES price", (await lookupMarket("team-a-vs-team-b", venue().get, NOW)).market.quote === undefined)
check(33, "cents: dollars in, one decimal out, junk refused", cents("0.0400") === 4 && cents(0.455) === 45.5 && cents("1.0000") === 100 && cents("") === null && cents("7") === null && cents(null) === null)
check(34, "a candle after the cut is ignored", kalshiWeekAgo(fx.kalshi_candles, 1794877200) === 7 && kalshiWeekAgo(fx.kalshi_candles, 1794700000) === null && kalshiWeekAgo({}, 1) === null)

// ── the route ──
const store = new Map()
const cache = { match: async (q) => store.get(q.url)?.clone(), put: async (q, res) => { store.set(q.url, res) } }
v = venue()
let res = await handleTryMarket(new Request("https://mcp.djzs.ai/try/market?id=KXFEDDECISION-26DEC-H0"), { get: v.get, cache })
let body = await res.json()
check(20, "GET answers 200 with the record and CORS", res.status === 200 && body.found === true && res.headers.get("access-control-allow-origin") === "*")
check(21, "a reached answer is kept for the TTL", res.headers.get("cache-control") === `public, max-age=${TRY_MARKET_TTL_SECONDS}` && store.size === 1)
const before = v.calls.length
res = await handleTryMarket(new Request("https://mcp.djzs.ai/try/market?id=kxfeddecision-26dec-h0"), { get: v.get, cache })
check(22, "the same id in another case is served from the cache", v.calls.length === before && (await res.json()).found === true)
v = venue({ down: true })
res = await handleTryMarket(new Request("https://mcp.djzs.ai/try/market?id=KXOTHER-1"), { get: v.get, cache })
check(23, "an unreached answer is 200, no-store and not cached", res.status === 200 && res.headers.get("cache-control") === "no-store" && store.size === 1)
v = venue()
res = await handleTryMarket(new Request("https://mcp.djzs.ai/try/market?id=" + encodeURIComponent("the fed one in december")), { get: v.get, cache: null })
check(24, "text with no id shape makes no network call", v.calls.length === 0 && (await res.json()).found === false)
check(25, "a missing id is 400", (await handleTryMarket(new Request("https://mcp.djzs.ai/try/market"), { get: v.get, cache: null })).status === 400)
check(26, "POST is 405, OPTIONS is 204", (await handleTryMarket(new Request("https://mcp.djzs.ai/try/market?id=A", { method: "POST" }), { cache: null })).status === 405 && (await handleTryMarket(new Request("https://mcp.djzs.ai/try/market", { method: "OPTIONS" }), { cache: null })).status === 204)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1) }
