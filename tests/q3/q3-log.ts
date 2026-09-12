/**
 * Q3 logger. Two phases, per PROTOCOL §4/§8.
 *   Phase A: npx tsx tests/q3/q3-log.ts --phase-a tests/q3/inbox/<file>.json [--stub]
 *            reads an operator-authored record (no engine, no price), runs the DJZS engine locally,
 *            fills engine.*, intent_sha256, intent_hash (if viem resolvable), phase_a_hash; appends to records/<date>.json
 *   Phase B: npx tsx tests/q3/q3-log.ts --phase-b <id> --price 0.664
 *            sets price fields + price_captured_at, computes record_hash. Refuses if phase_a_hash missing.
 * The engine run uses N=3 consensus at temperature 0 exactly as production does. --stub uses a fixed model (self-test only).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { extractAuditInputConsensus, EXTRACTION_CONTRACT_VERSION, type ModelFn } from "../../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../../server/engine-v2/deterministic-engine";
import { PM_SCHEMA_VERSION } from "../../shared/pm-taxonomy";
import { SCHEMA_VERSION } from "../../shared/audit-schema";
import { canonical, sha256hex, renderIntentText, devVar, strip, PHASE_A_EXCLUDE, PHASE_B_EXCLUDE } from "./lib";
import { runDuneQuery, asPriceRow } from "./dune-client";
import { kalshiVwap, kalshiVolumes } from "./kalshi-client";

const args = process.argv.slice(2); const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const REC_DIR = "tests/q3/records";
const REQUIRED_A = ["id", "protocol_version", "posted_at", "origin", "scan_ref", "source", "market", "binding", "prescreen", "intent", "criterion"];

function anthropicModel(): ModelFn {
  const key = devVar("ANTHROPIC_API_KEY"); if (!key) { console.error("ANTHROPIC_API_KEY not found"); process.exit(2); }
  return async (prompt) => { for (let a = 1; a <= 4; a++) { let r: Response; try { r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, temperature: 0, messages: [{ role: "user", content: prompt }] }) }); } catch (e) { if (a < 4) { await new Promise(z => setTimeout(z, 2500 * a)); continue; } throw e; }
    if (r.status === 429 || r.status === 529 || r.status >= 500) { await new Promise(z => setTimeout(z, 1500 * a)); continue; } if (!r.ok) throw new Error(`API ${r.status}`); const d = await r.json() as any; return d.content?.[0]?.text ?? ""; } throw new Error("retries exhausted"); };
}
const stubModel: ModelFn = async () => JSON.stringify({ agent_type: "a", intended_action: "bet", audit_context: "prediction_market", leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" }, invalidation_condition: { state: "absent" }, resolution_engagement: { state: "present", value: "stub" }, probability_basis: { state: "present", value: "stub" }, edge_claim: { state: "unknown" }, data_sources: { state: "absent" }, oracle_source: { state: "absent" }, confidence: { state: "absent" } });

async function intentHashMaybe(intent: Record<string, unknown>): Promise<string | null> {
  try { const m = await import("../../djzs-trust-mcp/src/djzs-intent"); return (m as any).intentHash((m as any).toDJZSIntent(intent)); } catch { return null; }
}
function loadDay(date: string): Record<string, unknown>[] { const p = `${REC_DIR}/${date}.json`; return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; }
function saveDay(date: string, recs: Record<string, unknown>[]) { mkdirSync(REC_DIR, { recursive: true }); writeFileSync(`${REC_DIR}/${date}.json`, JSON.stringify(recs, null, 2) + "\n"); }
function findRecord(id: string): { date: string; recs: Record<string, unknown>[]; idx: number } | null {
  if (!existsSync(REC_DIR)) return null;
  for (const f of readdirSync(REC_DIR).filter((x: string) => x.endsWith(".json"))) { const recs = loadDay(f.replace(".json", "")); const idx = recs.findIndex(r => r.id === id); if (idx >= 0) return { date: f.replace(".json", ""), recs, idx }; }
  return null;
}

(async () => {
  if (flag("--phase-a")) {
    const rec = JSON.parse(readFileSync(flag("--phase-a")!, "utf8")) as Record<string, unknown>;
    const missing = REQUIRED_A.filter(k => !(k in rec)); if (missing.length) { console.error("Phase A: missing fields:", missing.join(", ")); process.exit(1); }
    for (const k of ["price_at_audit", "implied_prob_at_audit", "engine", "phase_a_hash", "record_hash", "outcome"]) if (k in rec && rec[k] != null) { console.error(`Phase A: '${k}' must not be present — it is computed or belongs to a later phase`); process.exit(1); }
    // SCAN_SPEC §10.2: an inbox file may carry draft_captured_at for the operator's information. It is not evidence
    // and is not sealed, so it is dropped here rather than merely excluded from the hash — a sealed record must not
    // carry a timestamp that looks like provenance but was regenerated in this pass.
    if ("draft_captured_at" in rec) { console.log(`  note: dropping draft_captured_at ${JSON.stringify(rec.draft_captured_at)} — draft-only, not sealed (SCAN_SPEC §10.2)`); delete rec.draft_captured_at; }
    const date = String(rec.posted_at).slice(0, 10); const recs = loadDay(date); if (recs.some(r => r.id === rec.id)) { console.error(`Phase A: id ${rec.id} already exists in ${date}`); process.exit(1); }
    // Venue ticker must resolve before anything is hashed — a 404 ticker is an ungradable record (learned from pilot N5).
    const mk = rec.market as Record<string, unknown>; const bt = (rec.binding as Record<string, unknown>)?.type;
    if (bt === "venue" && mk.venue === "kalshi") { const vr = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(String(mk.ticker))}`); if (vr.status === 404) { console.error(`Phase A ABORT: kalshi ticker ${mk.ticker} not found — check the strike suffix (e.g. -H25)`); process.exit(1); } if (!vr.ok) console.error(`  warn: kalshi HTTP ${vr.status} validating ticker; continuing`); }
    if (bt === "venue" && mk.venue === "polymarket") { const slug = String(mk.ticker).replace(/^polymarket:/, ""); const vr = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`); const arr = vr.ok ? await vr.json() as unknown[] : []; if (vr.ok && arr.length === 0) { console.error(`Phase A ABORT: polymarket slug ${slug} not found`); process.exit(1); } }
    // v1.12: a pooled market with no dominant public case is audited, not skipped and not deviated. Validate the
    // shape BEFORE anything is hashed — a record that cannot be sealed correctly must never be sealed at all.
    const intent = rec.intent as Record<string, unknown>;
    const ts = rec.thesis_state;
    if (ts !== undefined && ts !== null && ts !== "no_public_case") { console.error(`Phase A: thesis_state must be "no_public_case" or absent — the protocol defines no other value (got ${JSON.stringify(ts)})`); process.exit(1); }
    if (ts === "no_public_case") {
      if (intent.thesis !== null) { console.error(`Phase A: thesis_state "no_public_case" requires intent.thesis null — v1.12 forbids writing, paraphrasing or reconstructing a thesis from the market's own question, price or structure`); process.exit(1); }
      if (rec.deviated === true) { console.error(`Phase A: a no_public_case record is primary-eligible and is NEVER deviated (v1.12)`); process.exit(1); }
      const sr = rec.search_record as Record<string, unknown> | undefined | null;
      const bad = !sr || typeof sr !== "object"
        || !Array.isArray(sr.sources_consulted) || !sr.sources_consulted.length
        || !Array.isArray(sr.queries) || !sr.queries.length
        || !sr.window || typeof sr.window !== "object" || !(sr.window as Record<string, unknown>).from || !(sr.window as Record<string, unknown>).to
        || typeof sr.searched_at !== "string" || !Number.isFinite(Date.parse(sr.searched_at));
      if (bad) { console.error(`Phase A: thesis_state "no_public_case" requires a non-empty search_record {sources_consulted[], queries[], window{from,to}, searched_at} — the absence must be evidenced, not asserted`); process.exit(1); }
    } else if (typeof intent.thesis !== "string" || !intent.thesis.trim()) {
      console.error(`Phase A: intent.thesis must be the verbatim sourced public case (§3), or the record must declare thesis_state "no_public_case" (v1.12)`); process.exit(1);
    }
    // renderIntentText omits null fields, so a no_public_case intent reaches extraction with the thesis genuinely
    // ABSENT rather than as the literal token "null". The engine is NOT special-cased: v1.12 says its verdict on such
    // an input is a finding about the market, not a defect in the record.
    const text = renderIntentText(intent);
    const model = args.includes("--stub") ? stubModel : anthropicModel();
    const x = await extractAuditInputConsensus(text, model, 3);
    let engine: Record<string, unknown>;
    if (x.input.audit_context !== "prediction_market") engine = { verdict: "OUT_OF_SCOPE", action: "OUT_OF_SCOPE", risk_score: 0, codes: [], unknown_fields: [], verdict_hash: null, taxonomy: { pm: PM_SCHEMA_VERSION, engine: SCHEMA_VERSION, extraction: EXTRACTION_CONTRACT_VERSION }, eas_uid: null, paid: false, in_scope: false, disagreements: x.disagreements, failsafe: x.failsafe };
    else { const e = runDeterministicAudit(x.input); engine = { verdict: e.verdict, action: e.verdict, risk_score: e.risk_score, codes: e.flags.map(f => f.code).sort(), unknown_fields: e.unknown_fields, verdict_hash: e.verdict_hash, taxonomy: { pm: PM_SCHEMA_VERSION, engine: SCHEMA_VERSION, extraction: EXTRACTION_CONTRACT_VERSION }, eas_uid: null, paid: false, in_scope: true, disagreements: x.disagreements, failsafe: x.failsafe }; }
    rec.engine = engine; rec.intent_sha256 = sha256hex(text); rec.intent_hash = await intentHashMaybe(intent);
    rec.phase_a_hash = sha256hex(canonical(strip(rec, PHASE_A_EXCLUDE)));
    // Round-trip guard: the hash must reproduce from the record as it will be saved and reloaded.
    const roundtrip = JSON.parse(JSON.stringify(rec)); const re = sha256hex(canonical(strip(roundtrip, PHASE_A_EXCLUDE)));
    if (re !== rec.phase_a_hash) { console.error(`Phase A ABORT: phase_a_hash does not survive JSON round-trip (${rec.phase_a_hash} vs ${re}) — a field is not JSON-stable`); process.exit(1); }
    rec.price_at_audit = null; rec.implied_prob_at_audit = null; rec.price_captured_at = null; rec.volume_24h = null; rec.volume_total = null; rec.record_hash = null; rec.outcome = null;
    recs.push(rec); saveDay(date, recs);
    console.log(`Phase A · ${rec.id} · engine ${engine.verdict} ${(engine.codes as string[]).join("+") || "—"} risk ${engine.risk_score} · prescreen ${(rec.prescreen as any).verdict} · agree=${engine.verdict === (rec.prescreen as any).verdict}`);
    console.log(`  phase_a_hash ${rec.phase_a_hash}\n  → ${REC_DIR}/${date}.json   COMMIT NOW, then look up the price.`);
  } else if (flag("--phase-b")) {
    const id = flag("--phase-b")!, fromDune = args.includes("--price-from-dune") || args.includes("--price-from-venue"), price = Number(flag("--price"));
    if (!fromDune && !(price >= 0 && price <= 1)) { console.error("use --price-from-venue (Polymarket → Dune on-chain VWAP; Kalshi → Kalshi trades API VWAP). Operator-typed --price is not permitted for venue records (v1.3.1)."); process.exit(1); }
    const f = findRecord(id); if (!f) { console.error(`no record ${id}`); process.exit(1); } const rec = f.recs[f.idx];
    if (!rec.phase_a_hash) { console.error("Phase B refused: phase_a_hash missing — run Phase A first"); process.exit(1); }
    if (rec.record_hash) { console.error("Phase B refused: record already sealed"); process.exit(1); }
    const bt = (rec.binding as any)?.type; const capturedAt = new Date().toISOString();
    if (bt === "series") { console.error("Phase B: binding.type=series has no market price — sealing without price"); rec.volume_24h = null; rec.volume_total = null; /* v1.7(a): a series binding names no venue market */ }
    else if (fromDune) {
      // v1.2: Polymarket price from a PUBLIC saved Dune query over on-chain trades — recomputable by anyone with the same params.
      const mk = rec.market as any; const cfg = JSON.parse(readFileSync("tests/q3/dune.json", "utf8")); const win = Number(cfg.window_min ?? 60);
      if (mk.venue === "polymarket") {
        // on-chain tier: Dune public saved query over Polygon trades; window ends at posted_at (v1.2.1)
        if (!mk.token_id) { console.error("--price-from-venue needs market.token_id for Polymarket (the audited outcome token)"); process.exit(1); } if (!cfg.price_query_id) { console.error("tests/q3/dune.json: price_query_id not set"); process.exit(1); }
        const qp = { token_id: String(mk.token_id), captured_at: String(rec.posted_at), window_min: win };
        const run = await runDuneQuery(Number(cfg.price_query_id), qp); const pr = asPriceRow(run.rows);
        if (!(pr.trade_count > 0) || !Number.isFinite(pr.vwap)) { console.error(`Phase B refused: no trades on ${mk.token_id} in the ${win}-min window before posted_at ${rec.posted_at}. Dune indexes ~1h behind chain — if posted_at is recent, rerun later; otherwise leave unpriced (excluded from base-rate metric)`); process.exit(1); }
        // v1.7(a): NULL volume means the token did not resolve to a market in market_details, not that the market is idle.
        // A sealed record must never carry a fabricated 0, and null is reserved for series bindings, so refuse and let the operator rerun.
        if (pr.volume_24h == null || pr.volume_total == null) { console.error(`Phase B refused: the price query returned NULL volume for token ${mk.token_id} - market_details has no row for it yet (the API snapshot lags chain), so the bound market cannot be resolved. v1.7(a) requires volume on every record sealed after the amendment; rerun once the snapshot catches up. Nothing was written.`); process.exit(1); }
        rec.price_at_audit = pr.vwap; rec.implied_prob_at_audit = pr.vwap;
        // trade_count > 0 means the audited token traded inside the VWAP window, and mkt_trades range is a strict superset
        // of that window, so a market-wide total of 0 is only possible if the condition_id join matched nothing. That 0
        // means the join failed, not that the market is idle — refusing keeps a fabricated zero out of record_hash.
        if (!(pr.volume_total > 0) || !(pr.volume_24h > 0)) { console.error(`Phase B refused: volume_24h ${pr.volume_24h} / volume_total ${pr.volume_total} on token ${mk.token_id}, but the ${win}-min window had ${pr.trade_count} trades. A market whose audited token just traded cannot have zero volume - the condition_id join matched nothing. Nothing was written.`); process.exit(1); }
        rec.volume_24h = pr.volume_24h; rec.volume_total = pr.volume_total;
        rec.price_source = { provider: "dune", tier: "on-chain", venue: "polymarket", query_id: run.query_id, execution_id: run.execution_id, query_params: qp, vwap: pr.vwap, trade_count: pr.trade_count, volume_usdc: pr.volume_usdc, window_start: pr.window_start, window_end: pr.window_end };
        console.log(`  price (on-chain via Dune): vwap ${pr.vwap} over ${pr.trade_count} trades · query ${run.query_id} · execution ${run.execution_id}`);
        console.log(`  volume (v1.7a, same execution): 24h ${pr.volume_24h} USDC · total ${pr.volume_total} USDC`);
      } else if (mk.venue === "kalshi") {
        // venue-API tier: Kalshi's public trades endpoint, per-fill, immutable history; re-queryable by anyone with the same params
        const k = await kalshiVwap(String(mk.ticker), String(mk.side), String(rec.posted_at), win);
        if (!(k.trade_count > 0) || k.vwap == null) { console.error(`Phase B refused: no Kalshi fills on ${mk.ticker} in the ${win}-min window before posted_at ${rec.posted_at}. Leave unpriced (excluded from base-rate metric); operator-typed prices are not permitted (v1.3.1)`); process.exit(1); }
        const kv = await kalshiVolumes(String(mk.ticker), String(rec.posted_at));
        if (kv.volume_24h == null || kv.volume_total == null) { console.error(`Phase B refused: could not compute v1.7(a) volume for ${mk.ticker} - ${kv.note ?? "unknown reason"}. A partial sum must not be sealed as a total. Nothing was written.`); process.exit(1); }
        rec.price_at_audit = k.vwap; rec.implied_prob_at_audit = k.vwap;
        if (!(kv.volume_total > 0) || !(kv.volume_24h > 0)) { console.error(`Phase B refused: Kalshi volume_24h ${kv.volume_24h} / volume_total ${kv.volume_total} on ${mk.ticker}, but the VWAP gate just found ${k.trade_count} fills in a window inside the same range. Zero cannot be a true answer here. Nothing was written.`); process.exit(1); }
        rec.volume_24h = kv.volume_24h; rec.volume_total = kv.volume_total;
        rec.price_source = { provider: "kalshi-api", tier: "venue-api", venue: "kalshi", endpoint: "GET /trade-api/v2/markets/trades", query_params: k.query, vwap: k.vwap, trade_count: k.trade_count, contracts: k.contracts, volume_usdc: k.volume_usdc, window_start: k.window_start, window_end: k.window_end };
        console.log(`  price (Kalshi trades API): vwap ${k.vwap} over ${k.trade_count} fills, ${k.contracts} contracts · window ${k.window_start} → ${k.window_end}`);
        console.log(`  volume (v1.7a, ${kv.fills} fills over ${kv.pages} pages): 24h ${kv.volume_24h.toFixed(2)} USD · total ${kv.volume_total.toFixed(2)} USD`);
      } else { console.error(`--price-from-venue: venue ${mk.venue} has no supported price source`); process.exit(1); }
    }
    else { console.error("Operator-typed prices are not permitted for venue records (v1.3.1) — use --price-from-venue"); process.exit(1); }
    rec.price_captured_at = capturedAt;
    // v1.7(a) is forward-only: every record sealed from here carries both keys, even when the value is null.
    if (rec.volume_24h === undefined) rec.volume_24h = null; if (rec.volume_total === undefined) rec.volume_total = null;
    rec.record_hash = sha256hex(canonical(strip(rec, PHASE_B_EXCLUDE)));
    const rt = sha256hex(canonical(strip(JSON.parse(JSON.stringify(rec)), PHASE_B_EXCLUDE)));
    if (rt !== rec.record_hash) { console.error("Phase B ABORT: record_hash does not survive JSON round-trip"); process.exit(1); }
    saveDay(f.date, f.recs);
    console.log(`Phase B · ${id} · price ${rec.price_at_audit ?? "n/a (series)"} · record_hash ${rec.record_hash}\n  → ${REC_DIR}/${f.date}.json   COMMIT.`);
  } else { console.error("usage: --phase-a <file> [--stub] | --phase-b <id> --price <p>"); process.exit(1); }
})();
