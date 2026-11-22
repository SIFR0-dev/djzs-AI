/**
 * /try/markets: the markets behind the home page's starter buttons. Offline: fixtures captured from the
 * venues on 2026-11-22, a fake reader and a fake cache. No network, no key, no model.
 *
 * Pins what a public page relies on:
 *   - only open events in the listed categories are served; sports, settled and past-close events are not;
 *   - a title that turns on a death or on violence is never served;
 *   - venue text is capped and stripped of control characters, and ids and slugs that are not plain are refused;
 *   - no price, outcome or side is in the answer: the route names markets, it does not pick one;
 *   - a venue that cannot be read is left out, both unreadable is an empty list (200), never an error;
 *   - an answer that reached a venue is kept for TRY_MARKETS_TTL_SECONDS; one that reached none is not kept.
 *
 * Run: npx tsx test/try-markets.test.mjs
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { pickHyperliquid, TRY_PERPS_MAX, pickKalshi, pickPolymarket, arrange, cleanText, firstSentences, blockedTitle, handleTryMarkets, KALSHI_CATEGORIES, TRY_MARKETS_MAX, TRY_MARKETS_TTL_SECONDS } from "../src/try-markets.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}
const fx = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures-try-markets.json", import.meta.url)), "utf8"))
const NOW = new Date("2026-11-22T12:00:00Z")
const DAY = /^\d{4}-\d{2}-\d{2}$/

// ── Kalshi ──
const kAll = KALSHI_CATEGORIES.flatMap((c) => pickKalshi(fx.kalshi_by_category[c], NOW))
check(1, "Kalshi: the captured category pages yield markets", kAll.length >= 8, String(kAll.length))
check(2, "Kalshi: every market has a title, a plain id, a close day after today and a kalshi.com link", kAll.every((m) => m.venue === "kalshi" && m.title && /^[A-Z0-9._-]+$/i.test(m.id) && DAY.test(m.closes) && m.closes > "2026-11-22" && /^https:\/\/kalshi\.com\/markets\/[a-z0-9._-]+$/.test(m.url)))
check(3, "Kalshi: sports and election pages from the unfiltered search are not served", pickKalshi(fx.kalshi_unfiltered, NOW).length === 0)
check(4, "Kalshi: an event whose markets have all closed or settled is dropped", pickKalshi([{ event_title: "Old", event_ticker: "KXOLD-1", series_ticker: "KXOLD", category: "Economics", recent_volume: 9, markets: [{ close_ts: "2026-11-01T00:00:00Z", result: "" }, { close_ts: "2027-01-01T00:00:00Z", result: "yes" }] }], NOW).length === 0)
check(5, "Kalshi: a ticker that is not plain is refused", pickKalshi([{ event_title: "X", event_ticker: "KX/../x", series_ticker: "KX", category: "Economics", recent_volume: 9, markets: [{ close_ts: "2027-01-01T00:00:00Z", result: "" }] }], NOW).length === 0)
check(6, "Kalshi: junk in place of a list is an empty list", pickKalshi(null, NOW).length === 0 && pickKalshi("x", NOW).length === 0 && pickKalshi([null, 3, "a"], NOW).length === 0)

// ── Polymarket ──
const pEco = pickPolymarket(fx.polymarket_events.economy, "economy", NOW)
check(10, "Polymarket: the captured economy page yields markets with a link and a close day", pEco.length >= 1 && pEco.every((m) => m.venue === "polymarket" && DAY.test(m.closes) && /^https:\/\/polymarket\.com\/event\/[a-z0-9-]+$/.test(m.url)))
check(11, "Polymarket: sports events are not served", pickPolymarket(fx.polymarket_events.sports_sample, "politics", NOW).length === 0)
check(12, "Polymarket: the rule is the opening of the venue's description, capped", pEco.every((m) => m.rule === undefined || (m.rule.length > 0 && m.rule.length <= 283)))
check(13, "Polymarket: a closed event, a past end date and a slug that is not plain are refused", pickPolymarket([
  { id: 1, title: "A", slug: "a", endDate: "2027-01-01T00:00:00Z", volume24hr: 5, closed: true, tags: [] },
  { id: 2, title: "B", slug: "b", endDate: "2026-11-01T00:00:00Z", volume24hr: 5, tags: [] },
  { id: 3, title: "C", slug: "c/../d", endDate: "2027-01-01T00:00:00Z", volume24hr: 5, tags: [] },
], "economy", NOW).length === 0)

// ── text and titles ──
check(20, "a title that turns on a death or on violence is blocked", ["Will X die before 2027?", "Putin assassinated in 2026?", "Number of deaths in the strike", "Will there be a terrorist attack?"].every(blockedTitle))
check(21, "ordinary market titles are not blocked", ["Fed decision in December?", "Bitcoin price at the end of 2026", "Who will be the next CEO of NVIDIA?", "US-Iran nuclear deal?", "Will the SAVE Act become law?"].every((t) => !blockedTitle(t)))
check(22, "a blocked title is dropped from both venues", pickKalshi([{ event_title: "Will X die this year?", event_ticker: "KXD-1", series_ticker: "KXD", category: "Politics", recent_volume: 9, markets: [{ close_ts: "2027-01-01T00:00:00Z", result: "" }] }], NOW).length === 0 && pickPolymarket([{ id: 9, title: "Will X be killed?", slug: "x", endDate: "2027-01-01T00:00:00Z", volume24hr: 1, tags: [] }], "politics", NOW).length === 0)
check(23, "cleanText strips control characters, collapses space and caps the length", cleanText("a\u0000b\n\n  c‮", 50) === "a b c" && cleanText("word ".repeat(100), 40).length <= 43 && cleanText(42, 10) === "")
check(24, "firstSentences ends on a full stop when it can", firstSentences("One. Two is longer than the first. " + "x".repeat(400), 60) === "One. Two is longer than the first.")

// ── order ──
const mk = (venue, id, v) => ({ venue, id, title: id, category: "c", closes: "2027-01-01", url: "https://x", volume_24h: v })
const arranged = arrange([mk("kalshi", "k1", 5), mk("kalshi", "k2", 50), mk("kalshi", "k2", 50)], [mk("polymarket", "p1", 7), mk("polymarket", "p2", 70)])
check(30, "busiest first within a venue, one per id, venues take turns", arranged.map((m) => m.id).join() === "k2,p2,k1,p1")
check(31, `never more than ${TRY_MARKETS_MAX}`, arrange(Array.from({ length: 9 }, (_, i) => mk("kalshi", "k" + i, i)), Array.from({ length: 9 }, (_, i) => mk("polymarket", "p" + i, i))).length === TRY_MARKETS_MAX)

// ── Hyperliquid perps ──
const hl = pickHyperliquid(fx.hyperliquid)
check(32, `Hyperliquid: ${TRY_PERPS_MAX} perps, the most traded first, each with a plain name, its move over the day and a link`, hl.length === TRY_PERPS_MAX && hl[0].id === "BTC" && new Set(hl.map((p) => p.id)).size === hl.length && hl.every((p) => p.venue === "hyperliquid" && /^[A-Za-z0-9]{1,12}$/.test(p.id) && p.title === `${p.id} perp` && Number.isFinite(p.change_24h) && p.volume_24h > 0 && p.url === `https://app.hyperliquid.xyz/trade/${p.id}`))
check(33, "Hyperliquid: the second is the day's biggest riser and the third its biggest faller among the twelve most traded", hl[1].change_24h >= hl[0].change_24h && hl[2].change_24h <= hl[0].change_24h && hl[1].change_24h > hl[2].change_24h)
check(34, "Hyperliquid: a perp is named with a fact, never a direction", hl.every((p) => Object.keys(p).sort().join() === "change_24h,id,title,url,venue,volume_24h"))
check(35, "Hyperliquid: delisted, zero-volume and oddly named assets are refused, and junk is an empty list", pickHyperliquid([{ universe: [{ name: "OLD", isDelisted: true }, { name: "ZERO" }, { name: "bad/../x" }, { name: "OK" }] }, [{ dayNtlVlm: "9", markPx: "1", prevDayPx: "1" }, { dayNtlVlm: "0", markPx: "1", prevDayPx: "1" }, { dayNtlVlm: "9", markPx: "1", prevDayPx: "1" }, { dayNtlVlm: "5", markPx: "11", prevDayPx: "10" }]]).map((p) => p.id + p.change_24h).join() === "OK10" && pickHyperliquid(null).length === 0 && pickHyperliquid([{}, 3]).length === 0)

// ── the route ──
const j = async (r) => ({ status: r.status, headers: r.headers, body: await r.json() })
const real = arrange(kAll, pEco)
const fakeCache = () => { const m = new Map(); return { m, async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined }, async put(req, res) { m.set(req.url, res) } } }
{
  const cache = fakeCache(); let reads = 0
  const read = async () => { reads++; return { markets: real, perps: hl, venues: { kalshi: true, polymarket: true, hyperliquid: true } } }
  const a = await j(await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets"), { read, cache, now: () => NOW }))
  check(40, "GET answers 200 with the markets and the time they were read", a.status === 200 && a.body.ok === true && a.body.as_of === NOW.toISOString() && a.body.markets.length === real.length && a.body.markets.length > 0 && a.body.perps.length === hl.length)
  check(41, "the answer names markets and nothing else: no price, outcome or side", a.body.markets.every((m) => Object.keys(m).every((k) => ["venue", "id", "title", "category", "closes", "url", "volume_24h", "rule"].includes(k))))
  check(42, "CORS is open and the answer may be kept for the TTL", a.headers.get("access-control-allow-origin") === "*" && a.headers.get("cache-control") === `public, max-age=${TRY_MARKETS_TTL_SECONDS}`)
  const b = await j(await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets"), { read, cache, now: () => new Date(NOW.getTime() + 60_000) }))
  check(43, "a second request is served from the cache: the venues are not read again", reads === 1 && b.body.as_of === NOW.toISOString())
}
{
  const cache = fakeCache()
  const a = await j(await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets"), { read: async () => ({ markets: [], perps: [], venues: { kalshi: false, polymarket: false, hyperliquid: false } }), cache, now: () => NOW }))
  check(44, "neither venue readable: 200 with an empty list, not an error, and not kept", a.status === 200 && a.body.ok === true && a.body.markets.length === 0 && a.body.perps.length === 0 && a.headers.get("cache-control") === "no-store" && cache.m.size === 0)
  const one = await j(await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets"), { read: async () => ({ markets: pEco, perps: [], venues: { kalshi: false, polymarket: true, hyperliquid: false } }), cache: null, now: () => NOW }))
  check(45, "one venue down: the other is still served and the answer says which was reached", one.body.markets.length === pEco.length && one.body.venues.kalshi === false && one.body.venues.polymarket === true)
}
check(46, "POST is refused, OPTIONS answers the preflight", (await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets", { method: "POST" }), { cache: null })).status === 405 && (await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets", { method: "OPTIONS" }), { cache: null })).status === 204)
{
  const a = await j(await handleTryMarkets(new Request("https://mcp.djzs.ai/try/markets"), { read: async () => ({ markets: real, perps: hl, venues: { kalshi: true, polymarket: true, hyperliquid: true } }), cache: { async match() { throw new Error("secret-cache-detail") }, async put() { throw new Error("secret-cache-detail") } }, now: () => NOW }))
  check(47, "a cache that throws is skipped and its error text never reaches the answer", a.status === 200 && !JSON.stringify(a.body).includes("secret-cache-detail"))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
