/** Use 3 — systematic narrative discovery + the macro-chain denominator. Writes tests/q3/discovery/YYYY-MM-DD.json and appends PENDING rows to tests/q3/macro-chain-log.json.
 *  §3 COVERAGE POOL (protocol v1.5 rules 1–2): top-5 by 24h volume WITHIN the scan's categories, per venue. Two reads:
 *   - VENUE-DIRECT (record-bearing for Kalshi; 0 credits; runs anywhere, no CLI): Kalshi public API ranked on event.category,
 *     Polymarket Gamma API ranked on event tags. The exact venue labels are the constants below — rule 2 says they are committed here.
 *     The Polymarket pool that ENTERS a record is the public Dune query (dune.json pool_query_id), which matches the SAME labels on
 *     polymarket_polygon.market_details.tags; the Gamma read is the day's candidate print and its confirmation is the Dune re-run.
 *   - SURF (tape only, local seat with the CLI, 4 credits per platform×category): CFG.pool_categories on Surf's enum.
 *  Venue-direct always runs; Surf runs when the CLI is on PATH unless --venue-direct is given. Ranking metric, disclosed: Kalshi 24h
 *  volume is CONTRACTS (volume_24h_fp); Polymarket 24h volume is Gamma's USD volume24hr (Dune's single-counted taker volume decides the record). */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { surf, surfAvailable, CFG, journalCredits } from "./surf";

/** KALSHI — exact `event.category` strings (one per event; markets inherit it). Verified live 2026-09-09 (KXFED/KXCPI → Economics,
 *  KXINX → Financials, KXBTCD/KXETHD → Crypto). Financials (index contracts) admitted per tape/config.json + index-bind precedent. */
export const KALSHI_POOL_CATEGORIES = ["Economics", "Financials", "Crypto", "Politics", "Elections", "World"];
/** Open-event categories observed the same day and NOT in the pool (recorded so the exclusion is inspectable, v1.5 rule 1):
 *  Sports · Entertainment · Climate and Weather · Companies · Science and Technology · Mentions · Health · Social · AI · Transportation · Business */
/** POLYMARKET — Gamma event tag labels (several per market), matched as whole words, case-insensitive, on the joined tag string —
 *  the SAME regexes as tests/q3/queries/polymarket_pool.sql so the venue read and the Dune query classify identically. Exclude wins. */
export const POLYMARKET_POOL_TAGS = { include: ["Politics", "Elections", "Geopolitics", "World", "Economy", "Fed", "Finance", "Crypto"], exclude: ["Sports", "Esports", "Culture", "entertainment", "Weather"] };
const wordRe = (labels: string[]) => new RegExp(`(^|[^a-z0-9])(${labels.map(l => l.toLowerCase()).join("|")})([^a-z0-9]|$)`);
export const POLYMARKET_INCLUDE_RE = wordRe(POLYMARKET_POOL_TAGS.include), POLYMARKET_EXCLUDE_RE = wordRe(POLYMARKET_POOL_TAGS.exclude);
export const polymarketInCategory = (tags: string) => POLYMARKET_INCLUDE_RE.test(tags.toLowerCase()) && !POLYMARKET_EXCLUDE_RE.test(tags.toLowerCase());

