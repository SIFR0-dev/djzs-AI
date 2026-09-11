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
import { POOL_TAGS_INCLUDE, POOL_TAGS_EXCLUDE, POOL_TAGS_EXCLUDE_CATEGORY, POOL_TAGS_EXCLUDE_RECURRENCE, POOL_MIN_HOURS_TO_CLOSE, poolCategoryAdmit, poolDurationAdmit, hoursToClose } from "../lib";

/** KALSHI — exact `event.category` strings (one per event; markets inherit it). Verified live 2026-09-09 (KXFED/KXCPI → Economics,
 *  KXINX → Financials, KXBTCD/KXETHD → Crypto). Financials (index contracts) admitted per tape/config.json + index-bind precedent. */
export const KALSHI_POOL_CATEGORIES = ["Economics", "Financials", "Crypto", "Politics", "Elections", "World"];
/** Open-event categories observed the same day and NOT in the pool (recorded so the exclusion is inspectable, v1.5 rule 1):
 *  Sports · Entertainment · Climate and Weather · Companies · Science and Technology · Mentions · Health · Social · AI · Transportation · Business */
/** POLYMARKET — Gamma event tag labels (several per market). The vocabulary and the matcher live in tests/q3/lib.ts so
 *  this read, the Dune publish check and queries/polymarket_pool.sql share ONE definition. Matching is array
 *  containment on whole tags, case-normalized both sides — never substring, because v1.8 excludes the bare tags
 *  Up, Down and 1H. Exclusion wins over inclusion. */
export const POLYMARKET_POOL_TAGS = { include: POOL_TAGS_INCLUDE, exclude: POOL_TAGS_EXCLUDE };
/** v1.9 split the gate in two — see polymarketPool. This alias now names the CATEGORY half only, which is what the
 *  event-level gate actually applies; leaving it pointed at the whole-union matcher would have named a gate this file
 *  no longer runs in one piece. The duration half is poolDurationAdmit, applied per market. */
export const polymarketInCategory = poolCategoryAdmit;

const today = new Date().toISOString().slice(0, 10); const args = process.argv.slice(2);
const platforms = args.includes("--kalshi-only") ? ["kalshi"] : args.includes("--polymarket-only") ? ["polymarket"] : ["kalshi", "polymarket"];
const useSurf = !args.includes("--venue-direct") && surfAvailable();
const N = 5;
/** A Polymarket condition id as Dune query 8601185's `exclude` param accepts it; a Gamma market slug is NOT one. */
const POLY_CONDITION_ID = /^0x[0-9a-f]{64}$/;
/** Markets already in the book, excluded from the pool per §3 ("the top-N markets ... that have no existing record"),
 *  as narrowed by SCAN_SPEC §1.1 — two rules, both deliberate:
 *   (a) MARKET LEVEL ONLY. The ids compared are the record's own market ids — the Kalshi market ticker; for Polymarket the
 *       Gamma market slug in `market.ticker` and/or a `condition_id` alias. A record whose ticker names a parent EVENT
 *       excludes only a market of that exact id, never the event's other strikes. No event-level id is ever compared.
 *   (b) PRIMARY-ELIGIBLE SOURCES ONLY. A deviated record excludes nothing: it is out of the primary analysis (PROTOCOL §"Pilot
 *       records"), so the market it names has contributed nothing the pool would duplicate. The test is `deviated === true`,
 *       not bare truthiness: PROTOCOL §3 says "deviations require inclusion_note and set deviated: true", so a record that
 *       omits the field is a normal, primary-eligible record and DOES exclude.
 *  Returns the ids plus the provenance both ways — which record produced each exclusion, and which records were skipped and
 *  why — so the day's JSON shows the rule operating instead of asserting it. */
