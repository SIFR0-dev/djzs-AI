/**
 * Q3 integrity check — runs in CI on every push and locally on demand. Exit 1 on any failure.
 *  1. every record: required fields present, enums valid, both hashes recompute from the file as committed
 *  2. every day with sealed records: Merkle root recomputed; if an anchor exists for that day it must match
 *  3. every anchor: Irys item fetched (following redirects); its merkle_root, date and record_count must match
 *  4. pilot/deviated records counted separately; a day with sealed records but no anchor is a WARNING (anchor may be pending)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { canonical, sha256hex, merkleRoot, strip, PHASE_A_EXCLUDE, PHASE_B_EXCLUDE } from "./lib";
import { runDuneQuery, asPriceRow, duneKey } from "./dune-client";
import { kalshiVwap, kalshiVolumes } from "./kalshi-client";
import { surf, surfAvailable, rows } from "./tape/surf";
const REC_DIR = "tests/q3/records", ANCHORS = "tests/q3/anchors.json";
const ORIGINS = new Set(["scan", "pool"]), BIND = new Set(["venue", "series", "unbound"]), VERD = new Set(["PASS", "WAIT", "FAIL", "OUT_OF_SCOPE"]), RESULT = new Set(["CORRECT", "INCORRECT", "VOID"]);
const REQ = ["id", "protocol_version", "posted_at", "origin", "scan_ref", "source", "market", "binding", "prescreen", "intent", "criterion", "engine", "intent_sha256", "phase_a_hash"];
const HEX = /^0x[0-9a-f]{64}$/;
let fails: string[] = [], warns: string[] = [], n = 0, sealed = 0, deviated = 0, graded = 0;
/** v1.10 + v1.11: every record carries BOTH event_key and venue_event_key. Gated on posted_at, NOT on key presence —
 *  the v1.7(a) trick of treating an absent key as "sealed before the amendment" cannot work for a rule that says EVERY
 *  record carries the field: a new record that simply forgot it would look pre-amendment and pass. Records posted
 *  before this instant are the three sealed, anchored, immutable ones, which cannot acquire either field without
 *  breaking their hashes and their anchor.
 *  The two fields are checked DIFFERENTLY, because v1.11 gives them different contracts:
 *    event_key        must be a NON-EMPTY STRING. Operator-assigned, venue-independent, the clustering key.
 *    venue_event_key  the KEY must be PRESENT; its VALUE may legitimately be null, which is what a venue that
 *                     publishes no event identifier looks like. Testing its value for truthiness would silently
 *                     accept a record that omitted the field entirely. */
const V110_FROM = Date.parse("2026-09-10T00:00:00Z");
const eventKeys = new Map<string, string[]>();
/** v1.7(a) volume re-check. Both windows end at posted_at over immutable trades, so re-execution reproduces them;
 *  the tolerance exists only for summation order, not for drift. Absence is never a failure: records sealed before
 *  v1.7 carry no volume, and sealed records are immutable. A recomputation that comes back null (a market_details
 *  row that has moved, an outage) WARNs rather than fails — the same outage-is-not-mismatch rule the price side uses. */
