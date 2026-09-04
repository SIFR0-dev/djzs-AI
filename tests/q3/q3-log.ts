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
import { kalshiVwap } from "./kalshi-client";

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
    const date = String(rec.posted_at).slice(0, 10); const recs = loadDay(date); if (recs.some(r => r.id === rec.id)) { console.error(`Phase A: id ${rec.id} already exists in ${date}`); process.exit(1); }
    // Venue ticker must resolve before anything is hashed — a 404 ticker is an ungradable record (learned from pilot N5).
    const mk = rec.market as Record<string, unknown>; const bt = (rec.binding as Record<string, unknown>)?.type;
    if (bt === "venue" && mk.venue === "kalshi") { const vr = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(String(mk.ticker))}`); if (vr.status === 404) { console.error(`Phase A ABORT: kalshi ticker ${mk.ticker} not found — check the strike suffix (e.g. -H25)`); process.exit(1); } if (!vr.ok) console.error(`  warn: kalshi HTTP ${vr.status} validating ticker; continuing`); }
    if (bt === "venue" && mk.venue === "polymarket") { const slug = String(mk.ticker).replace(/^polymarket:/, ""); const vr = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`); const arr = vr.ok ? await vr.json() as unknown[] : []; if (vr.ok && arr.length === 0) { console.error(`Phase A ABORT: polymarket slug ${slug} not found`); process.exit(1); } }
    const intent = rec.intent as Record<string, unknown>; const text = renderIntentText(intent);
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
    rec.price_at_audit = null; rec.implied_prob_at_audit = null; rec.price_captured_at = null; rec.record_hash = null; rec.outcome = null;
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
    if (bt === "series") { console.error("Phase B: binding.type=series has no market price — sealing without price"); }
    else if (fromDune) {
      // v1.2: Polymarket price from a PUBLIC saved Dune query over on-chain trades — recomputable by anyone with the same params.
      const mk = rec.market as any; const cfg = JSON.parse(readFileSync("tests/q3/dune.json", "utf8")); const win = Number(cfg.window_min ?? 60);
      if (mk.venue === "polymarket") {
        // on-chain tier: Dune public saved query over Polygon trades; window ends at posted_at (v1.2.1)
        if (!mk.token_id) { console.error("--price-from-venue needs market.token_id for Polymarket (the audited outcome token)"); process.exit(1); } if (!cfg.price_query_id) { console.error("tests/q3/dune.json: price_query_id not set"); process.exit(1); }
        const qp = { token_id: String(mk.token_id), captured_at: String(rec.posted_at), window_min: win };
        const run = await runDuneQuery(Number(cfg.price_query_id), qp); const pr = asPriceRow(run.rows);
        if (!(pr.trade_count > 0) || !Number.isFinite(pr.vwap)) { console.error(`Phase B refused: no trades on ${mk.token_id} in the ${win}-min window before posted_at ${rec.posted_at}. Dune indexes ~1h behind chain — if posted_at is recent, rerun later; otherwise leave unpriced (excluded from base-rate metric)`); process.exit(1); }
        rec.price_at_audit = pr.vwap; rec.implied_prob_at_audit = pr.vwap;
        rec.price_source = { provider: "dune", tier: "on-chain", venue: "polymarket", query_id: run.query_id, execution_id: run.execution_id, query_params: qp, vwap: pr.vwap, trade_count: pr.trade_count, volume_usdc: pr.volume_usdc, window_start: pr.window_start, window_end: pr.window_end };
        console.log(`  price (on-chain via Dune): vwap ${pr.vwap} over ${pr.trade_count} trades · query ${run.query_id} · execution ${run.execution_id}`);
      } else if (mk.venue === "kalshi") {
        // venue-API tier: Kalshi's public trades endpoint, per-fill, immutable history; re-queryable by anyone with the same params
        const k = await kalshiVwap(String(mk.ticker), String(mk.side), String(rec.posted_at), win);
        if (!(k.trade_count > 0) || k.vwap == null) { console.error(`Phase B refused: no Kalshi fills on ${mk.ticker} in the ${win}-min window before posted_at ${rec.posted_at}. Leave unpriced (excluded from base-rate metric); operator-typed prices are not permitted (v1.3.1)`); process.exit(1); }
        rec.price_at_audit = k.vwap; rec.implied_prob_at_audit = k.vwap;
        rec.price_source = { provider: "kalshi-api", tier: "venue-api", venue: "kalshi", endpoint: "GET /trade-api/v2/markets/trades", query_params: k.query, vwap: k.vwap, trade_count: k.trade_count, contracts: k.contracts, volume_usdc: k.volume_usdc, window_start: k.window_start, window_end: k.window_end };
        console.log(`  price (Kalshi trades API): vwap ${k.vwap} over ${k.trade_count} fills, ${k.contracts} contracts · window ${k.window_start} → ${k.window_end}`);
      } else { console.error(`--price-from-venue: venue ${mk.venue} has no supported price source`); process.exit(1); }
    }
    else { console.error("Operator-typed prices are not permitted for venue records (v1.3.1) — use --price-from-venue"); process.exit(1); }
    rec.price_captured_at = capturedAt;
    rec.record_hash = sha256hex(canonical(strip(rec, PHASE_B_EXCLUDE)));
    const rt = sha256hex(canonical(strip(JSON.parse(JSON.stringify(rec)), PHASE_B_EXCLUDE)));
    if (rt !== rec.record_hash) { console.error("Phase B ABORT: record_hash does not survive JSON round-trip"); process.exit(1); }
    saveDay(f.date, f.recs);
    console.log(`Phase B · ${id} · price ${rec.price_at_audit ?? "n/a (series)"} · record_hash ${rec.record_hash}\n  → ${REC_DIR}/${f.date}.json   COMMIT.`);
  } else { console.error("usage: --phase-a <file> [--stub] | --phase-b <id> --price <p>"); process.exit(1); }
})();
