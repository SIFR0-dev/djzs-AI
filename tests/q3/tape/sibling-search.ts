/**
 * §7.4 sibling search — series-targeted enumeration, never a corpus walk.
 *
 * SCAN_SPEC §7.4 requires that before an `event_key` is assigned, the venue's own metadata is searched for other
 * listings that resolve on the SAME real-world event, so a later pool day assigns them the same key rather than
 * minting a second key for an event already covered. Without it, v1.11's defect returns by a different route: one
 * venue's several listings on one event splitting into several clusters.
 *
 * Read-only, no key, writes nothing. It exists as a committed script rather than an ad-hoc query because SCAN_SPEC
 * §10.3 (ruled 2026-09-14) puts every network-touching command in the repo — read-only inspection included, since a
 * verification tool nobody can test is not a verification tool.
 *
 *   npx tsx tests/q3/tape/sibling-search.ts --kalshi-series KXBALANCEPOWERCOMBO,CONTROLH,CONTROLS
 *   npx tsx tests/q3/tape/sibling-search.ts --kalshi-search BALANCEPOWER,CONTROL
 *   npx tsx tests/q3/tape/sibling-search.ts --polymarket-tag "Clarity Act"
 *   npx tsx tests/q3/tape/sibling-search.ts --polymarket-q clarity
 *
 * METHODOLOGY NOTE (§7.4, recorded from a real failure): the Kalshi events endpoint returns HTTP 429 partway through
 * a full corpus walk, and a walk that swallows the error returns a partial corpus that looks complete — successive
 * walks returned 4,400 / 3,200 / 3,400 events, and on the truncated pass a series known to be open was simply
 * missing. So: every enumeration below is series-targeted, every page is fetched to exhaustion, and any non-OK
 * response THROWS rather than truncating. A run that cannot complete says so instead of printing a short answer.
 *
 * `--kalshi-search` is the one exception and is labelled as such in its own output: it walks the series index
 * (not the event corpus) to find candidate series by substring, purely to discover what to feed --kalshi-series.
 * Nothing it prints is a finding; the series-targeted enumeration is.
 */
const args = process.argv.slice(2);
const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const K = "https://api.elections.kalshi.com/trade-api/v2";
const G = "https://gamma-api.polymarket.com";

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  // Throw on any non-OK: a swallowed 429 is exactly how the corpus walk produced a partial answer that looked whole.
  if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`);
  return r.json();
}

/** Every open event of one Kalshi series, paged to exhaustion. Reports completion explicitly. */
async function kalshiSeriesEvents(series: string): Promise<any[]> {
  const out: any[] = []; let cursor = ""; let pages = 0;
  for (;;) {
    const j = await getJson(`${K}/events?series_ticker=${encodeURIComponent(series)}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(j.events ?? [])); pages++;
    cursor = j.cursor ?? ""; if (!cursor || !(j.events ?? []).length) break;
  }
  console.log(`  [enumeration complete] series ${series}: ${out.length} open event(s) over ${pages} page(s)`);
  return out;
}

