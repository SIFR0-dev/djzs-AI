/**
 * try-market-lookup.ts - GET /try/market?id=<what the person typed in the market id box>
 *
 * WHY. The paid route binds a receipt to the market id the caller names. Nothing compared that id with the
 * thesis: on 2026-11-23 a Fed-decision id was accepted for an NVIDIA thesis. This route answers one question,
 * with no model: which market is this id, on which venue, and is it still open? The page shows the venue's
 * own title beside the box, so a wrong, misspelled or settled market is seen before any money moves.
 *
 * WHAT IT READS. The venue's public record for exactly the id given:
 *   Kalshi      a market ticker (KXFEDDECISION-26DEC-H0) or an event ticker (KXFEDDECISION-26DEC)
 *   Polymarket  a market slug or an event slug
 * A venue URL is accepted too; the id is taken from its path. The id's shape picks the venue to try first,
 * and the other is tried when the first has no such record.
 *
 * WHAT IT DOES NOT DO. It does not judge whether the thesis is about this market (the page compares words and
 * shows both, the person decides), it returns no price, odds or side, and it never touches extraction, the
 * verdict, verdict_hash or the attestation. A venue that cannot be reached is `reached: false`, never an error.
 */
import { cleanText, firstSentences } from "./try-markets"

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
const POLYMARKET = "https://gamma-api.polymarket.com"
const TIMEOUT_MS = 6_000
export const TRY_MARKET_TTL_SECONDS = 300
const MAX_ID = 160

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
}
function json(obj: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS, ...extra } })
}

export type MarketState = "open" | "closed" | "settled"
export interface MarketRecord {
  venue: "kalshi" | "polymarket"
  /** The venue's own id for the record that answered. */
  id: string
  /** market = one tradable contract; event = a group of them (the id names the question, not one outcome). */
  level: "market" | "event"
  title: string
  /** The outcome this contract pays on, when the venue names one (Kalshi yes_sub_title, e.g. "Jensen Huang"). */
  outcome: string
  /** The venue's rule for this contract, first sentences only. */
  rule: string
  state: MarketState
  /** ISO day trading closes, when the venue gives one. */
  closes: string
  url: string
}
export interface MarketLookup {
  ok: true
  query: string
  /** false when no venue could be reached; `found` then says nothing. */
  reached: boolean
  found: boolean
  market: MarketRecord | null
}

/** One fetch, JSON or null. `status` separates "no such record" (404 or an empty list) from "could not reach". */
export type Getter = (url: string) => Promise<{ status: number; data: unknown } | null>
const httpGet: Getter = async (url) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal })
    let data: unknown = null
    try { data = await r.json() } catch { /* a body that is not JSON is no record */ }
    return { status: r.status, data }
  } catch { return null } finally { clearTimeout(timer) }
}

const KALSHI_ID = /^[A-Z0-9][A-Z0-9._-]{2,79}$/
const POLY_SLUG = /^[a-z0-9][a-z0-9-]{2,119}$/

