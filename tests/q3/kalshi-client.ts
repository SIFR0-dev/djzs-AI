/**
 * Kalshi public trades → VWAP for the audited side (protocol v1.3.1). No auth. Re-queryable by anyone with the same params.
 *   GET https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=&min_ts=&max_ts=&limit=1000[&cursor=]      (live tier)
 *   GET https://api.elections.kalshi.com/trade-api/v2/historical/trades?ticker=&min_ts=&max_ts=&limit=1000[&cursor=]   (historical tier)
 * Fill fields used: yes_price_dollars / no_price_dollars (fixed-point strings), count_fp or count, created_time.
 *
 * TWO TIERS, ONE HISTORY (observed 2026-11-09). Kalshi partitions trades into a live and a historical tier: fills created
 * before the venue's `trades_created_ts` cutoff (GET /historical/cutoff) are served ONLY by /historical/trades, and the
 * cutoff advances over time. A walk of /markets/trades alone therefore returns a history that shrinks as the market ages.
 * Instrument: q3-2026-09-14-004 (KXFEDDECISION-26SEP-C25), sealed volume_total 9,183,936.13. With the cutoff at
 * 2026-09-10T00:00Z the live tier alone returned 985 fills / 3,484,793.29 contracts, earliest fill 2026-09-03 on a market
 * opened 2025-09-29 (scheduled run #233 FAILed the record on it); the historical tier returned 5,962 fills / 7,301,662.49;
 * the union, de-duplicated by trade_id, 6,427 fills / 9,225,589.98 (+0.45% vs sealed). 519 fills sat in BOTH tiers, every
 * one byte-identical — the hand-off is buffered, so the tiers overlap and a plain sum double-counts.
 * Rules:
 *  - Both tiers are always walked; the union is de-duplicated by trade_id. Choosing a tier from the cutoff would race it.
 *  - Live is walked FIRST. Overlap shows the venue copies a fill to historical before it leaves live, so a fill that moves
 *    mid-walk is caught by the later historical walk. The reverse order could miss it in both.
 *  - A trade_id present in both tiers with different content is a conflict: throw, never pick one.
 *  - Any non-2xx from either tier throws (the historical tier answers 404 for an unknown ticker): one tier alone is not
 *    the history, so a partial answer is never returned as a whole one.
 *  - The union is ordered newest-first by created_time, ties by trade_id — the feed's own order, made independent of which
 *    tier served each fill, so the same set of fills always serialises identically.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { canonical, sha256hex } from "./lib";
export interface KalshiFill { trade_id: string; ticker: string; created_time: string; yes_price_dollars?: string; no_price_dollars?: string; yes_price?: number; no_price?: number; count_fp?: string | number; count?: number; taker_side?: string; taker_outcome_side?: string }
export interface KalshiVwap { vwap: number | null; trade_count: number; contracts: number; volume_usdc: number; window_start: string; window_end: string; query: { ticker: string; min_ts: number; max_ts: number; side: string } }
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_TIERS = [["live", "/markets/trades"], ["historical", "/historical/trades"]] as const;
export interface KalshiTierStats { live: { fills: number; pages: number; truncated: boolean }; historical: { fills: number; pages: number; truncated: boolean }; overlap: number }
/** One tier, cursor-paginated. truncated = the tier still had a cursor when the page budget ran out. */
async function walkTier(name: string, path: string, ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch, maxPages: number) {
  const out: KalshiFill[] = []; let cursor: string | undefined; let pages = 0;
  while (pages < maxPages) {
    const u = `${BASE}${path}?ticker=${encodeURIComponent(ticker)}&min_ts=${minTs}&max_ts=${maxTs}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetchImpl(u); if (!r.ok) throw new Error(`kalshi trades HTTP ${r.status} (${name} tier)`);
    const j = await r.json() as { trades?: KalshiFill[]; cursor?: string }; out.push(...(j.trades ?? [])); pages++; cursor = j.cursor || undefined; if (!cursor) break;
  }
  return { fills: out, pages, truncated: Boolean(cursor) };
}
const newestFirst = (a: KalshiFill, b: KalshiFill) => (Date.parse(b.created_time) - Date.parse(a.created_time)) || (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0);
/** maxPages is the budget PER TIER. truncated if either tier was cut short: the union is then NOT the whole set. */
export async function fetchKalshiFillsPaged(ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch = fetch, maxPages = 50): Promise<{ fills: KalshiFill[]; truncated: boolean; pages: number; tiers: KalshiTierStats }> {
  const live = await walkTier(KALSHI_TIERS[0][0], KALSHI_TIERS[0][1], ticker, minTs, maxTs, fetchImpl, maxPages);
  const hist = await walkTier(KALSHI_TIERS[1][0], KALSHI_TIERS[1][1], ticker, minTs, maxTs, fetchImpl, maxPages);
  // A repeated trade_id is one fill only if every copy is byte-identical (canonical JSON); otherwise it is a conflict.
  const byId = new Map<string, { f: KalshiFill; tier: string }>(); let overlap = 0; const conflicts: string[] = [];
  for (const [tier, fs] of [["live", live.fills], ["historical", hist.fills]] as const) for (const f of fs) {
    const seen = byId.get(f.trade_id);
    if (!seen) { byId.set(f.trade_id, { f, tier }); continue; }
    if (seen.tier !== tier) overlap++;
    if (canonical(seen.f) !== canonical(f)) conflicts.push(f.trade_id);
  }
  if (conflicts.length) throw new Error(`kalshi trades: ${conflicts.length} trade_id(s) served with different content (first ${conflicts[0]}) — refusing to choose one`);
  const fills = [...byId.values()].map(x => x.f).sort(newestFirst);
  const tiers: KalshiTierStats = { live: { fills: live.fills.length, pages: live.pages, truncated: live.truncated }, historical: { fills: hist.fills.length, pages: hist.pages, truncated: hist.truncated }, overlap };
  return { fills, truncated: live.truncated || hist.truncated, pages: live.pages + hist.pages, tiers };
}
export async function fetchKalshiFills(ticker: string, minTs: number, maxTs: number, fetchImpl: typeof fetch = fetch): Promise<KalshiFill[]> {
  return (await fetchKalshiFillsPaged(ticker, minTs, maxTs, fetchImpl, 50)).fills;
}
/** v1.7(a) — the bound market's traded volume at audit, from the SAME per-fill history the VWAP is computed from.
 *  Unit: Σ(count) over fills — $1 of notional per contract, which the venue itself fixes (the market object carries
 *  notional_value_dollars "1.0000"), so contracts traded IS the traded USD notional. This is the same convention
 *  Polymarket publishes: measured 2026-09-10, Gamma's volume24hr equals Sum(size) at ratio 0.996-1.023 across three
 *  markets from 0.007 to 0.46, while Sum(price*size) lands at 0.027-0.494. One convention on both venues is what
 *  makes v1.7(b)'s single 25,000 USD threshold one threshold, and it is the basis its calibration was taken against,
 *  since the §3 pool ranks on exactly these published numbers.
 *  Price-neutral by construction, so it is a property of the MARKET and not of the record, and it cannot smuggle the
 *  quote back into a stratifier meant to control for it.
 *  volume_24h  = fills in [end - 24h, end).   volume_total = every fill before end (min_ts = 0).
 *  Unknown is never reported as zero. Truncation, an empty fill history, a fill whose taker side or price cannot be
 *  read, or a total that sums to zero all return null with a note. The VWAP gate has already proven fills exist inside
 *  a window strictly contained in [0, end), so a zero total is not a possible true answer here — only a missing one. */
export interface KalshiVolumes { volume_24h: number | null; volume_total: number | null; total_computed: boolean; fills: number; pages: number; truncated: boolean; window_24h_start: string; as_of: string; note?: string; fill_list?: KalshiFill[]; tiers?: KalshiTierStats }
/** includeTotal=false pages ONLY the 24h window, so the full-history walk is not performed at all. volume_total then
 *  comes back null with total_computed false — "not asked for", which the caller must not read as "unknown".
 *  returnFills=true also returns the walk's fills verbatim, in feed order (newest-first across both tiers, see the header),
 *  as `fill_list` — Phase B stores them so a later volume_total drift can be diagnosed fill by fill (SCAN_SPEC §8I). */
export async function kalshiVolumes(ticker: string, endIso: string, fetchImpl: typeof fetch = fetch, maxPages = 400, includeTotal = true, returnFills = false): Promise<KalshiVolumes> {
  const end = Math.floor(new Date(endIso).getTime() / 1000); const start24 = end - 24 * 3600;
  const { fills, truncated, pages, tiers } = await fetchKalshiFillsPaged(ticker, includeTotal ? 0 : start24, end, fetchImpl, maxPages);
  const base = { fills: fills.length, pages, truncated, tiers, total_computed: includeTotal, window_24h_start: new Date(start24 * 1000).toISOString(), as_of: new Date(end * 1000).toISOString(), ...(returnFills ? { fill_list: fills } : {}) };
  if (truncated) return { ...base, volume_24h: null, volume_total: null, note: `fill history truncated at ${pages} pages — refusing to report a partial sum as a total` };
  if (fills.length === 0) return { ...base, volume_24h: null, volume_total: null, note: "the feed returned no fills at all — an empty history is not a measured zero" };
  let v24 = 0, vtot = 0, unusable = 0;
  for (const t of fills) {
    const ts = Math.floor(new Date(t.created_time).getTime() / 1000); if (!(ts < end)) continue;
    const notional = qty(t); if (!(notional > 0)) { unusable++; continue; } // $1 notional per contract
    vtot += notional; if (ts >= start24) v24 += notional;
  }
  if (unusable > 0) return { ...base, volume_24h: null, volume_total: null, note: `${unusable}/${fills.length} fills carried no readable size — refusing to report an undercounted sum as a total` };
  if (includeTotal && !(vtot > 0)) return { ...base, volume_24h: null, volume_total: null, note: `${fills.length} fills summed to zero notional — refusing to seal 0 as a measured total` };
  if (!includeTotal) return { ...base, volume_24h: v24, volume_total: null, note: "24h-only scan: volume_total not computed this run (it is immutable once posted_at is past)" };
  return { ...base, volume_24h: v24, volume_total: vtot };
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

/** SCAN_SPEC §8I — the fill list behind a sealed Kalshi volume_total, stored at Phase B so drift is diagnosable.
 *  Stored verbatim (no field selection: what turns out to be diagnostic is not known in advance), in feed order, as
 *  canonical JSON, gzipped. The sealed digest is sha256 over the DECOMPRESSED canonical bytes, never over the gzip
 *  stream, whose header bytes vary by platform — so `gunzip | sha256sum` reproduces it anywhere. */
export const FILLS_DIR = "tests/q3/fills";
export const fillsPath = (id: string) => `${FILLS_DIR}/${id}.json.gz`;
export const fillsDigest = (fills: KalshiFill[]) => sha256hex(canonical(fills));
export const encodeFills = (fills: KalshiFill[]) => gzipSync(Buffer.from(canonical(fills), "utf8"));
export function decodeFills(buf: Buffer): { fills: KalshiFill[]; sha256: string } {
  const raw = gunzipSync(buf); return { fills: JSON.parse(raw.toString("utf8")) as KalshiFill[], sha256: sha256hex(raw) };
}
/** volume_total exactly as kalshiVolumes computes it: Σ count over fills strictly before `endTs` with a readable size. */
export function sumFillsBefore(fills: KalshiFill[], endTs: number): number {
  let v = 0; for (const f of fills) { const ts = Math.floor(new Date(f.created_time).getTime() / 1000); if (!(ts < endTs)) continue; const q = qty(f); if (q > 0) v += q; } return v;
}
/** Fill-level difference between a stored list and a re-fetch, both restricted to fills before `endTs`. */
export function diffFills(stored: KalshiFill[], refetched: KalshiFill[], endTs: number) {
  const before = (fs: KalshiFill[]) => new Map(fs.filter(f => Math.floor(new Date(f.created_time).getTime() / 1000) < endTs).map(f => [f.trade_id, f] as const));
  const a = before(stored), b = before(refetched); let missing = 0, missingQty = 0, added = 0, addedQty = 0, resized = 0, resizedQty = 0;
  for (const [id, f] of a) { const g = b.get(id); if (!g) { missing++; missingQty += qty(f); } else if (qty(g) !== qty(f)) { resized++; resizedQty += qty(g) - qty(f); } }
  for (const [id, g] of b) if (!a.has(id)) { added++; addedQty += qty(g); }
  return { missing, missingQty, added, addedQty, resized, resizedQty };
}
