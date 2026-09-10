/**
 * Publish + contract-test the two Q3 Dune queries (protocol v1.2). Stands in for the Dune-MCP steps 1–5 of HANDOFF-dune.md
 * when no MCP session exists; needs only DUNE_API_KEY (Read/Write scope; Dune's query endpoints require an Analyst plan or higher).
 *   npx tsx tests/q3/dune-publish.ts            create both saved queries PUBLIC, run the checks, write the IDs into dune.json
 *   npx tsx tests/q3/dune-publish.ts --test     run the checks against the IDs already in dune.json (no create, no write)
 *   npx tsx tests/q3/dune-publish.ts --update   PATCH the committed SQL onto the existing IDs, ensure public, then run the checks
 * SQL is read verbatim from tests/q3/queries/*.sql so the committed text and the published text cannot diverge. Never commits.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runDuneQuery, asPriceRow, duneKey, type DuneRow } from "./dune-client";
const BASE = "https://api.dune.com/api/v1", CFG = "tests/q3/dune.json", Q = "tests/q3/queries";
type Param = { key: string; value: string; type: "text" | "number" };
const SPECS = {
  price: { name: "DJZS Q3 · polymarket_price (VWAP + volume at audit, protocol v1.7)", file: `${Q}/polymarket_price.sql`, idKey: "price_query_id",
    description: "VWAP of on-chain trades on one Polymarket outcome token in [captured_at - window_min, captured_at), plus the bound market volume_24h and volume_total at captured_at (v1.7a, same execution). SQL + contract: github.com/SIFR0-dev/djzs-AI tests/q3/queries",
    params: [{ key: "token_id", value: "0", type: "text" }, { key: "captured_at", value: "2026-01-01T00:00:00Z", type: "text" }, { key: "window_min", value: "60", type: "number" }] as Param[] },
  pool: { name: "DJZS Q3 · polymarket_pool (top-N by 24h volume in scan categories, protocol v1.5)", file: `${Q}/polymarket_pool.sql`, idKey: "pool_query_id",
    description: "Top-n Polymarket markets by single-counted 24h on-chain volume within the scan categories (v1.5 rule 1; labels in the SQL header, matched on market_details.tags), excluding condition_ids already recorded. SQL + contract: github.com/SIFR0-dev/djzs-AI tests/q3/queries",
    params: [{ key: "n", value: "5", type: "number" }, { key: "exclude", value: "", type: "text" }] as Param[] },
};
const key = duneKey(); if (!key) { console.error("DUNE_API_KEY not set (env or djzs-trust-mcp/.dev.vars)"); process.exit(1); }
const H = { "X-Dune-API-Key": key, "Content-Type": "application/json" };
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function create(s: typeof SPECS.price): Promise<number> {
  const j = await api("POST", "/query", { name: s.name, description: s.description, query_sql: readFileSync(s.file, "utf8"), parameters: s.params, is_private: false });
  const id = Number(j.query_id); if (!id) throw new Error(`create returned no query_id: ${JSON.stringify(j).slice(0, 200)}`); return id;
}
async function update(id: number, s: typeof SPECS.price) { await api("PATCH", `/query/${id}`, { query_id: id, name: s.name, description: s.description, query_sql: readFileSync(s.file, "utf8"), parameters: s.params }); }
async function ensurePublic(id: number, s: typeof SPECS.price) {
  await api("POST", `/query/${id}/unprivate`); const q = await api("GET", `/query/${id}`);
  if (q.is_private !== false) throw new Error(`query ${id} still private after unprivate`);
  if (String(q.query_sql ?? "").trim() !== readFileSync(s.file, "utf8").trim()) throw new Error(`query ${id}: published SQL ≠ ${s.file}`);
  console.log(`  ${s.idKey} = ${id} · public · SQL matches ${s.file} · https://dune.com/queries/${id}`);
}
/** v1.5 rule 1 label sets — MUST equal the regexes in polymarket_pool.sql and tests/q3/tape/discover.ts (the SQL header is the committed source). */
const POOL_INCLUDE = /(^|[^a-z0-9])(politics|elections|geopolitics|world|economy|fed|finance|crypto)([^a-z0-9]|$)/, POOL_EXCLUDE = /(^|[^a-z0-9])(sports|esports|culture|entertainment|weather)([^a-z0-9]|$)/;
const need = (cond: unknown, msg: string) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); console.log(`  ok  ${msg}`); };
async function checks(priceId: number, poolId: number) {
  console.log("checks");
  const pool = await runDuneQuery(poolId, { n: 5, exclude: "" }); const rows = pool.rows;
  need(rows.length === 5, `pool n=5 exclude="" → 5 rows (got ${rows.length})`);
  for (const c of ["condition_id", "question", "token_id_yes", "token_id_no", "volume_24h_usdc", "last_price_yes", "tags"]) need(rows.every(r => c in r), `pool column '${c}' present on every row`);
  for (const r of rows) { const t = String(r.tags ?? "").toLowerCase(); need(POOL_INCLUDE.test(t) && !POOL_EXCLUDE.test(t), `pool row ${String(r.condition_id).slice(0, 12)}… in-category (v1.5 rule 1): tags=${String(r.tags).slice(0, 80)}`); }
  need(rows.every(r => /^\d+$/.test(String(r.token_id_yes))), "pool token_id_yes is a decimal string on every row");
  const ex = await runDuneQuery(poolId, { n: 5, exclude: String(rows[0].condition_id) });
  need(ex.rows.length === 5 && !ex.rows.some(r => r.condition_id === rows[0].condition_id), `pool exclude=${String(rows[0].condition_id).slice(0, 12)}… drops that market and still returns 5 rows`);
  const now = new Date().toISOString(); let live: DuneRow[] | null = null, liveTok = "";
  for (const r of rows) for (const tok of [String(r.token_id_yes), String(r.token_id_no)]) {
    if (live) break; const run = await runDuneQuery(priceId, { token_id: tok, captured_at: new Date(Date.now() - 3 * 3600e3).toISOString(), window_min: 60 });
    if (run.rows.length === 1 && Number(run.rows[0].trade_count) > 0) { live = run.rows; liveTok = tok; }
  }
  need(live, "price on a live token, captured_at=now−3h (table lags ~1h), window_min=60 → trade_count > 0 (tried YES/NO tokens of the top-5 pool)");
  const pr = asPriceRow(live!); need(Number.isFinite(pr.vwap) && pr.vwap > 0 && pr.vwap < 1, `price live token ${liveTok.slice(0, 10)}…: one row, vwap ${pr.vwap} over ${pr.trade_count} trades, ${pr.volume_usdc.toFixed(2)} USDC`);
  // v1.7(a): the two volume columns must ride this SAME execution — the amendment adds no additional Dune runs.
  need(pr.volume_24h != null && pr.volume_total != null, `v1.7a volume columns present and non-NULL on a live token (24h ${pr.volume_24h}, total ${pr.volume_total})`);
  need((pr.volume_24h as number) >= 0 && (pr.volume_total as number) >= 0, "v1.7a volumes are non-negative");
  need((pr.volume_total as number) >= (pr.volume_24h as number), `v1.7a volume_total ${pr.volume_total} >= volume_24h ${pr.volume_24h} (a cumulative total cannot be smaller than its own last 24h)`);
  // This probe was selected for trade_count > 0, so a zero here is a systematic condition_id join break, not an idle market.
  need((pr.volume_total as number) > 0, `v1.7a volume_total > 0 on a token with ${pr.trade_count} trades in-window (a zero means the condition_id join matched nothing)`);
  need(pr.window_start < pr.window_end, `window_start ${pr.window_start} < window_end ${pr.window_end}`);
  const empty = await runDuneQuery(priceId, { token_id: liveTok, captured_at: "2020-01-01T00:00:00Z", window_min: 1 });
  need(empty.rows.length === 1, `price on an empty window (pre-launch captured_at, window_min=1) → still exactly one row (got ${empty.rows.length})`);
  need(empty.rows[0].vwap === null && Number(empty.rows[0].trade_count) === 0, `empty window → vwap NULL, trade_count 0 (got vwap=${empty.rows[0].vwap}, trade_count=${empty.rows[0].trade_count})`);
  for (const c of ["vwap", "trade_count", "volume_usdc", "window_start", "window_end", "volume_24h", "volume_total"]) need(c in empty.rows[0], `price column '${c}' present on the empty-window row`);
  // v1.7(a): the CASE exists so an UNRESOLVABLE token yields NULL, never 0 — "unknown" and "none" are different answers.
  // The empty-window probe above does NOT exercise it: that token resolves in market_details, so it takes the 0 branch.
  const unresolved = await runDuneQuery(priceId, { token_id: "0", captured_at: now, window_min: 60 });
  need(unresolved.rows.length === 1, `price on an unresolvable token_id → still exactly one row (got ${unresolved.rows.length})`);
  need(unresolved.rows[0].volume_24h === null && unresolved.rows[0].volume_total === null, `v1.7a unresolvable token_id → volume_24h and volume_total are NULL, never 0 (got ${unresolved.rows[0].volume_24h}, ${unresolved.rows[0].volume_total})`);
}
(async () => {
  const mode = process.argv.includes("--test") ? "test" : process.argv.includes("--update") ? "update" : "create";
  const cfg = JSON.parse(readFileSync(CFG, "utf8")); const ids: Record<string, number> = {};
  for (const [k, s] of Object.entries(SPECS)) {
    let id = Number(cfg[s.idKey] ?? 0);
    if (!id) { if (mode !== "create") { console.error(`${CFG}: ${s.idKey} not set — run without --test/--update to create it`); process.exit(1); }
      console.log(`create (public) ${k}`); id = await create(s); cfg[s.idKey] = id; writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n"); console.log(`  wrote ${s.idKey} = ${id} immediately (IDs survive a failed check)`); }
    ids[k] = id;
  }
  if (mode === "update") { console.log("update"); for (const [k, s] of Object.entries(SPECS)) await update(ids[k], s); }
  if (mode !== "test") for (const [k, s] of Object.entries(SPECS)) await ensurePublic(ids[k], s);
  await checks(ids.price, ids.pool);
  console.log("PASS — now: npx tsx tests/q3/q3-verify.ts && git add tests/q3 && git commit");
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