(async () => {
  const ks = flag("--kalshi-series");
  if (ks) {
    for (const s of ks.split(",").map(x => x.trim()).filter(Boolean)) {
      let meta: any = null;
      try { meta = await getJson(`${K}/series/${encodeURIComponent(s)}`); } catch (e) { console.log(`SERIES ${s}: metadata unavailable (${(e as Error).message})`); }
      const title = meta?.series?.title ?? meta?.title ?? "—";
      const cat = meta?.series?.category ?? meta?.category ?? "—";
      console.log(`\nSERIES ${s} · ${title} · category ${cat}`);
      let evs: any[] = [];
      try { evs = await kalshiSeriesEvents(s); } catch (e) { console.log(`  ENUMERATION FAILED: ${(e as Error).message} — this series' answer is UNKNOWN, not empty`); continue; }
      for (const e of evs) {
        console.log(`  event ${e.event_ticker} · ${e.title ?? ""} · sub "${e.sub_title ?? ""}" · ${(e.markets ?? []).length} market(s)`);
        for (const m of e.markets ?? []) console.log(`      ${m.ticker} · close ${m.close_time} · vol24h ${m.volume_24h ?? m.volume_24h_fp ?? "?"} · ${m.title ?? m.yes_sub_title ?? ""}`);
      }
    }
  }

  const search = flag("--kalshi-search");
  if (search) {
    // SERIES index walk — a discovery aid only, NOT a finding. See the header note.
    const needles = search.split(",").map(x => x.trim().toUpperCase()).filter(Boolean);
    let cursor = ""; const hits: any[] = []; let seen = 0; let pages = 0;
    for (;;) {
      const j = await getJson(`${K}/series?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const list = j.series ?? []; seen += list.length; pages++;
      for (const s of list) if (needles.some(n => String(s.ticker ?? "").toUpperCase().includes(n))) hits.push(s);
      cursor = j.cursor ?? ""; if (!cursor || !list.length) break;
    }
    console.log(`\nSERIES INDEX SCAN (discovery aid, not a finding) · ${seen} series over ${pages} page(s) · needles ${needles.join(", ")}`);
    for (const s of hits) console.log(`  ${s.ticker} · ${s.title ?? ""} · category ${s.category ?? "—"}`);
    if (!hits.length) console.log("  (no series matched)");
  }

  const ptag = flag("--polymarket-tag"), pq = flag("--polymarket-q");
  if (ptag || pq) {
    // Gamma caps a page at 100 regardless of the limit asked for, and an unordered page of 100 open events is not
    // the corpus — reading "0 matches" off one such page would be the same mistake the Kalshi corpus walk made.
    // So: page explicitly, in the SAME volume order discover.ts uses, to a stated depth, and print the depth.
    const depth = Number(flag("--depth") ?? 1000);
    const needle = (ptag ?? pq!).toLowerCase();
    const seen = new Map<string, any>();
    let scanned = 0;
    for (let off = 0; off < depth; off += 100) {
      const url = ptag
        ? `${G}/events?closed=false&active=true&limit=100&offset=${off}&tag_slug=${encodeURIComponent(ptag)}`
        : `${G}/events?order=volume24hr&ascending=false&closed=false&active=true&limit=100&offset=${off}`;
      const page = await getJson(url) as any[];
      if (!page.length) break;
      scanned += page.length;
      for (const e of page) {
        const hit = String(e.title ?? "").toLowerCase().includes(needle)
          || String(e.slug ?? "").toLowerCase().includes(needle)
          || (e.tags ?? []).some((t: any) => String(t.label ?? t).toLowerCase().includes(needle) || String(t.slug ?? "").toLowerCase().includes(needle));
        if (hit) seen.set(e.slug ?? String(e.id), e);
      }
      if (page.length < 100) break;
    }
    console.log(`\nPOLYMARKET · ${ptag ? `tag_slug=${ptag}` : `open events by 24h volume, depth ${scanned}`} · matching "${ptag ?? pq}": ${seen.size} event(s)`);
    for (const e of seen.values()) {
      console.log(`  event ${e.slug} · ${e.title} · end ${e.endDate} · tags ${(e.tags ?? []).map((t: any) => t.label ?? t).join(", ")}`);
      for (const m of e.markets ?? []) console.log(`      ${m.slug} · cond ${m.conditionId} · vol24h ${m.volume24hr ?? "?"} · ${m.question}`);
    }
    if (!seen.size) console.log(`  (nothing matched in ${scanned} open event(s) scanned — a bounded scan, not the full corpus; say "not found in the top ${scanned} by volume", never "does not exist")`);
  }

  if (!ks && !search && !ptag && !pq) { console.error("usage: --kalshi-series A,B | --kalshi-search NEEDLE | --polymarket-tag <tag> | --polymarket-q <text>"); process.exit(1); }
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
