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

  // THE GATE MUST NOT BE STRICTER THAN THE VERIFIER IT PROTECTS. Its whole job is to predict whether q3-verify's
  // re-execution will agree with the sealed number, so it has to compare the way q3-verify compares. Two runs of the
  // same query over the same settled rows can differ in the last ulp purely from float summation ORDER — observed
  // live on the first use of this gate: identical vwap and trade_count, volumes differing at 1e-9 relative
  // (4803260.124947 vs 4803260.124946999). A strict === there reports "still moving" forever on a window that has
  // completely stopped, which would block Phase B permanently on a false signal. So: trade_count exact (a row either
  // is indexed or is not, and a changing count is the real signal of a moving window), vwap within dune.json's own
  // price_tolerance, volumes within q3-verify's volClose — the same two tolerances the verifier applies, and for the
  // same stated reason: they cover summation order, never drift.
  const volClose = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.01, 1e-9 * Math.max(Math.abs(x), Math.abs(y)));
  const tol = Number(cfg.price_tolerance ?? 1e-9);
  const num = (x: number | null | undefined, y: number | null | undefined) =>
    (x == null || y == null) ? x === y : volClose(x, y);
  const countMoved = a.trade_count !== b.trade_count;
  const vwapMoved = !(Math.abs(a.vwap - b.vwap) <= tol);
  const volMoved = !num(a.volume_24h, b.volume_24h) || !num(a.volume_total, b.volume_total);
  if (countMoved || vwapMoved || volMoved) {
    const why = [countMoved && `trade_count ${a.trade_count} -> ${b.trade_count}`,
                 vwapMoved && `vwap ${a.vwap} -> ${b.vwap} (> price_tolerance ${tol})`,
                 volMoved && `volumes moved beyond volClose`].filter(Boolean).join("; ");
    console.error(`STILL MOVING: the window changed across ${gap}s — ${why}. Dune is still indexing this range; sealing now would write a VWAP that re-execution cannot reproduce. Wait and re-run.`);
    process.exit(1);
  }
  console.log(`SETTLED — stable across ${gap}s (${b.trade_count} trades, vwap ${b.vwap}); volumes agree within the same tolerance q3-verify applies. Safe to seal.`);
})().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
