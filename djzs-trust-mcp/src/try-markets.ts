/**
 * GET /try/markets: prediction markets trading today, for the home page's "start from a market" buttons.
 *
 * What it serves: up to six open events from Kalshi and Polymarket. In each of a few categories the venue is
 * asked for its largest open events, and the one traded most in the last day is taken. "Busy today", not a
 * claim to be the single busiest market on the venue. For each: the venue, the event's own title, the day it closes, a link, and (Polymarket) the
 * opening of the venue's own description. Nothing else. No price, no outcome and no side is chosen here:
 * the page names the market and the person writes the thesis. DJZS does not pick a side.
 *
 * What it is not: a paid route, a verdict, or a record. It reads public venue APIs, calls no model, touches
 * no key, no D1 and no chain. If a venue cannot be read it is left out; if neither can, the list is empty and
 * the page falls back to its recorded samples. An empty list is a true answer, not an error.
 *
 * Venue text is data, not instructions. It is length-capped and stripped of control characters here and
 * HTML-escaped by the page. Titles that turn on someone's death or on violence are not served on a home page.
 *
 * It also serves up to three perps trading today on Hyperliquid (`perps`): the one with the most volume in
 * the last day, and the biggest riser and faller among the twelve most traded. A perp is named with its move
 * over the last day, which is a fact about the market. No direction is suggested.
 *
 * Sources (read 2026-11-22):
 *   Polymarket  gamma-api.polymarket.com/events?closed=false&active=true&order=volume24hr&tag_slug=<tag>
 *   Kalshi      api.elections.kalshi.com/v1/search/series?order_by=event-volume&status=open&category=<cat>
 *   Hyperliquid POST api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"} (the published info endpoint)
 * The Kalshi search path is the one kalshi.com itself calls. It is not in Kalshi's published API reference,
 * so it can change without notice; when it does, Kalshi drops out of the list and Polymarket remains.
 * (The published v2 API has no volume ordering and lists about seventeen thousand open events.)
 */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
}
function json(obj: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra } })
}

export type TryMarket = { venue: "kalshi" | "polymarket"; id: string; title: string; category: string; closes: string; url: string; volume_24h: number; rule?: string }

export const KALSHI_CATEGORIES = ["Economics", "Financials", "Crypto", "Politics"] as const
export const POLYMARKET_TAGS = [
  { slug: "economy", limit: 2 },
  { slug: "crypto", limit: 2 },
  { slug: "politics", limit: 1 },
] as const
export type TryPerp = { venue: "hyperliquid"; id: string; title: string; change_24h: number; volume_24h: number; url: string }
export const TRY_MARKETS_MAX = 6
export const TRY_PERPS_MAX = 3
/** How long one read of the venues is reused. The venues are read at most this often, whatever the traffic. */
export const TRY_MARKETS_TTL_SECONDS = 1800

const BLOCKED = /\b(die|dies|died|dying|death|deaths|dead|assassinat\w*|kill\w*|murder\w*|suicide|shoot\w*|shot|terror\w*|massacre\w*|genocide|hostage\w*|execut(?:ed|ion\w*)|bomb\w*)\b/i
/** Pure. A title that turns on someone's death or on violence is not put on the home page. */
export function blockedTitle(title: string): boolean { return BLOCKED.test(title) }

// Control, zero-width and bidirectional-override characters. Built from escapes so none of them sits in this file.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202f\\ufeff]", "g")