const volClose = (a: number, c: number) => Math.abs(a - c) <= Math.max(0.01, 1e-9 * Math.max(Math.abs(a), Math.abs(c)));
const priceChecks: { id: string; ps: any; price: number; posted_at: string; v24: number | null; vtot: number | null }[] = []; const kalshiChecks: { id: string; ps: any; price: number; posted_at: string; v24: number | null; vtot: number | null }[] = []; const tol = Number((JSON.parse(readFileSync("tests/q3/dune.json", "utf8")) as any).price_tolerance ?? 1e-9);
const anchors: any[] = existsSync(ANCHORS) ? JSON.parse(readFileSync(ANCHORS, "utf8")) : [];
if (!existsSync(REC_DIR)) { console.log("q3-verify: no records yet"); process.exit(0); }
for (const f of readdirSync(REC_DIR).filter(x => x.endsWith(".json")).sort()) {
  const date = f.replace(".json", ""); const recs = JSON.parse(readFileSync(`${REC_DIR}/${f}`, "utf8")) as Record<string, any>[];
  const ids = new Set<string>(); const dayHashes: string[] = [];
  for (const r of recs) {
    n++; const id = r.id ?? `${f}#${n}`;
    for (const k of REQ) if (!(k in r)) fails.push(`${id}: missing ${k}`);
    if (ids.has(r.id)) fails.push(`${id}: duplicate id in ${f}`); ids.add(r.id);
    if (String(r.posted_at).slice(0, 10) !== date) fails.push(`${id}: posted_at date ≠ file date`);
    if (!ORIGINS.has(r.origin)) fails.push(`${id}: origin ${r.origin}`);
    if (!BIND.has(r.binding?.type)) fails.push(`${id}: binding.type ${r.binding?.type}`);
    if (!VERD.has(r.engine?.verdict)) fails.push(`${id}: engine.verdict ${r.engine?.verdict}`);
    if (!VERD.has(r.prescreen?.verdict)) fails.push(`${id}: prescreen.verdict ${r.prescreen?.verdict}`);
    if (!HEX.test(r.phase_a_hash ?? "")) fails.push(`${id}: phase_a_hash format`);
    if (sha256hex(canonical(strip(r, PHASE_A_EXCLUDE))) !== r.phase_a_hash) fails.push(`${id}: phase_a_hash does not recompute`);
    // v1.10, checked on every record and not only sealed ones: the field is operator-authored at Phase A, so a record
    // can be wrong about it before it is ever sealed and that is the cheapest moment to say so.
    const rec = r as Record<string, unknown>;
    // SCAN_SPEC §10.2: draft-only, dropped at Phase A. Its presence in a record means a draft field was sealed.
    if ("draft_captured_at" in rec) fails.push(`${id}: carries draft_captured_at — that field is draft-only and must be dropped at Phase A, never sealed (SCAN_SPEC §10.2)`);
    if (Date.parse(String(r.posted_at)) >= V110_FROM) {
      const ek = rec.event_key;
      if (typeof ek !== "string" || !ek.trim()) fails.push(`${id}: v1.10/v1.11 require a non-empty operator-assigned event_key on every record posted after the amendment (got ${JSON.stringify(ek)})`);
      else eventKeys.set(ek, [...(eventKeys.get(ek) ?? []), id]);
      // v1.12: the no-public-case path. Checked on every record, not only sealed ones — these are operator-authored
      // at Phase A, so a record can be wrong before it is ever sealed and that is the cheapest moment to say so.
      const ts = rec.thesis_state, th = (rec.intent as Record<string, unknown> | undefined)?.thesis;
      if (ts !== undefined && ts !== null && ts !== "no_public_case") fails.push(`${id}: thesis_state must be "no_public_case" or absent — v1.12 defines no other value, so ${JSON.stringify(ts)} is a typo, not a new state`);
      if (ts === "no_public_case") {
        if (th !== null) fails.push(`${id}: thesis_state "no_public_case" requires intent.thesis null — v1.12 forbids a thesis written, paraphrased or reconstructed from the market's own question, price or structure`);
        if (rec.deviated === true) fails.push(`${id}: a no_public_case record is primary-eligible and is NEVER deviated (v1.12) — deviating it would drain exactly this class out of the primary`);
        const sr = rec.search_record as Record<string, unknown> | null | undefined;
        const w = sr && typeof sr === "object" ? sr.window as Record<string, unknown> | undefined : undefined;
        if (!sr || typeof sr !== "object") fails.push(`${id}: thesis_state "no_public_case" requires a search_record — v1.12 requires the absence be EVIDENCED, not asserted`);
        else {
          if (!Array.isArray(sr.sources_consulted) || !sr.sources_consulted.length) fails.push(`${id}: search_record.sources_consulted must be a non-empty list of the sources searched`);
          if (!Array.isArray(sr.queries) || !sr.queries.length) fails.push(`${id}: search_record.queries must be a non-empty list of the queries used`);
          if (!w || !w.from || !w.to) fails.push(`${id}: search_record.window must carry from and to`);
          if (typeof sr.searched_at !== "string" || !Number.isFinite(Date.parse(sr.searched_at))) fails.push(`${id}: search_record.searched_at must be a parseable timestamp (got ${JSON.stringify(sr?.searched_at)})`);
        }
      } else if (typeof th === "string" && th.trim()) {
        // The converse, which is the direction a mislabel would actually take: a record that HAS a case must not
        // claim there is none, or the no-case stratum inflates and §6's proportion — itself a result — is wrong.
        if (ts === "no_public_case") fails.push(`${id}: carries a thesis but declares thesis_state "no_public_case"`);
      }
      if (!("venue_event_key" in rec)) fails.push(`${id}: v1.11 requires venue_event_key on every record posted after the amendment — present, verbatim from the venue, or explicitly null where the venue publishes none. Omitting the key is not the same as recording that there is none`);
      else { const vk = rec.venue_event_key;
        if (vk !== null && (typeof vk !== "string" || !vk.trim())) fails.push(`${id}: venue_event_key must be the venue's published identifier verbatim, or null — got ${JSON.stringify(vk)}`);
        // v1.11 exists because the venue identifier is NOT the cluster key. Catch the regression directly.
        if (typeof vk === "string" && typeof ek === "string" && vk === ek) warns.push(`${id}: event_key equals venue_event_key (${ek}) — v1.11 makes event_key operator-assigned and venue-INDEPENDENT, so a venue ticker used as the cluster key is the exact defect v1.11 corrected. Legitimate only if the operator key genuinely coincides with the venue's string`);
      }
    } else {
      for (const k of ["event_key", "venue_event_key"]) if (k in rec) fails.push(`${id}: carries ${k} but was posted before the amendment — a record sealed before it is immutable and anchored, so the field cannot be backfilled into it`);
    }
    if (r.record_hash) { sealed++; if (!HEX.test(r.record_hash)) fails.push(`${id}: record_hash format`); if (sha256hex(canonical(strip(r, PHASE_B_EXCLUDE))) !== r.record_hash) fails.push(`${id}: record_hash does not recompute`); dayHashes.push(r.record_hash);
      if (r.binding?.type === "venue" && (r.price_at_audit == null)) fails.push(`${id}: venue record sealed without price_at_audit`); }
    if (r.deviated) deviated++;
    // v1.7(a) is categorical for records sealed AFTER the amendment, and Phase A writes both keys, so key presence is
    // what separates a post-v1.7 record from a pre-v1.7 one. Absence stays legal; a null on a sealed venue record does not.
    if (r.record_hash && ("volume_24h" in r || "volume_total" in r)) {
      if (r.binding?.type === "venue" && (r.volume_24h == null || r.volume_total == null)) fails.push(`${id}: sealed venue record carries the v1.7(a) keys but a null volume — the amendment requires the bound market volume on every record sealed after it`);
      if (r.binding?.type === "series" && (r.volume_24h != null || r.volume_total != null)) fails.push(`${id}: sealed series record carries a non-null volume — v1.7(a) says a series binding names no venue market and carries null`);
    }
    const vols = { v24: r.volume_24h ?? null, vtot: r.volume_total ?? null };
    if (r.record_hash && r.binding?.type === "venue" && "volume_24h" in r && r.volume_24h != null && !(r.volume_24h >= 0)) fails.push(`${id}: volume_24h is not a non-negative number`);
    if (r.record_hash && r.volume_24h != null && r.volume_total != null && r.volume_total < r.volume_24h) fails.push(`${id}: volume_total ${r.volume_total} < volume_24h ${r.volume_24h} — a cumulative total cannot be smaller than its own last 24h`);
    if (r.price_source?.provider === "dune") priceChecks.push({ id: r.id, ps: r.price_source, price: r.price_at_audit, posted_at: String(r.posted_at), ...vols });
    if (r.price_source?.provider === "kalshi-api") kalshiChecks.push({ id: r.id, ps: r.price_source, price: r.price_at_audit, posted_at: String(r.posted_at), ...vols });
    if (r.outcome) { graded++; if (!RESULT.has(r.outcome.result)) fails.push(`${id}: outcome.result ${r.outcome.result}`); if (r.outcome.grader === "dj" && !r.outcome.evidence_url) fails.push(`${id}: manual grade without evidence_url`);
      if (r.criterion?.grade_due && r.outcome.graded_at && r.outcome.graded_at < r.criterion.grade_due) fails.push(`${id}: graded before grade_due`); }
  }
  if (dayHashes.length) { const root = merkleRoot(dayHashes); const a = anchors.find(x => x.date === date);
    if (!a) warns.push(`${date}: ${dayHashes.length} sealed record(s), no anchor yet`);
    else { if (a.merkle_root !== root) fails.push(`${date}: anchors.json root ≠ recomputed root`); if (a.record_count !== dayHashes.length) fails.push(`${date}: anchors.json record_count ${a.record_count} ≠ ${dayHashes.length}`); } }
}
/** Polymarket identifier rule. `market.ticker` on a Polymarket record is a Gamma MARKET SLUG, not a condition id:
 *  q3-log.ts Phase A validates it with /markets?slug= and q3-grade.ts grades through the same lookup. Surf's
 *  polymarket-trades takes --condition-id. Resolve it, never assume: a condition id the record carries wins, then a
 *  ticker that already holds one, then the slug looked up at Gamma. Returns an error rather than sending a slug where
 *  a condition id is expected — a slug silently returns no trades, which reads as "no data" instead of "wrong id".
 *  CONDITION_ID and the record-hash HEX share the 0x+64hex shape; tests/q3/tape/discover.ts holds the same rule. */
