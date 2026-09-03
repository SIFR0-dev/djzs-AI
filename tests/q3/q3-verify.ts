/**
 * Q3 integrity check — runs in CI on every push and locally on demand. Exit 1 on any failure.
 *  1. every record: required fields present, enums valid, both hashes recompute from the file as committed
 *  2. every day with sealed records: Merkle root recomputed; if an anchor exists for that day it must match
 *  3. every anchor: Irys item fetched (following redirects); its merkle_root, date and record_count must match
 *  4. pilot/deviated records counted separately; a day with sealed records but no anchor is a WARNING (anchor may be pending)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { canonical, sha256hex, merkleRoot, strip, PHASE_A_EXCLUDE, PHASE_B_EXCLUDE } from "./lib";
import { runDuneQuery, asPriceRow, duneKey } from "./dune";
const REC_DIR = "tests/q3/records", ANCHORS = "tests/q3/anchors.json";
const ORIGINS = new Set(["scan", "pool"]), BIND = new Set(["venue", "series", "unbound"]), VERD = new Set(["PASS", "WAIT", "FAIL", "OUT_OF_SCOPE"]), RESULT = new Set(["CORRECT", "INCORRECT", "VOID"]);
const REQ = ["id", "protocol_version", "posted_at", "origin", "scan_ref", "source", "market", "binding", "prescreen", "intent", "criterion", "engine", "intent_sha256", "phase_a_hash"];
const HEX = /^0x[0-9a-f]{64}$/;
let fails: string[] = [], warns: string[] = [], n = 0, sealed = 0, deviated = 0, graded = 0;
const priceChecks: { id: string; ps: any; price: number }[] = []; const tol = Number((JSON.parse(readFileSync("tests/q3/dune.json", "utf8")) as any).price_tolerance ?? 1e-9);
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
    if (r.record_hash) { sealed++; if (!HEX.test(r.record_hash)) fails.push(`${id}: record_hash format`); if (sha256hex(canonical(strip(r, PHASE_B_EXCLUDE))) !== r.record_hash) fails.push(`${id}: record_hash does not recompute`); dayHashes.push(r.record_hash);
      if (r.binding?.type === "venue" && (r.price_at_audit == null)) fails.push(`${id}: venue record sealed without price_at_audit`); }
    if (r.deviated) deviated++;
    if (r.price_source?.provider === "dune") priceChecks.push({ id: r.id, ps: r.price_source, price: r.price_at_audit });
    if (r.outcome) { graded++; if (!RESULT.has(r.outcome.result)) fails.push(`${id}: outcome.result ${r.outcome.result}`); if (r.outcome.grader === "dj" && !r.outcome.evidence_url) fails.push(`${id}: manual grade without evidence_url`);
      if (r.criterion?.grade_due && r.outcome.graded_at && r.outcome.graded_at < r.criterion.grade_due) fails.push(`${id}: graded before grade_due`); }
  }
  if (dayHashes.length) { const root = merkleRoot(dayHashes); const a = anchors.find(x => x.date === date);
    if (!a) warns.push(`${date}: ${dayHashes.length} sealed record(s), no anchor yet`);
    else { if (a.merkle_root !== root) fails.push(`${date}: anchors.json root ≠ recomputed root`); if (a.record_count !== dayHashes.length) fails.push(`${date}: anchors.json record_count ${a.record_count} ≠ ${dayHashes.length}`); } }
}
(async () => {
  for (const a of anchors) {
    let r: Response | null = null; for (let t = 1; t <= 3 && !r; t++) { try { r = await fetch(a.gateway_url, { redirect: "follow" }); } catch { if (t < 3) await new Promise(z => setTimeout(z, 3000 * t)); } }
    if (!r) { fails.push(`${a.date}: Irys gateway unreachable after 3 attempts (network) — anchor NOT verified`); continue; }
    try { if (!r.ok) { fails.push(`${a.date}: Irys gateway HTTP ${r.status}`); continue; } const item = await r.json() as any;
      if (item.merkle_root !== a.merkle_root) fails.push(`${a.date}: Irys root ≠ anchors.json root`); if (item.date !== a.date) fails.push(`${a.date}: Irys date ${item.date}`); if (item.record_count !== a.record_count) fails.push(`${a.date}: Irys count ${item.record_count}`);
    } catch (e) { fails.push(`${a.date}: Irys fetch failed ${(e as Error).message}`); }
  }
  if (priceChecks.length) {
    if (!duneKey()) warns.push(`${priceChecks.length} Polymarket price(s) not re-verified — no DUNE_API_KEY`);
    else for (const pc of priceChecks) { try { const run = await runDuneQuery(Number(pc.ps.query_id), pc.ps.query_params); const pr = asPriceRow(run.rows);
      if (Math.abs(pr.vwap - pc.price) > tol) fails.push(`${pc.id}: Dune re-execution vwap ${pr.vwap} ≠ recorded ${pc.price}`); if (pr.trade_count !== pc.ps.trade_count) fails.push(`${pc.id}: trade_count ${pr.trade_count} ≠ recorded ${pc.ps.trade_count}`);
    } catch (e) { fails.push(`${pc.id}: Dune re-execution failed — ${(e as Error).message}`); } }
  }
  console.log(`q3-verify · ${n} records (${sealed} sealed, ${deviated} pilot/deviated, ${graded} graded) · ${anchors.length} anchor(s)`);
  for (const w of warns) console.log("  WARN", w);
  if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log(`PASS — every hash recomputes, every anchor matches its Irys item${priceChecks.length && duneKey() ? `, ${priceChecks.length} Polymarket price(s) re-derived from chain` : ""}`);
})();
