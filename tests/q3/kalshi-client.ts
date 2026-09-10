/**
 * Kalshi public trades → VWAP for the audited side (protocol v1.3.1). No auth. Re-queryable by anyone with the same params.
 *   GET https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=&min_ts=&max_ts=&limit=1000[&cursor=]
 * Fill fields used: yes_price_dollars / no_price_dollars (fixed-point strings), count_fp or count, created_time.
 */
export interface KalshiFill { trade_id: string; ticker: string; created_time: string; yes_price_dollars?: string; no_price_dollars?: string; yes_price?: number; no_price?: number; count_fp?: string | number; count?: number; taker_side?: string; taker_outcome_side?: string }
export interface KalshiVwap { vwap: number | null; trade_count: number; contracts: number; volume_usdc: number; window_start: string; window_end: string; query: { ticker: string; min_ts: number; max_ts: number; side: string } }
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
export async function fetchKalshiFillsPaged(ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch = fetch, maxPages = 50): Promise<{ fills: KalshiFill[]; truncated: boolean; pages: number }> {
  const out: KalshiFill[] = []; let cursor: string | undefined; let pages = 0;
  while (pages < maxPages) {
    const u = `${BASE}/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${minTs}&max_ts=${maxTs}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetchImpl(u); if (!r.ok) throw new Error(`kalshi trades HTTP ${r.status}`);
    const j = await r.json() as { trades?: KalshiFill[]; cursor?: string }; out.push(...(j.trades ?? [])); pages++; cursor = j.cursor || undefined; if (!cursor) break;
  }
  // truncated = the feed still had a cursor when the page budget ran out, so these fills are NOT the whole set.
  return { fills: out, truncated: Boolean(cursor), pages };
}
export async function fetchKalshiFills(ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch = fetch): Promise<KalshiFill[]> {
  return (await fetchKalshiFillsPaged(ticker, minTs, maxTs, fetchImpl, 50)).fills;
}
/** v1.7(a) — the bound market's traded volume at audit, from the SAME per-fill history the VWAP is computed from.
 *  Unit: USD that changed hands on the TAKER leg, Σ(taker-side price × count) over fills — the same single-counted
 *  taker-leg basis Dune's SUM(amount) returns for Polymarket, so v1.7(b)'s one 25,000 USD threshold reads against one
 *  measure rather than two. Valuing every fill at the YES price instead understates a lopsided strike by 1/p: on a
 *  0.01/0.99 market a 22,000-contract NO taker moves $21,780, which a YES basis would record as $220.
 *  It stays a property of the MARKET, not of the record: the sum runs over every fill whichever side the record audits.
 *  volume_24h  = fills in [end - 24h, end).   volume_total = every fill before end (min_ts = 0).
 *  Unknown is never reported as zero. Truncation, an empty fill history, a fill whose taker side or price cannot be
 *  read, or a total that sums to zero all return null with a note. The VWAP gate has already proven fills exist inside
 *  a window strictly contained in [0, end), so a zero total is not a possible true answer here — only a missing one. */
export interface KalshiVolumes { volume_24h: number | null; volume_total: number | null; fills: number; pages: number; truncated: boolean; window_24h_start: string; as_of: string; note?: string }
export async function kalshiVolumes(ticker: string, endIso: string, fetchImpl: typeof fetch = fetch, maxPages = 400): Promise<KalshiVolumes> {
  const end = Math.floor(new Date(endIso).getTime() / 1000); const start24 = end - 24 * 3600;
  const { fills, truncated, pages } = await fetchKalshiFillsPaged(ticker, 0, end, fetchImpl, maxPages);
  const base = { fills: fills.length, pages, truncated, window_24h_start: new Date(start24 * 1000).toISOString(), as_of: new Date(end * 1000).toISOString() };
  if (truncated) return { ...base, volume_24h: null, volume_total: null, note: `fill history truncated at ${pages} pages — refusing to report a partial sum as a total` };
  if (fills.length === 0) return { ...base, volume_24h: null, volume_total: null, note: "the feed returned no fills at all — an empty history is not a measured zero" };
  let v24 = 0, vtot = 0, unusable = 0;
  for (const t of fills) {
    const ts = Math.floor(new Date(t.created_time).getTime() / 1000); if (!(ts < end)) continue;
    const notional = takerPx(t) * qty(t); if (!(notional > 0)) { unusable++; continue; }
    vtot += notional; if (ts >= start24) v24 += notional;
  }
  if (unusable > 0) return { ...base, volume_24h: null, volume_total: null, note: `${unusable}/${fills.length} fills carried no readable taker side, price or size — refusing to report an undercounted sum as a total` };
  if (!(vtot > 0)) return { ...base, volume_24h: null, volume_total: null, note: `${fills.length} fills summed to zero notional — refusing to seal 0 as a measured total` };
  return { ...base, volume_24h: v24, volume_total: vtot };
}
/** Price of the leg the TAKER traded. NaN when the side is unreadable — never a silent YES default, because
 *  defaulting the leg is exactly how a lopsided strike gets understated by 1/p. */
const takerPx = (t: KalshiFill) => {
  const s = String(t.taker_outcome_side ?? t.taker_side ?? "").toLowerCase();
  if (s !== "yes" && s !== "no") return NaN;
  return s === "no" ? Number(t.no_price_dollars ?? (t.no_price ?? 0) / 100) : Number(t.yes_price_dollars ?? (t.yes_price ?? 0) / 100);
};
const px = (t: KalshiFill, side: string) => side === "no" ? Number(t.no_price_dollars ?? (t.no_price ?? 0) / 100) : Number(t.yes_price_dollars ?? (t.yes_price ?? 0) / 100);
const qty = (t: KalshiFill) => Number(t.count_fp ?? t.count ?? 0);
/** VWAP of the audited side over fills in [endIso − windowMin, endIso). Window bounds are whole seconds (the endpoint takes unix seconds). */
export async function kalshiVwap(ticker: string, side: string, endIso: string, windowMin: number, fetchImpl: typeof fetch = fetch): Promise<KalshiVwap> {
  const s = side.toLowerCase(); if (s !== "yes" && s !== "no") throw new Error(`side must be yes|no, got ${side}`);
  const max_ts = Math.floor(new Date(endIso).getTime() / 1000); const min_ts = max_ts - windowMin * 60;
  const fills = (await fetchKalshiFills(ticker, min_ts, max_ts, fetchImpl)).filter(t => { const ts = new Date(t.created_time).getTime() / 1000; return ts >= min_ts && ts < max_ts && qty(t) > 0; });
  let num = 0, den = 0; for (const t of fills) { num += px(t, s) * qty(t); den += qty(t); }
  return { vwap: den > 0 ? num / den : null, trade_count: fills.length, contracts: den, volume_usdc: num, window_start: new Date(min_ts * 1000).toISOString(), window_end: new Date(max_ts * 1000).toISOString(), query: { ticker, min_ts, max_ts, side: s } };
}