function bookExclusions(): { kalshi: Set<string>; polymarket: Set<string>; sources: any[]; skipped: any[]; warnings: string[] } {
  const kalshi = new Set<string>(), polymarket = new Set<string>(); const sources: any[] = [], skipped: any[] = [], warnings: string[] = [];
  const dir = "tests/q3/records"; if (!existsSync(dir)) return { kalshi, polymarket, sources, skipped, warnings };
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    for (const r of Array.isArray(j) ? j : j.records ?? [j]) {
      const m = r.market ?? {}; const id = r.id ?? f; const venue = m.venue ?? null; const dev = r.deviated;
      if (dev !== undefined && dev !== null && dev !== false) {
        // q3-verify.ts classifies with bare truthiness (`if (r.deviated)`); records are hand-authored, so a
        // `"true"` string must not read as primary-eligible here and deviated there. Non-boolean = deviated + a warning.
        if (typeof dev !== "boolean") warnings.push(`${id}: deviated is ${JSON.stringify(dev)}, not a boolean — treated as deviated (excludes nothing), matching q3-verify.ts; fix the record`);
        skipped.push({ record: id, venue, ticker: m.ticker ?? null, reason: "deviated — not primary-eligible, excludes nothing" }); continue;
      }
      const ticker = String(m.ticker ?? "").trim(), alias = String(m.condition_id ?? "").trim();
      if (venue === "kalshi" && ticker) { const key = ticker.toUpperCase(); kalshi.add(key); sources.push({ record: id, venue, excludes: [key] }); }
      else if (venue === "polymarket" && (ticker || alias)) {
        // market.ticker on a Polymarket record is a Gamma MARKET SLUG, optionally "polymarket:"-prefixed: q3-log.ts Phase A
        // and q3-grade.ts both resolve it with /markets?slug=, and PROTOCOL pre-registers ticker-resolves-at-the-venue.
        // The pool ranks on conditionId. Both are MARKET-level ids (never the event), so the set carries whichever the
        // record has and the reader compares both — otherwise a Polymarket record could never exclude its own market.
        const keys = [alias.toLowerCase(), ticker.replace(/^polymarket:/i, "").toLowerCase()].filter(Boolean);
        for (const k of keys) polymarket.add(k); sources.push({ record: id, venue, excludes: keys });
        if (!keys.some(k => POLY_CONDITION_ID.test(k))) warnings.push(`${id}: Polymarket record carries no 0x condition id (slug "${keys[keys.length - 1]}" only). The venue-direct read excludes it, but Dune query 8601185's exclude param takes condition ids — resolve the slug at gamma-api.polymarket.com/markets?slug=... before running the Dune confirmation, or that market will NOT be excluded there`);
      }
      else skipped.push({ record: id, venue, ticker: m.ticker ?? null, reason: ticker || alias ? `venue "${venue}" is not a pooled venue` : "no market ticker" });
    }
  }
  return { kalshi, polymarket, sources, skipped, warnings };
}
async function getJson(url: string): Promise<any> { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`); return r.json(); }
/** Kalshi venue-direct pool: every open event (paginated), category ∈ KALSHI_POOL_CATEGORIES, active binary markets only (no multivariate
 *  combos/parlays — mve_collection_ticker), ranked by volume_24h_fp (contracts). Book exclusion is MARKET LEVEL ONLY (SCAN_SPEC §1.1):
 *  the market's own ticker, never its parent event — a book ticker naming an event (the pilot N5 carries KXFEDDECISION-26SEP) drops no strike.
 *  v1.9: a market whose close_time is under 24h from THIS READ is excluded. Kalshi publishes categories, not tags, so
 *  v1.8's tag proxy could never reach its hourly and 15-minute ladders; the close time is the venue's own number and
 *  needs no proxy. A market publishing no usable close_time is admitted and COUNTED (no_close_time) rather than
 *  dropped or waved through silently — there is no tag set here to fall back to. */
async function kalshiPool(exclude: Set<string>) {
  const rows: any[] = []; const dropped: string[] = []; const shortDated: any[] = []; const noClose: string[] = []; let cursor = ""; let events = 0;
  const readAt = new Date().toISOString();
  for (let page = 0; page < 100; page++) {
    const j = await getJson(`https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const e of j.events ?? []) { events++; if (!KALSHI_POOL_CATEGORIES.includes(e.category)) continue;
      for (const m of e.markets ?? []) { if (m.status !== "active" || m.mve_collection_ticker || (m.market_type && m.market_type !== "binary")) continue;
        if (exclude.has(String(m.ticker).toUpperCase())) { dropped.push(m.ticker); continue; }
        const h = hoursToClose(m.close_time, readAt);
        if (h === null) noClose.push(m.ticker);
        else if (h < POOL_MIN_HOURS_TO_CLOSE) { shortDated.push({ id: m.ticker, close_time: m.close_time, hours_to_close: Number(h.toFixed(2)) }); continue; }
        rows.push({ id: m.ticker, category: e.category, event: e.event_ticker, event_key: e.event_ticker, question: m.title, volume_1d: Number(m.volume_24h_fp ?? m.volume_24h ?? 0), volume_unit: "contracts", price: m.last_price_dollars != null ? Number(m.last_price_dollars) : null, close_time: m.close_time, link: `https://kalshi.com/markets/${String(e.series_ticker ?? "").toLowerCase()}/${String(e.event_ticker).toLowerCase()}` }); } }
    cursor = j.cursor; if (!cursor) break;
  }
  return { rows: rows.sort((x, y) => y.volume_1d - x.volume_1d), events_scanned: events, dropped_by_book: dropped, read_at: readAt, dropped_by_duration: shortDated, no_close_time: noClose };
}
/** Polymarket venue-direct pool: Gamma events by 24h volume (paginated), tags in-category by the shared matcher, active open markets ranked by volume24hr.
 *  The gate is SPLIT because the two facts live at different levels: tags are on the EVENT, the close time is on each
 *  MARKET. So v1.5's categories are decided once per event (poolCategoryAdmit) and v1.9's duration per market
 *  (poolDurationAdmit), with the event's tags passed down as v1.8's fallback proxy for the markets that publish no
 *  endDate. Where a market publishes one it GOVERNS, so an event tagged 1H whose market closes in a week is admitted. */
