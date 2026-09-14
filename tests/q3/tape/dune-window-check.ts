/**
 * Pre-seal gate: is the Dune VWAP window SETTLED for this record yet?
 *
 * PROTOCOL v1.2.1 anchors a Polymarket record's VWAP window to posted_at and notes that
 * polymarket_polygon.market_trades indexes roughly an hour behind chain, so Phase B runs once the table has caught
 * up. "Caught up" has until now been a wall-clock guess. It should not be: a window that is only PARTIALLY indexed
 * still returns rows, so Phase B seals a VWAP computed over a subset of the trades, and the number changes the
 * moment the rest land. That price is then permanent, wrong, and — because q3-verify re-executes the same query on
 * every push — a build failure with no legitimate fix, since sealed records are immutable.
 *
 * This runs the committed public price query twice, `--gap` seconds apart, on the SAME parameters a Phase B seal
 * would use, and reports whether vwap, trade_count, volume_24h and volume_total are byte-identical across the two.
 * Identical across a gap means the window has stopped moving. It is a necessary condition, not a proof of
 * completeness — a long enough stall could fool it — which is why the gap is explicit and reported rather than
 * hidden. Committed per SCAN_SPEC §10.3: a gate nobody can test is not a gate.
 *
 *   npx tsx tests/q3/tape/dune-window-check.ts --record q3-2026-09-14-006 --gap 180
 *   npx tsx tests/q3/tape/dune-window-check.ts --token <id> --captured-at <iso> --gap 180
 *
 * Exit 0 = settled (safe to seal). Exit 1 = still moving, or no trades yet. Writes nothing, seals nothing.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { runDuneQuery, asPriceRow } from "../dune-client";

const args = process.argv.slice(2);
const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const REC_DIR = "tests/q3/records";

function findRecord(id: string): any | null {
  if (!existsSync(REC_DIR)) return null;
  for (const f of readdirSync(REC_DIR).filter(x => x.endsWith(".json"))) {
    const r = (JSON.parse(readFileSync(`${REC_DIR}/${f}`, "utf8")) as any[]).find(x => x.id === id);
    if (r) return r;
  }
  return null;
}

(async () => {
  const cfg = JSON.parse(readFileSync("tests/q3/dune.json", "utf8"));
  const win = Number(cfg.window_min ?? 60);
  let token = flag("--token"), capturedAt = flag("--captured-at");
  const rid = flag("--record");
  if (rid) {
    const r = findRecord(rid);
    if (!r) { console.error(`no record ${rid}`); process.exit(1); }
    if (r.market?.venue !== "polymarket") { console.error(`${rid} is venue "${r.market?.venue}" — this gate is for the Dune-priced Polymarket path only`); process.exit(1); }
    if (r.record_hash) { console.error(`${rid} is already sealed — nothing to gate`); process.exit(1); }
    token = String(r.market.token_id); capturedAt = String(r.posted_at);
  }
  if (!token || !capturedAt) { console.error("usage: --record <id> | --token <id> --captured-at <iso>   [--gap <seconds>]"); process.exit(1); }
  const gap = Number(flag("--gap") ?? 180);
  const qp = { token_id: token, captured_at: capturedAt, window_min: win };

  const shot = async (label: string) => {
    const run = await runDuneQuery(Number(cfg.price_query_id), qp);
    const pr = asPriceRow(run.rows);
    console.log(`  ${label}: vwap ${pr.vwap} · trades ${pr.trade_count} · vol24h ${pr.volume_24h} · volTotal ${pr.volume_total} · window ${pr.window_start} -> ${pr.window_end}`);
    return pr;
  };

  console.log(`window gate · token ${String(token).slice(0, 18)}… · captured_at ${capturedAt} · window ${win}min · gap ${gap}s`);
  const a = await shot("t0");
  if (!(a.trade_count > 0)) { console.error(`NOT SETTLED: zero trades in the window — the table has not reached ${capturedAt} yet. Do not seal.`); process.exit(1); }
  await new Promise(z => setTimeout(z, gap * 1000));
  const b = await shot(`t0+${gap}s`);

  const same = a.vwap === b.vwap && a.trade_count === b.trade_count && a.volume_24h === b.volume_24h && a.volume_total === b.volume_total;
  if (!same) {
    console.error(`STILL MOVING: the window changed across ${gap}s (trades ${a.trade_count} -> ${b.trade_count}). Dune is still indexing this range; sealing now would write a VWAP that re-execution cannot reproduce. Wait and re-run.`);
    process.exit(1);
  }
  console.log(`SETTLED — identical across ${gap}s (${b.trade_count} trades, vwap ${b.vwap}). Safe to seal.`);
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
