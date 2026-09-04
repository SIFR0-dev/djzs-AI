/**
 * Kalshi public trades → VWAP for the audited side (protocol v1.3.1). No auth. Re-queryable by anyone with the same params.
 *   GET https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=&min_ts=&max_ts=&limit=1000[&cursor=]
 * Fill fields used: yes_price_dollars / no_price_dollars (fixed-point strings), count_fp or count, created_time.
 */
export interface KalshiFill { trade_id: string; ticker: string; created_time: string; yes_price_dollars?: string; no_price_dollars?: string; yes_price?: number; no_price?: number; count_fp?: string | number; count?: number; taker_side?: string }
export interface KalshiVwap { vwap: number | null; trade_count: number; contracts: number; volume_usdc: number; window_start: string; window_end: string; query: { ticker: string; min_ts: number; max_ts: number; side: string } }
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
export async function fetchKalshiFills(ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch = fetch): Promise<KalshiFill[]> {
  const out: KalshiFill[] = []; let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const u = `${BASE}/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${minTs}&max_ts=${maxTs}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetchImpl(u); if (!r.ok) throw new Error(`kalshi trades HTTP ${r.status}`);
    const j = await r.json() as { trades?: KalshiFill[]; cursor?: string }; out.push(...(j.trades ?? [])); cursor = j.cursor || undefined; if (!cursor) break;
  }
  return out;
}
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