/** What the person typed, reduced to the ids worth trying, in order. No model: shape only. */
export function candidates(raw: string): { venue: "kalshi" | "polymarket"; id: string }[] {
  let q = (raw ?? "").trim().slice(0, MAX_ID * 3)
  const out: { venue: "kalshi" | "polymarket"; id: string }[] = []
  const push = (venue: "kalshi" | "polymarket", id: string) => {
    if (id.length > MAX_ID) return
    if (venue === "kalshi" ? !KALSHI_ID.test(id) : !POLY_SLUG.test(id)) return
    if (!out.some((c) => c.venue === venue && c.id === id)) out.push({ venue, id })
  }
  let host = ""
  if (/^https?:\/\//i.test(q)) {
    try {
      const u = new URL(q)
      host = u.hostname.toLowerCase().replace(/^www\./, "")
      const segs = u.pathname.split("/").filter(Boolean)
      if (host === "kalshi.com") { for (const s of segs.slice().reverse()) push("kalshi", s.toUpperCase()); return out }
      if (host === "polymarket.com") { for (const s of segs.slice().reverse()) if (s !== "event" && s !== "market") push("polymarket", s.toLowerCase()); return out }
    } catch { /* not a URL after all */ }
    return out
  }
  q = q.replace(/^["'`]+|["'`.,;]+$/g, "")
  if (!q || /\s/.test(q)) return out
  // A slug is lower case with hyphens; a Kalshi ticker is upper case. Mixed or bare input tries Kalshi first.
  if (POLY_SLUG.test(q) && /[a-z]/.test(q) && q === q.toLowerCase() && q.includes("-")) { push("polymarket", q); push("kalshi", q.toUpperCase()) }
  else { push("kalshi", q.toUpperCase()); push("polymarket", q.toLowerCase()) }
  return out
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")
const day = (v: unknown): string => { const t = Date.parse(str(v)); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "" }
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function kalshiState(status: string, result: string): MarketState {
  const s = status.toLowerCase()
  if (result || s === "finalized" || s === "settled" || s === "determined") return "settled"
  return s === "active" || s === "open" || s === "initialized" ? "open" : "closed"
}

export function fromKalshiMarket(data: unknown): MarketRecord | null {
  const m = rec(rec(data)?.market)
  const id = str(m?.ticker), title = cleanText(m?.title, 160)
  if (!m || !KALSHI_ID.test(id) || !title) return null
  const event = str(m.event_ticker), series = event.split("-")[0].toLowerCase()
  return {
    venue: "kalshi", id, level: "market", title,
    outcome: cleanText(m.yes_sub_title, 80) || cleanText(m.subtitle, 80),
    rule: firstSentences(m.rules_primary, 240),
    state: kalshiState(str(m.status), str(m.result)),
    closes: day(m.close_time),
    url: series ? `https://kalshi.com/markets/${series}` : "https://kalshi.com",
  }
}
export function fromKalshiEvent(data: unknown): MarketRecord | null {
  const d = rec(data), e = rec(d?.event)
  const id = str(e?.event_ticker), title = cleanText(e?.title, 160)
  if (!e || !KALSHI_ID.test(id) || !title) return null
  const markets = Array.isArray(d?.markets) ? (d!.markets as unknown[]).map(rec).filter(Boolean) as Record<string, unknown>[] : []
  const states = markets.map((m) => kalshiState(str(m.status), str(m.result)))
  const state: MarketState = states.includes("open") ? "open" : states.length && states.every((s) => s === "settled") ? "settled" : states.length ? "closed" : "open"
  const closes = markets.map((m) => day(m.close_time)).filter(Boolean).sort().pop() ?? ""
  return { venue: "kalshi", id, level: "event", title, outcome: "", rule: "", state, closes, url: `https://kalshi.com/markets/${id.split("-")[0].toLowerCase()}` }
}

function polyState(o: Record<string, unknown>): MarketState {
  if (o.closed === true) return str(o.umaResolutionStatus) === "resolved" || o.archived === true ? "settled" : "closed"
  return o.active === false ? "closed" : "open"
}
export function fromPolymarket(data: unknown, level: "market" | "event"): MarketRecord | null {
  const o = Array.isArray(data) ? rec(data[0]) : null
  const id = str(o?.slug), title = cleanText(level === "market" ? o?.question : o?.title, 160)
  if (!o || !POLY_SLUG.test(id) || !title) return null
  return {
    venue: "polymarket", id, level, title, outcome: "",
    rule: firstSentences(o.description, 240),
    state: polyState(o), closes: day(o.endDate),
    url: level === "event" ? `https://polymarket.com/event/${id}` : `https://polymarket.com/market/${id}`,
  }
}

/** Try each candidate in order. The first record wins. `reached` is true once any venue answered at all. */
export async function lookupMarket(raw: string, get: Getter = httpGet): Promise<MarketLookup> {
  const query = cleanText(raw, MAX_ID)
  let reached = false
  for (const c of candidates(raw)) {
    const tries: [string, (d: unknown) => MarketRecord | null][] = c.venue === "kalshi"
      ? [[`${KALSHI}/markets/${encodeURIComponent(c.id)}`, fromKalshiMarket], [`${KALSHI}/events/${encodeURIComponent(c.id)}`, fromKalshiEvent]]
      : [[`${POLYMARKET}/markets?slug=${encodeURIComponent(c.id)}&limit=1`, (d) => fromPolymarket(d, "market")], [`${POLYMARKET}/events?slug=${encodeURIComponent(c.id)}&limit=1`, (d) => fromPolymarket(d, "event")]]
    for (const [url, read] of tries) {
      const r = await get(url)
      if (!r) continue
      if (r.status === 200 || r.status === 404) reached = true
      if (r.status !== 200) continue
      const market = read(r.data)
      if (market) return { ok: true, query, reached: true, found: true, market }
    }
  }
  return { ok: true, query, reached, found: false, market: null }
}

type EdgeCache = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }

export async function handleTryMarket(request: Request, deps: { get?: Getter; cache?: EdgeCache | null } = {}): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "GET") return json({ error: "method_not_allowed", allow: "GET, OPTIONS" }, 405)
  const raw = new URL(request.url).searchParams.get("id") ?? ""
  if (!raw.trim() || raw.length > MAX_ID * 3) return json({ ok: false, error: "id_required" }, 400)
  const cands = candidates(raw)
  // Nothing in the text has the shape of a venue id: answer without a network call.
  if (cands.length === 0) return json({ ok: true, query: cleanText(raw, MAX_ID), reached: true, found: false, market: null } satisfies MarketLookup, 200, { "cache-control": "no-store" })
  const cache = deps.cache === undefined ? ((globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null) : deps.cache
  const key = new Request(`https://mcp.djzs.ai/try/market?v=1&id=${encodeURIComponent(cands.map((c) => `${c.venue}:${c.id}`).sort().join(","))}`)
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return hit } catch { /* a cache that cannot be read is skipped */ }
  }
  const body = await lookupMarket(raw, deps.get ?? httpGet)
  const res = json(body, 200, { "cache-control": body.reached ? `public, max-age=${TRY_MARKET_TTL_SECONDS}` : "no-store" })
  if (cache && body.reached) {
    try { await cache.put(key, res.clone()) } catch { /* not kept this time */ }
  }
  return res
}
