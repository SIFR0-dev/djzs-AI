// tests/q3/tape/trending.ts
// DJZS Daily Narrative Scan — trending narrative sourcing (origin: `trend`).
//
// Pulls the 24h-volume leaders from Polymarket (Gamma) and Kalshi (trade-api v2),
// drops the buckets the engine cannot audit (sports, esports, weather, price bins,
// count/mention markets), ranks what remains, and writes a dated, hashed candidate
// file for the scan instance. Read-only. No keys. No dependencies beyond Node 22.
//
// Distinct from discover.ts: `pool` = top-N NEW markets per venue (Q3 covariate).
// `trend` = what the venues are trading TODAY, for distribution. Do not merge them.
//
// Run:   node --experimental-strip-types tests/q3/tape/trending.ts [--top 10] [--kalshi-pages 40] [--anchors KXFEDDECISION,KXCPICOMBO] [--out tests/q3/tape/trending]
// Exit:  0 ok · 2 partial (one venue failed, the other written) · 1 both failed

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── policy (versioned; change = bump TREND_RULE_VERSION) ─────────────────────
export const TREND_RULE_VERSION = "DJZS-TREND-v1.0";

// Polymarket tag labels that mark a non-narrative event. Case-insensitive.
const POLY_EXCLUDE_TAGS = new Set(
  [
    "sports", "esports", "games", "weather", "daily temperature",
    "multi strikes", "hit price", "crypto prices",           // price bins
    "tweet markets", "recurring",                            // count markets / rolling bins
    "hide from new",                                         // venue's own noise flag
  ].map((s) => s.toLowerCase()),
);

// Kalshi categories the engine can read a story in.
const KALSHI_INCLUDE_CATEGORIES = new Set([
  "Economics", "Politics", "Elections", "Crypto", "Commodities",
  "Financials", "Science and Technology", "World", "Companies",
]);

// Kalshi series pulled directly every run regardless of paging depth (the calendar anchors).
// The events listing is not volume-ordered, so a page cap can miss today's FOMC/CPI event.
const KALSHI_ANCHOR_SERIES = ["KXFEDDECISION", "KXCPICOMBO"];

// Kalshi series that are numbers, not stories, even inside an included category.
const KALSHI_EXCLUDE_SERIES = /^KX(BTC|ETH|XRP|SOL|DOGE)D$|^KXAAAGAS|^KXDIESEL|^KXNASDAQ100U|^KXINXU|MENTION$|^KXHIGH|^KXRAIN|^KXWTI$|^KXWTIW$/;

// ── types ────────────────────────────────────────────────────────────────────
export type TrendRow = {
  venue: "polymarket" | "kalshi";
  id: string;              // event slug (poly) / event_ticker (kalshi)
  title: string;
  url: string;
  category: string;        // poly: first non-excluded tag · kalshi: category
  vol24h: number;          // USD (poly) · contracts≈USD (kalshi, volume_24h_fp)
  volTotal: number;
  endDate: string | null;  // ISO date
  impliedProb: number | null; // yes price of the highest-24h-volume market in the event
  marketTicker: string | null;
};

type Venue = { rows: TrendRow[]; scanned: number; kept: number; pages: number; error: string | null };

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function getJson(url: string, attempts = 4): Promise<any> {
  let wait = 1500;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: { "user-agent": "djzs-trend/1.0 (+https://djzs.ai)", accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) { await sleep(wait); wait *= 2; continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`gave up after ${attempts} attempts: ${url}`);
}

// ── Polymarket ───────────────────────────────────────────────────────────────
async function polymarket(top: number): Promise<Venue> {
  const out: Venue = { rows: [], scanned: 0, kept: 0, pages: 1, error: null };
  try {
    const url = "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100";
    const events: any[] = await getJson(url);
    out.scanned = events.length;
    for (const e of events) {
      const tags: string[] = (e.tags ?? []).map((t: any) => String(t.label ?? "").toLowerCase());
      if (tags.some((t) => POLY_EXCLUDE_TAGS.has(t))) continue;
      const markets: any[] = e.markets ?? [];
      const lead = markets.slice().sort((a, b) => num(b.volume24hr) - num(a.volume24hr))[0];
      let implied: number | null = null;
      if (lead?.outcomePrices) {
        try { const p = JSON.parse(lead.outcomePrices); implied = p?.[0] != null ? Number(p[0]) : null; } catch { /* leave null */ }
      }
      out.rows.push({
        venue: "polymarket",
        id: String(e.slug ?? e.id),
        title: String(e.title ?? ""),
        url: `https://polymarket.com/event/${e.slug}`,
        category: (e.tags ?? []).map((t: any) => String(t.label ?? "")).find((l: string) => !POLY_EXCLUDE_TAGS.has(l.toLowerCase())) ?? "uncategorized",
        vol24h: num(e.volume24hr),
        volTotal: num(e.volume),
        endDate: e.endDate ? String(e.endDate).slice(0, 10) : null,
        impliedProb: implied,
        marketTicker: lead?.slug ? String(lead.slug) : null,
      });
    }
    out.kept = out.rows.length;
    out.rows.sort((a, b) => b.vol24h - a.vol24h || a.id.localeCompare(b.id));
    out.rows = out.rows.slice(0, top);
  } catch (err) { out.error = String(err) + ((err as any)?.cause ? " cause=" + String((err as any).cause?.code ?? (err as any).cause) : ""); }
  return out;
}

