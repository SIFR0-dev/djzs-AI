/**
 * Resolve a bound venue market to the identifiers Phase A and Phase B need — read-only, no key, writes nothing.
 *
 * Phase A validates a Polymarket record by SLUG (`/markets?slug=`) and Phase B prices it by the audited outcome's
 * TOKEN ID, while the §3 pool ranks on `conditionId`. Three identifier spaces for one market, and getting them by
 * hand is exactly the kind of transcription a sealed, hashed record should never rest on. Committed per SCAN_SPEC
 * §10.3 (ruled 2026-09-14): read-only inspection gets the same treatment as a write, because a tool nobody can
 * test is not a verification tool.
 *
 *   npx tsx tests/q3/tape/market-ids.ts --polymarket-condition 0xa3b36b2d…,0x876506d8…
 *   npx tsx tests/q3/tape/market-ids.ts --polymarket-event fed-decision-in-september-762
 *   npx tsx tests/q3/tape/market-ids.ts --kalshi KXFEDDECISION-26SEP-H0,KXFEDDECISION-26SEP-H25
 *
 * Every lookup THROWS on a non-OK response rather than reporting an empty result: "not found" and "the venue was
 * unreachable" are different facts, and only one of them means the ticker is wrong.
 */
const args = process.argv.slice(2);
const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const G = "https://gamma-api.polymarket.com";
const K = "https://api.elections.kalshi.com/trade-api/v2";
async function getJson(url: string): Promise<any> { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`); return r.json(); }

/** Gamma returns clobTokenIds and outcomes as JSON-encoded STRINGS on some routes and as arrays on others.
 *  Normalise rather than assume: a silently-wrong token id would price the wrong side of the market. */
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
}
function printPoly(m: any) {
  const toks = arr(m.clobTokenIds), outs = arr(m.outcomes);
  const yesIdx = outs.findIndex(o => o.toLowerCase() === "yes");
  console.log(`  slug            ${m.slug}`);
  console.log(`  conditionId     ${m.conditionId}`);
  console.log(`  question        ${m.question}`);
  console.log(`  endDate         ${m.endDate}`);
  console.log(`  outcomes        ${outs.join(" / ") || "(none published)"}`);
  // Name the index the id came from. "token_id_yes" that silently fell back to element 0 is the failure this avoids.
  console.log(`  token_id YES    ${yesIdx >= 0 ? toks[yesIdx] : "(UNRESOLVED — no outcome labelled YES; do NOT guess)"}${yesIdx >= 0 ? `   [outcomes[${yesIdx}]]` : ""}`);
  console.log(`  token_id NO     ${yesIdx >= 0 ? (toks[1 - yesIdx] ?? "(missing)") : "(unresolved)"}`);
  console.log(`  volume24hr      ${m.volume24hr ?? "?"}`);
  console.log("");
}

(async () => {
  const conds = flag("--polymarket-condition"), ev = flag("--polymarket-event"), kal = flag("--kalshi");
  if (ev) {
    const evs = await getJson(`${G}/events?slug=${encodeURIComponent(ev)}`) as any[];
    if (!evs.length) throw new Error(`polymarket event slug ${ev} not found`);
    console.log(`POLYMARKET EVENT ${evs[0].slug} · ${evs[0].title} · ${(evs[0].markets ?? []).length} market(s)\n`);
    for (const m of evs[0].markets ?? []) printPoly(m);
  }
  if (conds) {
    for (const c of conds.split(",").map(x => x.trim()).filter(Boolean)) {
      const ms = await getJson(`${G}/markets?condition_ids=${encodeURIComponent(c)}`) as any[];
      if (!ms.length) { console.log(`POLYMARKET ${c}: NOT FOUND at the venue\n`); continue; }
      console.log(`POLYMARKET ${c.slice(0, 14)}…`); printPoly(ms[0]);
    }
  }
  if (kal) {
    for (const t of kal.split(",").map(x => x.trim()).filter(Boolean)) {
      const j = await getJson(`${K}/markets/${encodeURIComponent(t)}`);
      const m = j.market ?? j;
      console.log(`KALSHI ${m.ticker}`);
      console.log(`  event_ticker    ${m.event_ticker}`);
      console.log(`  title           ${m.title ?? m.yes_sub_title ?? ""}`);
      console.log(`  close_time      ${m.close_time}`);
      console.log(`  expiration      ${m.expiration_time ?? "—"}`);
      console.log(`  status          ${m.status} · type ${m.market_type} · notional ${m.notional_value_dollars ?? "?"}`);
      console.log(`  last / vol24h   ${m.last_price ?? "?"} / ${m.volume_24h ?? "?"}\n`);
    }
  }
  if (!conds && !ev && !kal) { console.error("usage: --polymarket-condition <id,…> | --polymarket-event <slug> | --kalshi <ticker,…>"); process.exit(1); }
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