/** Pure. One line of venue text: control characters out, whitespace collapsed, capped on a word boundary. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return ""
  const s = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = cut.lastIndexOf(" ")
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "") + "..."
}

/** Pure. The opening sentences of a venue description, up to `max` characters, ending on a full stop when it can. */
export function firstSentences(v: unknown, max: number): string {
  const s = cleanText(v, 4000)
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\u201d "))
  return stop > max * 0.4 ? head.slice(0, stop + 1) : cleanText(s, max)
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Pure. Kalshi search rows -> markets. Open events only: at least one nested market still closes after `now`. */
export function pickKalshi(rows: unknown, now: Date): TryMarket[] {
  if (!Array.isArray(rows)) return []
  const out: TryMarket[] = []
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue
    const title = cleanText(r.event_title, 120)
    const ticker = cleanText(r.event_ticker, 60)
    const series = cleanText(r.series_ticker, 60)
    const category = cleanText(r.category, 40)
    if (!title || !/^[A-Z0-9][A-Z0-9._-]*$/i.test(ticker) || !/^[A-Z0-9][A-Z0-9._-]*$/i.test(series)) continue
    if (!(KALSHI_CATEGORIES as readonly string[]).includes(category) || blockedTitle(title)) continue
    const closeTimes = (Array.isArray(r.markets) ? (r.markets as Record<string, unknown>[]) : [])
      .map((m) => (m && typeof m.close_ts === "string" && !m.result ? Date.parse(m.close_ts) : NaN))
      .filter((t) => Number.isFinite(t) && t > now.getTime())
    if (closeTimes.length === 0) continue
    const vol = Number(r.recent_volume)
    out.push({ venue: "kalshi", id: ticker, title, category, closes: day(Math.max(...closeTimes)), url: `https://kalshi.com/markets/${series.toLowerCase()}`, volume_24h: Number.isFinite(vol) && vol > 0 ? Math.round(vol) : 0 })
  }
  return out
}

/** Pure. Polymarket events -> markets. Sports and closed events are left out. */
export function pickPolymarket(events: unknown, tag: string, now: Date): TryMarket[] {
  if (!Array.isArray(events)) return []
  const out: TryMarket[] = []
  for (const e of events as Record<string, unknown>[]) {
    if (!e || typeof e !== "object" || e.closed === true || e.active === false) continue
    const title = cleanText(e.title, 120)
    const slug = cleanText(e.slug, 160)
    const id = typeof e.id === "string" || typeof e.id === "number" ? String(e.id) : ""
    if (!title || !id || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || blockedTitle(title)) continue
    const tags = Array.isArray(e.tags) ? (e.tags as Record<string, unknown>[]).map((t) => String(t?.label ?? "").toLowerCase()) : []
    if (tags.includes("sports")) continue
    const end = typeof e.endDate === "string" ? Date.parse(e.endDate) : NaN
    if (!Number.isFinite(end) || end <= now.getTime()) continue
    const vol = Number(e.volume24hr)
    const rule = firstSentences(e.description, 280)
    out.push({ venue: "polymarket", id, title, category: tag, closes: day(end), url: `https://polymarket.com/event/${slug}`, volume_24h: Number.isFinite(vol) && vol > 0 ? Math.round(vol) : 0, ...(rule ? { rule } : {}) })
  }
  return out
}

/** Pure. Busiest first within each venue, one event per id, then the venues take turns. */
export function arrange(kalshi: TryMarket[], polymarket: TryMarket[], max = TRY_MARKETS_MAX): TryMarket[] {
  const rank = (xs: TryMarket[]) => {
    const seen = new Set<string>()
    return [...xs].sort((a, b) => b.volume_24h - a.volume_24h).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
  }
  const k = rank(kalshi), p = rank(polymarket)
  const out: TryMarket[] = []
  for (let i = 0; out.length < max && (i < k.length || i < p.length); i++) {
    if (i < k.length) out.push(k[i])
    if (out.length < max && i < p.length) out.push(p[i])
  }
  return out
}

/**
 * Pure. Hyperliquid's [meta, assetCtxs] -> up to three perps: the most traded in the last day, then the biggest
 * riser and the biggest faller among the twelve most traded, then the next most traded to fill.
 */