const CONDITION_ID = HEX;
async function polymarketConditionId(mk: any): Promise<{ id: string; via: string } | { error: string }> {
  const carried = String(mk?.condition_id ?? "").trim().toLowerCase();
  if (CONDITION_ID.test(carried)) return { id: carried, via: "market.condition_id" };
  const raw = String(mk?.ticker ?? "").replace(/^polymarket:/i, "").trim();
  if (!raw) return { error: "record carries neither market.condition_id nor market.ticker" };
  if (CONDITION_ID.test(raw.toLowerCase())) return { id: raw.toLowerCase(), via: "market.ticker (already a condition id)" };
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(raw)}`);
    if (!r.ok) return { error: `gamma HTTP ${r.status} resolving slug ${raw}` };
    const cid = String((await r.json() as any[])?.[0]?.conditionId ?? "").trim().toLowerCase();
    return CONDITION_ID.test(cid) ? { id: cid, via: `gamma slug lookup (${raw})` } : { error: `gamma returned no conditionId for slug ${raw}` };
  } catch (e) { return { error: `gamma unreachable resolving slug ${raw}: ${(e as Error).message.slice(0, 60)}` }; }
}
(async () => {
  for (const a of anchors) {
    let r: Response | null = null; for (let t = 1; t <= 3; t++) { try { r = await fetch(a.gateway_url, { redirect: "follow" }); if (r.ok || r.status < 500) break; } catch { r = null; } if (t < 3) await new Promise(s => setTimeout(s, 1500 * t)); }
    // Outage is not mismatch: unreachable / 5xx after retries → WARN (anchor not verified THIS run). 404 = item gone → FAIL.
    if (!r) { warns.push(`${a.date}: Irys gateway unreachable after 3 attempts (network) — anchor NOT verified this run`); continue; }
    if (r.status >= 500) { warns.push(`${a.date}: Irys gateway HTTP ${r.status} after 3 attempts — anchor NOT verified this run`); continue; }
    try { if (!r.ok) { fails.push(`${a.date}: Irys gateway HTTP ${r.status} — anchor item missing`); continue; } const item = await r.json() as any;
      if (item.merkle_root !== a.merkle_root) fails.push(`${a.date}: Irys root ≠ anchors.json root`); if (item.date !== a.date) fails.push(`${a.date}: Irys date ${item.date}`); if (item.record_count !== a.record_count) fails.push(`${a.date}: Irys count ${item.record_count}`);
    } catch (e) { fails.push(`${a.date}: Irys fetch failed ${(e as Error).message}`); }
  }
  for (const kc of kalshiChecks) { try { const q = kc.ps.query_params; const k = await kalshiVwap(String(q.ticker), String(q.side), new Date(Number(q.max_ts) * 1000).toISOString(), Math.round((Number(q.max_ts) - Number(q.min_ts)) / 60));
      if (k.vwap == null || Math.abs(k.vwap - kc.price) > tol) fails.push(`${kc.id}: Kalshi re-fetch vwap ${k.vwap} ≠ recorded ${kc.price}`); if (k.trade_count !== kc.ps.trade_count) fails.push(`${kc.id}: Kalshi fills ${k.trade_count} ≠ recorded ${kc.ps.trade_count}`);
    } catch (e) { fails.push(`${kc.id}: Kalshi re-fetch failed — ${(e as Error).message}`); } }
  // v1.7(a) SCHEDULES, and they differ on purpose.
  //   volume_24h  rides the price re-fetch and keeps the price's schedule.
  //   volume_total is IMMUTABLE once posted_at is past (its window ends there, over settled trades) and is sealed in
  //     record_hash, so re-running it weekly re-answers a settled question. It is checked at seal — the commit that
  //     adds the record makes records change, which forces the check — and then once more on the first weekly full
  //     pass after sealing. The 8-day window is the weekly cadence plus a margin, so exactly one scheduled run catches
  //     a given record and none after it. On Kalshi this skips the full-history page walk outright; on Dune the column
  //     rides the price execution either way, so the saving there is nil and the rule is applied only for consistency.
  const reverifyMode = process.env.DUNE_REVERIFY ?? "always";
  let recordsChangedThisCommit = true;
  if (reverifyMode === "changed") { try { const { execSync } = await import("node:child_process"); recordsChangedThisCommit = execSync("git diff --name-only HEAD~1 -- tests/q3/records tests/q3/anchors.json", { encoding: "utf8" }).trim().length > 0; } catch { recordsChangedThisCommit = true; } }
  const VOL_TOTAL_WINDOW_DAYS = 8;
  const volTotalDue = (postedAt: string) => recordsChangedThisCommit || (reverifyMode === "always" && (Date.now() - new Date(postedAt).getTime()) <= VOL_TOTAL_WINDOW_DAYS * 86400e3);
  // v1.4 use 6 placeholder — Kalshi volume re-check follows.
  // v1.7(a) — Kalshi volume re-check, on the same schedule as the Kalshi price: recomputed from the same per-fill history.
  for (const kc of kalshiChecks) {
    if (kc.v24 == null && kc.vtot == null) continue; // sealed before v1.7
    const kt = String(kc.ps.query_params?.ticker ?? ""); if (!kt) { warns.push(`${kc.id}: volume not re-verified — price_source.query_params carries no ticker`); continue; }
    const wantTotal = volTotalDue(kc.posted_at);
    try { const kv = await kalshiVolumes(kt, new Date(Number(kc.ps.query_params?.max_ts) * 1000).toISOString(), fetch, 400, wantTotal);
      if (kv.volume_24h == null) { warns.push(`${kc.id}: volume not re-verified — ${kv.note ?? "no volume returned"}`); continue; }
      if (kc.v24 != null && !volClose(kc.v24, kv.volume_24h)) fails.push(`${kc.id}: Kalshi volume_24h re-fetch ${kv.volume_24h.toFixed(2)} ≠ recorded ${kc.v24}`);
      if (!wantTotal) warns.push(`${kc.id}: volume_total not re-checked this run — settled at seal and on its first weekly pass (immutable once posted_at is past)`);
      else if (kv.volume_total == null) warns.push(`${kc.id}: volume_total not re-verified — ${kv.note ?? "no total returned"}`);
      else if (kc.vtot != null && !volClose(kc.vtot, kv.volume_total)) fails.push(`${kc.id}: Kalshi volume_total re-fetch ${kv.volume_total.toFixed(2)} ≠ recorded ${kc.vtot}`);
    } catch (e) { warns.push(`${kc.id}: Kalshi volume re-fetch unavailable — ${(e as Error).message.slice(0, 90)}`); }
  }
  // v1.4 use 6 — third-source cross-check (Surf-indexed Polymarket trades) on Dune-priced records. Tape tier: WARN by default, never record-bearing.
  const CROSS = process.env.CROSS_CHECK ?? "warn";
  if (CROSS !== "off" && priceChecks.length && surfAvailable()) {
    for (const pc of priceChecks) { try { const q = pc.ps.query_params; const end = Math.floor(new Date(q.captured_at).getTime() / 1000); const start = end - Number(q.window_min ?? 60) * 60;
        const rec = JSON.parse(readFileSync(`${REC_DIR}/${pc.id.slice(3, 13)}.json`, "utf8")).find((r: any) => r.id === pc.id); const side = String(rec?.market?.side ?? "YES") === "NO" ? "No" : "Yes";
        const resolved = await polymarketConditionId(rec?.market);
        if ("error" in resolved) { warns.push(`${pc.id}: Surf cross-check skipped — could not resolve a condition id: ${resolved.error}`); continue; }
        const t = rows(surf("polymarket-trades", ["--condition-id", resolved.id, "--outcome-label", side, "--type", "trade", "--from", String(start), "--to", String(end), "--limit", "500"]), pc.id);
        let num = 0, den = 0; for (const x of t as any[]) { const px = Number(x.price ?? x.price_usd); const sz = Number(x.size ?? x.shares ?? (x.amount_usd && px ? x.amount_usd / px : 0)); if (px > 0 && sz > 0) { num += px * sz; den += sz; } }
        const v3 = den ? num / den : NaN; const d = Math.abs(v3 - pc.price);
        if (!Number.isFinite(v3)) warns.push(`${pc.id}: Surf cross-check — no trades returned (${t.length} rows)`);
        else if (d > 0.02) (CROSS === "strict" ? fails : warns).push(`${pc.id}: Surf cross-check vwap ${v3.toFixed(4)} vs Dune ${pc.price} (Δ ${d.toFixed(4)} > 0.02)`);
        else warns.push(`${pc.id}: Surf cross-check agrees (Δ ${d.toFixed(4)})`);
      } catch (e) { warns.push(`${pc.id}: Surf cross-check unavailable — ${(e as Error).message.slice(0, 100)}`); } }
  }
  if (priceChecks.length) {
    // DUNE_REVERIFY: "always" (default; weekly schedule) | "changed" (CI on push: only if a record/anchor file changed in this commit) | "never".
    // Dune executions are metered per billing cycle; a commit that touches no record must not spend one.
    const mode = reverifyMode, recordsChanged = recordsChangedThisCommit; // hoisted above; one definition, two consumers
    if (mode === "never" || (mode === "changed" && !recordsChanged)) warns.push(`${priceChecks.length} Polymarket price(s) not re-executed on Dune this run — no record/anchor changed (DUNE_REVERIFY=${mode}); weekly schedule re-verifies all`);
    else if (!duneKey()) warns.push(`${priceChecks.length} Polymarket price(s) not re-verified — no DUNE_API_KEY`);
    else for (const pc of priceChecks) { try { const run = await runDuneQuery(Number(pc.ps.query_id), pc.ps.query_params); const pr = asPriceRow(run.rows);
      if (Math.abs(pr.vwap - pc.price) > tol) fails.push(`${pc.id}: Dune re-execution vwap ${pr.vwap} ≠ recorded ${pc.price}`); if (pr.trade_count !== pc.ps.trade_count) fails.push(`${pc.id}: trade_count ${pr.trade_count} ≠ recorded ${pc.ps.trade_count}`);
      for (const [label, rec_v, got_v] of [["volume_24h", pc.v24, pr.volume_24h], ["volume_total", pc.vtot, pr.volume_total]] as [string, number | null, number | null | undefined][]) {
        if (rec_v == null) continue; // sealed before v1.7, or a series binding
        if (label === "volume_total" && !volTotalDue(pc.posted_at)) { warns.push(`${pc.id}: volume_total not re-checked this run — settled at seal and on its first weekly pass (immutable once posted_at is past)`); continue; }
        if (got_v === undefined) fails.push(`${pc.id}: ${label} cannot be re-verified — Dune query ${pc.ps.query_id} no longer returns a ${label} column, so the sealed volume is not reproducible`);
        else if (got_v === null) warns.push(`${pc.id}: ${label} not re-verified — the price query returned NULL for it this run (market_details did not resolve the token)`);
        else if (!volClose(rec_v, got_v)) fails.push(`${pc.id}: ${label} re-execution ${got_v} ≠ recorded ${rec_v}`);
      }
    } catch (e) { const m = (e as Error).message;
      // Budget (402), rate limit (429), outage (5xx), network: the record is NOT wrong, it is NOT VERIFIED THIS RUN → WARN. Anything else is a real failure.
      if (/HTTP (402|429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|UND_ERR/.test(m)) warns.push(`${pc.id}: Dune unavailable (${m.slice(0, 90)}) — price NOT re-verified this run`); else fails.push(`${pc.id}: Dune re-execution failed — ${m}`); } }
  }
  // v1.10 requires any statistic over records to state the number of DISTINCT EVENTS alongside the number of records.
  // The verifier is not §6, but it is where the counts are already computed, so it reports the pair and names any
  // cluster carrying more than one record — the shape §6 must not silently treat as independent.
  if (eventKeys.size) {
    const multi = [...eventKeys.entries()].filter(([, ids]) => ids.length > 1);
    console.log(`q3-verify · v1.10 clusters: ${[...eventKeys.values()].reduce((a, b) => a + b.length, 0)} record(s) over ${eventKeys.size} distinct event(s)` + (multi.length ? ` · ${multi.length} event(s) carry more than one record: ${multi.map(([k, ids]) => `${k} x${ids.length}`).join(", ")}` : ""));
  }
  console.log(`q3-verify · ${n} records (${sealed} sealed, ${deviated} pilot/deviated, ${graded} graded) · ${anchors.length} anchor(s)`);
  for (const w of warns) console.log("  WARN", w);
  if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log(`PASS — every hash recomputes, every anchor matches its Irys item${priceChecks.length && duneKey() ? `, ${priceChecks.length} Polymarket price(s) re-derived from chain` : ""}${kalshiChecks.length ? `, ${kalshiChecks.length} Kalshi price(s) re-fetched from venue` : ""}`);
})();