async function polymarketPool(exclude: Set<string>) {
  const rows: any[] = []; const dropped: string[] = []; const shortDated: any[] = []; const noClose: string[] = []; let events = 0;
  const readAt = new Date().toISOString();
  for (let offset = 0; offset < 1000; offset += 100) {
    const evs = await getJson(`https://gamma-api.polymarket.com/events?order=volume24hr&ascending=false&closed=false&active=true&limit=100&offset=${offset}`);
    if (!Array.isArray(evs) || !evs.length) break;
    for (const e of evs) { events++; const tags = (e.tags ?? []).map((t: any) => t.label); if (!poolCategoryAdmit(tags)) continue;
      for (const m of e.markets ?? []) { const cid = String(m.conditionId ?? "").toLowerCase(); if (!m.active || m.closed || !cid) continue;
        const mslug = String(m.slug ?? "").trim().toLowerCase(); // the MARKET slug (e.slug is the event's — never compared)
        if (exclude.has(cid) || (mslug && exclude.has(mslug))) { dropped.push(cid); continue; }
        const h = hoursToClose(m.endDate, readAt);
        if (h === null) { if (!poolDurationAdmit(m.endDate, readAt, tags)) { shortDated.push({ id: cid, close_time: null, hours_to_close: null, by: "v1.8 tag proxy" }); continue; } noClose.push(cid); }
        else if (h < POOL_MIN_HOURS_TO_CLOSE) { shortDated.push({ id: cid, close_time: m.endDate, hours_to_close: Number(h.toFixed(2)), by: "close time" }); continue; }
        let p: number | null = null; try { p = Number(JSON.parse(m.outcomePrices ?? "[]")[0]); } catch {}
        rows.push({ id: cid, category: tags.join(", "), event: e.slug, event_key: e.slug, question: m.question, volume_1d: Number(m.volume24hr ?? 0), volume_unit: "usd (gamma; dune single-counted decides)", price: Number.isFinite(p) ? p : null, end_date: m.endDate, link: `https://polymarket.com/event/${e.slug}` }); } }
    if (evs.length < 100) break;
  }
  return { rows: rows.sort((x, y) => y.volume_1d - x.volume_1d), events_scanned: events, dropped_by_book: dropped, read_at: readAt, dropped_by_duration: shortDated, no_close_time: noClose, page_cap: 1000, capped: events >= 1000 };
}
(async () => {
  const out: any = { date: today, protocol: "v1.5", pool: {}, pool_candidates: {}, news: [], macro_chain_hits: [] };
  const ex = bookExclusions();
  out.book_exclusion = { rule: "market-level ids only, never an event; sources restricted to primary-eligible records (deviated absent or false) — SCAN_SPEC §1.1", sources: ex.sources, records_excluding_nothing: ex.skipped, warnings: ex.warnings };
  for (const p of platforms) { try { const r = p === "kalshi" ? await kalshiPool(ex.kalshi) : await polymarketPool(ex.polymarket);
      out.pool[p] = { source: "venue-direct", labels: p === "kalshi" ? { field: "event.category", include: KALSHI_POOL_CATEGORIES } : { field: "event.tags[].label", ...POLYMARKET_POOL_TAGS }, duration_rule: { amendment: "v1.9", min_hours_to_close: POOL_MIN_HOURS_TO_CLOSE, field: p === "kalshi" ? "market.close_time" : "market.endDate", fallback_proxy: p === "kalshi" ? null : "v1.8 recurrence tags, where no endDate is published; the close time governs where both exist", read_at: (r as any).read_at, dropped_by_duration: (r as any).dropped_by_duration, admitted_without_close_time: (r as any).no_close_time }, excluded_from_book: [...(p === "kalshi" ? ex.kalshi : ex.polymarket)], ...(p === "polymarket" ? { dune_exclude_condition_ids: [...ex.polymarket].filter(x => POLY_CONDITION_ID.test(x)), events_scanned_page_cap: (r as any).page_cap, events_scanned_hit_cap: (r as any).capped } : {}), exclusion_sources: ex.sources.filter((x: any) => x.venue === p), events_scanned: r.events_scanned, dropped_by_book: r.dropped_by_book, in_category_markets: r.rows.length, top: r.rows.slice(0, N), next: r.rows.slice(N, N + 5) };
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
  for (const p of platforms) { const pool = out.pool[p]; const lab = p === "kalshi" ? `event.category ∈ {${KALSHI_POOL_CATEGORIES.join(", ")}}` : `tags ∋ {${POLYMARKET_POOL_TAGS.include.join(", ")}} ∖ {${POOL_TAGS_EXCLUDE_CATEGORY.join(", ")}} [v1.5] · fallback ∖ {${POOL_TAGS_EXCLUDE_RECURRENCE.join(", ")}} [v1.8, only where no close time is published]`;
    console.log(`POOL · ${p} · venue-direct · v1.5 rule 1 + v1.9 duration · ${lab}`); if (pool.error) { console.log(`  error: ${pool.error}`); continue; }
    console.log(`  ${pool.events_scanned} open events scanned · ${pool.in_category_markets} in-category markets · 24h volume in ${p === "kalshi" ? "contracts" : "USD (gamma)"}`);
    console.log(`  book exclusions (market-level, primary-eligible sources only): ${pool.excluded_from_book.length} id(s)${pool.excluded_from_book.length ? " " + pool.excluded_from_book.slice(0, 4).join(", ") : ""} · dropped ${pool.dropped_by_book.length} market(s)${pool.dropped_by_book.length ? ": " + pool.dropped_by_book.slice(0, 4).join(", ") : ""}${pool.events_scanned_hit_cap ? ` · NOTE: events read is the top ${pool.events_scanned_page_cap} by 24h volume, a page cap, not the full open-event count` : ""}`);
    const d = pool.duration_rule; console.log(`  v1.9 duration (<${d.min_hours_to_close}h to ${d.field} at read): dropped ${d.dropped_by_duration.length} market(s)${d.dropped_by_duration.length ? ": " + d.dropped_by_duration.slice(0, 4).map((x: any) => `${x.id}@${x.hours_to_close ?? x.by}h`).join(", ") : ""}${d.admitted_without_close_time.length ? ` · ${d.admitted_without_close_time.length} admitted with NO published close time${d.fallback_proxy ? " and no recurrence tag" : ""}` : ""}`);
    pool.top.forEach((r: any, i: number) => console.log(`  ${i + 1}. ${String(r.id).padEnd(44)} ${String(r.category).slice(0, 22).padEnd(22)} vol24h ${String(Math.round(r.volume_1d)).padStart(9)}  p ${r.price ?? "?"}  ${r.question?.slice(0, 70)}`)); }
  console.log(`BOOK EXCLUSION · ${out.book_exclusion.rule}`);
  console.log(`  ${out.book_exclusion.sources.length} record(s) contributed an id${out.book_exclusion.sources.length ? ": " + out.book_exclusion.sources.map((x: any) => x.record + " → " + x.excludes.join("/")).join("; ") : ""} · ${out.book_exclusion.records_excluding_nothing.length} excluded nothing${out.book_exclusion.records_excluding_nothing.length ? " (" + out.book_exclusion.records_excluding_nothing.map((x: any) => x.record + ": " + x.reason.split(" — ")[0]).join("; ") + ")" : ""}`);
  for (const w of out.book_exclusion.warnings) console.log(`  WARN ${w}`);
  if (useSurf) { for (const p of platforms) { console.log(`SURF CANDIDATES · ${p} (tape · Surf enum: ${CFG.pool_categories.join(", ")})`); for (const r of out.pool_candidates[p].slice(0, 5)) console.log(`  ${String(r.id).padEnd(34)} ${String(r.category).padEnd(10)} vol1d ${r.volume_1d ?? "?"}  oi ${Math.round(r.oi ?? 0)}  p ${r.price ?? "?"}  ${r.question?.slice(0, 60)}`); if (out.pool_candidates[p + "_errors"].length) console.log(`  errors: ${out.pool_candidates[p + "_errors"].map((e: any) => e.category + ": " + e.error).join(" | ")}`); }
    const used = journalCredits("discover", `${platforms.join("+")} · ${out.news.length} news · ${out.macro_chain_hits.length} chain hits`);
    console.log(`NEWS (48h) ${out.news.length} · MACRO-CHAIN HITS ${out.macro_chain_hits.length} → macro-chain-log.json · credits today ${used}/${CFG.credit_ceiling_per_day}`); }
  else console.log(`TAPE: ${out.tape}`);
  console.log(`→ tests/q3/discovery/${today}.json`);
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