// ── Kalshi ───────────────────────────────────────────────────────────────────
async function kalshi(top: number, maxPages: number, anchors: string[]): Promise<Venue> {
  const out: Venue = { rows: [], scanned: 0, kept: 0, pages: 0, error: null };
  const base = "https://api.elections.kalshi.com/trade-api/v2/events";
  const seen = new Set<string>();
  const pages: any[][] = [];
  let cursor: string | undefined;
  try {
    for (const s of anchors) {                       // calendar anchors first — never subject to the page cap
      const q = new URLSearchParams({ status: "open", with_nested_markets: "true", limit: "200", series_ticker: s });
      pages.push((await getJson(`${base}?${q}`)).events ?? []);
      await sleep(1100);
    }
    for (let p = 0; p < maxPages; p++) {
      const q = new URLSearchParams({ status: "open", with_nested_markets: "true", limit: "200", mve_filter: "exclude" });
      if (cursor) q.set("cursor", cursor);
      const r = await getJson(`${base}?${q}`);
      out.pages++;
      pages.push(r.events ?? []);
      cursor = r.cursor;
      if (!cursor) break;
      await sleep(1100); // venue 429s above ~1 req/s
    }
    for (const events of pages) {
      out.scanned += events.length;
      for (const e of events) {
        const cat = String(e.category ?? "");
        const series = String(e.series_ticker ?? "");
        if (seen.has(String(e.event_ticker))) continue;
        seen.add(String(e.event_ticker));
        if (!KALSHI_INCLUDE_CATEGORIES.has(cat)) continue;
        if (KALSHI_EXCLUDE_SERIES.test(series)) continue;
        const markets: any[] = e.markets ?? [];
        const vol24 = markets.reduce((s, m) => s + num(m.volume_24h_fp), 0);
        if (vol24 <= 0) continue;
        const volTot = markets.reduce((s, m) => s + num(m.volume_fp), 0);
        const lead = markets.slice().sort((a, b) => num(b.volume_24h_fp) - num(a.volume_24h_fp))[0];
        const close = markets.map((m) => m.expected_expiration_time ?? m.close_time).filter(Boolean).sort()[0];
        out.rows.push({
          venue: "kalshi",
          id: String(e.event_ticker),
          title: [e.title, e.sub_title].filter(Boolean).join(" — "),
          url: `https://kalshi.com/markets/${series.toLowerCase()}/${String(e.event_ticker).toLowerCase()}`,
          category: cat,
          vol24h: vol24,
          volTotal: volTot,
          endDate: close ? String(close).slice(0, 10) : null,
          impliedProb: lead?.last_price_dollars != null ? Number(lead.last_price_dollars) : null,
          marketTicker: lead?.ticker ? String(lead.ticker) : null,
        });
      }
    }
    out.kept = out.rows.length;
    out.rows.sort((a, b) => b.vol24h - a.vol24h || a.id.localeCompare(b.id));
    out.rows = out.rows.slice(0, top);
  } catch (err) { out.error = String(err) + ((err as any)?.cause ? " cause=" + String((err as any).cause?.code ?? (err as any).cause) : ""); }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const top = Number(arg("top", "10"));
  const kalshiPages = Number(arg("kalshi-pages", "40"));
  const outDir = arg("out", "tests/q3/tape/trending");
  const anchors = arg("anchors", KALSHI_ANCHOR_SERIES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const pulledAt = new Date().toISOString();
  const day = pulledAt.slice(0, 10);

  const [pm, ks] = await Promise.all([polymarket(top), kalshi(top, kalshiPages, anchors)]);

  const payload = {
    rule_version: TREND_RULE_VERSION,
    origin: "trend",
    kalshi_anchor_series: anchors,
    pulled_at: pulledAt,
    venues: {
      polymarket: { scanned: pm.scanned, kept: pm.kept, error: pm.error, rows: pm.rows },
      kalshi: { scanned: ks.scanned, kept: ks.kept, pages: ks.pages, partial: ks.pages >= kalshiPages, error: ks.error, rows: ks.rows },
    },
  };
  const body = canonical(payload);
  const hash = sha256(body);

  if (pm.error && ks.error) { console.error("both venues failed; no file written"); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${day}.json`);
  writeFileSync(file, body + "\n");

  // reader-facing table
  const fmt = (r: TrendRow) =>
    `| ${r.venue.padEnd(10)} | ${r.category.padEnd(14).slice(0, 14)} | ${(r.vol24h / 1e6).toFixed(2).padStart(6)}M | ${r.impliedProb == null ? "  —  " : (r.impliedProb * 100).toFixed(0).padStart(4) + "%"} | ${r.endDate ?? "—"} | ${r.title.slice(0, 70)} |`;
  console.log(`// DJZS TREND · ${day} · ${TREND_RULE_VERSION}`);
  console.log(`| venue      | category       | 24h vol | yes  | ends       | narrative |`);
  console.log(`|------------|----------------|---------|------|------------|-----------|`);
  for (const r of [...pm.rows, ...ks.rows]) console.log(fmt(r));
  console.log(`// polymarket scanned=${pm.scanned} kept=${pm.kept}${pm.error ? " ERROR=" + pm.error : ""}`);
  console.log(`// kalshi     scanned=${ks.scanned} kept=${ks.kept} pages=${ks.pages}${ks.pages >= kalshiPages ? " (partial: page cap hit)" : ""}${ks.error ? " ERROR=" + ks.error : ""}`);
  console.log(`// file=${file} sha256=${hash}`);

  if (pm.error && ks.error) process.exit(1);
  if (pm.error || ks.error) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
