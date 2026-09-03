/**
 * Dune REST helper for Q3 (protocol v1.2). Saved-query execution only — no raw SQL — so every number this
 * produces traces to a public query ID a third party can re-run with the same parameters.
 *   POST https://api.dune.com/api/v1/query/{id}/execute   {query_parameters, performance}  → {execution_id}
 *   GET  https://api.dune.com/api/v1/execution/{eid}/results                              → {state, result.rows}
 * Key: DUNE_API_KEY from .dev.vars or env. Local + CI only; never a Worker secret.
 */
import { devVar } from "./lib";
export type DuneRow = Record<string, unknown>;
export interface DuneRun { execution_id: string; rows: DuneRow[]; query_id: number }
const BASE = "https://api.dune.com/api/v1";
export function duneKey(): string | undefined { return devVar("DUNE_API_KEY"); }
export async function runDuneQuery(queryId: number, params: Record<string, string | number>, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<DuneRun> {
  const key = duneKey(); if (!key) throw new Error("DUNE_API_KEY not set");
  const f = opts.fetchImpl ?? fetch; const H = { "X-Dune-API-Key": key, "Content-Type": "application/json" };
  const ex = await f(`${BASE}/query/${queryId}/execute`, { method: "POST", headers: H, body: JSON.stringify({ query_parameters: params, performance: "medium" }) });
  if (!ex.ok) throw new Error(`dune execute HTTP ${ex.status}: ${(await ex.text()).slice(0, 200)}`);
  const { execution_id } = await ex.json() as { execution_id: string };
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000); let delay = 1500;
  while (Date.now() < deadline) {
    const rs = await f(`${BASE}/execution/${execution_id}/results`, { headers: H });
    if (!rs.ok) throw new Error(`dune results HTTP ${rs.status}`);
    const j = await rs.json() as { state: string; result?: { rows: DuneRow[] }; error?: unknown };
    if (j.state === "QUERY_STATE_COMPLETED") return { execution_id, rows: j.result?.rows ?? [], query_id: queryId };
    if (j.state === "QUERY_STATE_FAILED" || j.state === "QUERY_STATE_CANCELLED") throw new Error(`dune execution ${j.state}: ${JSON.stringify(j.error ?? "").slice(0, 200)}`);
    await new Promise(z => setTimeout(z, delay)); delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`dune execution ${execution_id} timed out`);
}
/** Output contract the price query MUST satisfy (one row). Column names are fixed here; the SQL adapts to them. */
export interface PriceRow { vwap: number; trade_count: number; volume_usdc: number; window_start: string; window_end: string }
export function asPriceRow(rows: DuneRow[]): PriceRow {
  if (rows.length !== 1) throw new Error(`price query must return exactly 1 row, got ${rows.length}`);
  const r = rows[0]; for (const k of ["vwap", "trade_count", "volume_usdc", "window_start", "window_end"]) if (!(k in r)) throw new Error(`price query row missing column '${k}'`);
  return { vwap: Number(r.vwap), trade_count: Number(r.trade_count), volume_usdc: Number(r.volume_usdc), window_start: String(r.window_start), window_end: String(r.window_end) };
}