export function pickHyperliquid(data: unknown, max = TRY_PERPS_MAX): TryPerp[] {
  if (!Array.isArray(data) || data.length < 2) return []
  const universe = (data[0] as { universe?: unknown } | null)?.universe
  const ctxs = data[1]
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return []
  const rows: TryPerp[] = []
  for (let i = 0; i < universe.length && i < ctxs.length; i++) {
    const u = universe[i] as Record<string, unknown> | null, c = ctxs[i] as Record<string, unknown> | null
    if (!u || !c || u.isDelisted === true) continue
    const name = typeof u.name === "string" ? u.name : ""
    if (!/^[A-Za-z0-9]{1,12}$/.test(name)) continue
    const vol = Number(c.dayNtlVlm), mark = Number(c.markPx), prev = Number(c.prevDayPx)
    if (!(vol > 0) || !(mark > 0) || !(prev > 0)) continue
    rows.push({ venue: "hyperliquid", id: name, title: `${name} perp`, change_24h: Math.round((mark / prev - 1) * 1000) / 10, volume_24h: Math.round(vol), url: `https://app.hyperliquid.xyz/trade/${name}` })
  }
  rows.sort((a, b) => b.volume_24h - a.volume_24h)
  const top = rows.slice(0, 12)
  const out: TryPerp[] = []
  const add = (r: TryPerp | undefined) => { if (r && out.length < max && !out.some((o) => o.id === r.id)) out.push(r) }
  add(top[0])
  add([...top].sort((a, b) => b.change_24h - a.change_24h)[0])
  add([...top].sort((a, b) => a.change_24h - b.change_24h)[0])
  for (const r of top) add(r)
  return out
}

async function getJson(url: string, ms: number, post?: unknown): Promise<unknown> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, post === undefined ? { signal: ctl.signal, headers: { accept: "application/json" } } : { method: "POST", signal: ctl.signal, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(post) })
    return r.ok ? await r.json() : null
  } catch {
    return null // a venue that cannot be read is left out; no error text leaves this module
  } finally {
    clearTimeout(t)
  }
}

/** Reads both venues. Never throws: a venue that fails contributes nothing. */
export async function readMarkets(now: Date): Promise<{ markets: TryMarket[]; perps: TryPerp[]; venues: { kalshi: boolean; polymarket: boolean; hyperliquid: boolean } }> {
  const [k, p, h] = await Promise.all([
    Promise.all(KALSHI_CATEGORIES.map((c) => getJson(`https://api.elections.kalshi.com/v1/search/series?order_by=event-volume&status=open&page_size=8&category=${encodeURIComponent(c)}`, 3000))),
    Promise.all(POLYMARKET_TAGS.map((t) => getJson(`https://gamma-api.polymarket.com/events?closed=false&active=true&order=volume24hr&ascending=false&limit=${t.limit}&tag_slug=${t.slug}`, 3000))),
    getJson("https://api.hyperliquid.xyz/info", 3000, { type: "metaAndAssetCtxs" }),
  ])
  // One event per Kalshi category, the busiest in it, so one loud category cannot take every slot.
  const kalshi = k.flatMap((j) => pickKalshi((j as { current_page?: unknown } | null)?.current_page, now).sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 1))
  const polymarket = p.flatMap((j, i) => pickPolymarket(j, POLYMARKET_TAGS[i].slug, now))
  return { markets: arrange(kalshi, polymarket), perps: pickHyperliquid(h), venues: { kalshi: k.some((j) => j !== null), polymarket: p.some((j) => j !== null), hyperliquid: h !== null } }
}

type EdgeCache = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }

export async function handleTryMarkets(request: Request, deps: { read?: typeof readMarkets; cache?: EdgeCache | null; now?: () => Date } = {}): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "GET") return json({ error: "method_not_allowed", allow: "GET, OPTIONS" }, 405)
  const cache = deps.cache === undefined ? ((globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null) : deps.cache
  const key = new Request("https://mcp.djzs.ai/try/markets?v=2")
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return hit } catch { /* a cache that cannot be read is skipped */ }
  }
  const now = (deps.now ?? (() => new Date()))()
  const { markets, perps, venues } = await (deps.read ?? readMarkets)(now)
  const body = { ok: true, as_of: now.toISOString(), venues, markets, perps }
  // A read that reached no venue is not kept: the next request tries again.
  const reached = venues.kalshi || venues.polymarket || venues.hyperliquid
  const res = json(body, 200, { "cache-control": reached ? `public, max-age=${TRY_MARKETS_TTL_SECONDS}` : "no-store" })
  if (cache && reached) {
    try { await cache.put(key, res.clone()) } catch { /* not kept this time */ }
  }
  return res
}