const today = new Date().toISOString().slice(0, 10); const args = process.argv.slice(2);
const platforms = args.includes("--kalshi-only") ? ["kalshi"] : args.includes("--polymarket-only") ? ["polymarket"] : ["kalshi", "polymarket"];
const useSurf = !args.includes("--venue-direct") && surfAvailable();
const N = 5;
/** Markets already in the book (§3 excludes them from the pool): Kalshi tickers, Polymarket condition ids. */
function bookExclusions(): { kalshi: Set<string>; polymarket: Set<string> } {
  const k = new Set<string>(), p = new Set<string>(); const dir = "tests/q3/records"; if (!existsSync(dir)) return { kalshi: k, polymarket: p };
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) { const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); for (const r of Array.isArray(j) ? j : j.records ?? [j]) { const m = r.market ?? {}; if (m.venue === "kalshi" && m.ticker) k.add(String(m.ticker).toUpperCase()); if (m.venue === "polymarket") for (const id of [m.condition_id, m.ticker]) if (id) p.add(String(id).toLowerCase()); } }
  return { kalshi: k, polymarket: p };
}
async function getJson(url: string): Promise<any> { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`); return r.json(); }
/** Kalshi venue-direct pool: every open event (paginated), category ∈ KALSHI_POOL_CATEGORIES, active binary markets only (no multivariate
 *  combos/parlays — mve_collection_ticker), ranked by volume_24h_fp (contracts). Book exclusion matches the market ticker OR the event
 *  ticker: a book ticker written at event level (the pilot N5 carries KXFEDDECISION-26SEP) excludes every market of that event — refuses more, never less. */
async function kalshiPool(exclude: Set<string>) {
  const rows: any[] = []; const dropped: string[] = []; let cursor = ""; let events = 0;
  for (let page = 0; page < 100; page++) {
    const j = await getJson(`https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const e of j.events ?? []) { events++; if (!KALSHI_POOL_CATEGORIES.includes(e.category)) continue;
      for (const m of e.markets ?? []) { if (m.status !== "active" || m.mve_collection_ticker || (m.market_type && m.market_type !== "binary")) continue;
        if (exclude.has(String(m.ticker).toUpperCase()) || exclude.has(String(e.event_ticker).toUpperCase())) { dropped.push(m.ticker); continue; }
        rows.push({ id: m.ticker, category: e.category, event: e.event_ticker, question: m.title, volume_1d: Number(m.volume_24h_fp ?? m.volume_24h ?? 0), volume_unit: "contracts", price: m.last_price_dollars != null ? Number(m.last_price_dollars) : null, close_time: m.close_time, link: `https://kalshi.com/markets/${String(e.series_ticker ?? "").toLowerCase()}/${String(e.event_ticker).toLowerCase()}` }); } }
    cursor = j.cursor; if (!cursor) break;
  }
  return { rows: rows.sort((x, y) => y.volume_1d - x.volume_1d), events_scanned: events, dropped_by_book: dropped };
}
/** Polymarket venue-direct pool: Gamma events by 24h volume (paginated), tags in-category by the shared regexes, active open markets ranked by volume24hr. */
async function polymarketPool(exclude: Set<string>) {
  const rows: any[] = []; const dropped: string[] = []; let events = 0;
  for (let offset = 0; offset < 1000; offset += 100) {
    const evs = await getJson(`https://gamma-api.polymarket.com/events?order=volume24hr&ascending=false&closed=false&active=true&limit=100&offset=${offset}`);
    if (!Array.isArray(evs) || !evs.length) break;
    for (const e of evs) { events++; const tags = (e.tags ?? []).map((t: any) => t.label); if (!polymarketInCategory(tags.join(","))) continue;
      for (const m of e.markets ?? []) { const cid = String(m.conditionId ?? "").toLowerCase(); if (!m.active || m.closed || !cid) continue; if (exclude.has(cid)) { dropped.push(cid); continue; }
        let p: number | null = null; try { p = Number(JSON.parse(m.outcomePrices ?? "[]")[0]); } catch {}
        rows.push({ id: cid, category: tags.join(", "), event: e.slug, question: m.question, volume_1d: Number(m.volume24hr ?? 0), volume_unit: "usd (gamma; dune single-counted decides)", price: Number.isFinite(p) ? p : null, end_date: m.endDate, link: `https://polymarket.com/event/${e.slug}` }); } }
    if (evs.length < 100) break;
  }
  return { rows: rows.sort((x, y) => y.volume_1d - x.volume_1d), events_scanned: events, dropped_by_book: dropped };
}
(async () => {
  const out: any = { date: today, protocol: "v1.5", pool: {}, pool_candidates: {}, news: [], macro_chain_hits: [] };
  const ex = bookExclusions();
  for (const p of platforms) { try { const r = p === "kalshi" ? await kalshiPool(ex.kalshi) : await polymarketPool(ex.polymarket);
      out.pool[p] = { source: "venue-direct", labels: p === "kalshi" ? { field: "event.category", include: KALSHI_POOL_CATEGORIES } : { field: "event.tags[].label", ...POLYMARKET_POOL_TAGS }, excluded_from_book: [...(p === "kalshi" ? ex.kalshi : ex.polymarket)], events_scanned: r.events_scanned, dropped_by_book: r.dropped_by_book, in_category_markets: r.rows.length, top: r.rows.slice(0, N), next: r.rows.slice(N, N + 5) };
    } catch (e) { out.pool[p] = { source: "venue-direct", error: (e as Error).message.slice(0, 200) }; } }
  if (useSurf) {
    for (const p of platforms) { const seen = new Set<string>(); const rows: any[] = [];
      for (const cat of CFG.pool_categories) { try { const r = surf("search-prediction-market", ["--platform", p, "--category", cat, "--status", "active", "--sort-by", "volume_1d", "--limit", "5"]);
          for (const m of r.data) { const id = m.market_ticker ?? m.condition_id; if (seen.has(id)) continue; seen.add(id); rows.push({ id, category: m.category, question: m.question, volume_1d: m.volume_1d_usd ?? m.volume_1d ?? null, volume_7d: m.volume_7d_usd ?? m.volume_7d ?? null, oi: m.open_interest_usd, price: m.latest_price ?? null, days_to_resolution: m.days_to_resolution, link: m.market_link }); }
        } catch (e) { rows.push({ category: cat, error: (e as Error).message.slice(0, 120) }); } }
      out.pool_candidates[p] = rows.filter(r => !r.error).sort((x, y) => (y.volume_1d ?? y.volume_7d ?? 0) - (x.volume_1d ?? x.volume_7d ?? 0)).slice(0, 10); out.pool_candidates[p + "_errors"] = rows.filter(r => r.error); }
    for (const q of CFG.macro_chain_queries) { try { const r = surf("search-news", ["--q", q, "--limit", "5"]); for (const n of r.data) { const pub = new Date(n.published_at * 1000).toISOString(); if (Date.now() - n.published_at * 1000 > 2 * 86400e3) continue; out.news.push({ q, title: n.title, url: n.url, source: n.source, published_at: pub, summary: n.summary?.slice(0, 200) }); if (/bitcoin|crypto|btc/i.test(n.title + " " + (n.summary ?? ""))) out.macro_chain_hits.push({ found: today, q, title: n.title, url: n.url, published_at: pub, outcome: "PENDING — operator marks HELD | BROKE | PARTIAL at horizon" }); } } catch (e) { out.news.push({ q, error: (e as Error).message.slice(0, 120) }); } }
  } else out.tape = "surf not run (CLI absent or --venue-direct): no Surf candidates, no news, no macro-chain scan";
  mkdirSync("tests/q3/discovery", { recursive: true }); writeFileSync(`tests/q3/discovery/${today}.json`, JSON.stringify(out, null, 2) + "\n");
  if (useSurf) { const mcl = "tests/q3/macro-chain-log.json"; const log = existsSync(mcl) ? JSON.parse(readFileSync(mcl, "utf8")) : { _comment: "Every macro→crypto chain narrative found, BOTH outcomes — the denominator for the class base rate. Operator fills outcome at horizon.", instances: [] };
    const known = new Set(log.instances.map((i: any) => i.url)); for (const h of out.macro_chain_hits) if (!known.has(h.url)) log.instances.push(h); writeFileSync(mcl, JSON.stringify(log, null, 2) + "\n"); }
  for (const p of platforms) { const pool = out.pool[p]; const lab = p === "kalshi" ? `event.category ∈ {${KALSHI_POOL_CATEGORIES.join(", ")}}` : `tags ∋ {${POLYMARKET_POOL_TAGS.include.join(", ")}} ∖ {${POLYMARKET_POOL_TAGS.exclude.join(", ")}}`;
    console.log(`POOL · ${p} · venue-direct · v1.5 rule 1 · ${lab}`); if (pool.error) { console.log(`  error: ${pool.error}`); continue; }
    console.log(`  ${pool.events_scanned} open events scanned · ${pool.in_category_markets} in-category markets · book exclusions ${pool.excluded_from_book.length} (dropped ${pool.dropped_by_book.length}: ${pool.dropped_by_book.slice(0, 4).join(", ") || "none"}) · 24h volume in ${p === "kalshi" ? "contracts" : "USD (gamma)"}`);
    pool.top.forEach((r: any, i: number) => console.log(`  ${i + 1}. ${String(r.id).padEnd(44)} ${String(r.category).slice(0, 22).padEnd(22)} vol24h ${String(Math.round(r.volume_1d)).padStart(9)}  p ${r.price ?? "?"}  ${r.question?.slice(0, 70)}`)); }
  if (useSurf) { for (const p of platforms) { console.log(`SURF CANDIDATES · ${p} (tape · Surf enum: ${CFG.pool_categories.join(", ")})`); for (const r of out.pool_candidates[p].slice(0, 5)) console.log(`  ${String(r.id).padEnd(34)} ${String(r.category).padEnd(10)} vol1d ${r.volume_1d ?? "?"}  oi ${Math.round(r.oi ?? 0)}  p ${r.price ?? "?"}  ${r.question?.slice(0, 60)}`); if (out.pool_candidates[p + "_errors"].length) console.log(`  errors: ${out.pool_candidates[p + "_errors"].map((e: any) => e.category + ": " + e.error).join(" | ")}`); }
    const used = journalCredits("discover", `${platforms.join("+")} · ${out.news.length} news · ${out.macro_chain_hits.length} chain hits`);
    console.log(`NEWS (48h) ${out.news.length} · MACRO-CHAIN HITS ${out.macro_chain_hits.length} → macro-chain-log.json · credits today ${used}/${CFG.credit_ceiling_per_day}`); }
  else console.log(`TAPE: ${out.tape}`);
  console.log(`→ tests/q3/discovery/${today}.json`);
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
