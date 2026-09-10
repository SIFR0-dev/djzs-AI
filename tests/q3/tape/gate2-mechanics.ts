/** Use 5 — Gate 2 mechanics for the audit-gate skill. MECHANICS ONLY: liquidation, buffers, R:R, funding cost. Says nothing about whether the thesis is sound — that is Gate 1 (the engine).
 *  npx tsx tests/q3/tape/gate2-mechanics.ts --pair BTC/USDT --side short --entry 77481.55 --notional 3000 --leverage 10 --stop 79800 --tp 73000 [--mmr 0.005] [--exchange binance|hyperliquid]
 *  --exchange hyperliquid reads the venue direct (public info API, no key, 0 credits) and adds oracle, realised funding, spread, book depth and the venue leverage cap. */
import { surf, CFG, pct } from "./surf";
import { hlMarket, hlFunding, hlBook } from "./hl-client";
const a = process.argv.slice(2); const flag = (f: string, d?: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
const pair = flag("--pair", `BTC/${CFG.perp_reference.quote}`)!, ex = flag("--exchange", CFG.perp_reference.exchange)!, side = flag("--side")!.toLowerCase(), entry = Number(flag("--entry")), notional = Number(flag("--notional")), lev = Number(flag("--leverage")), stop = Number(flag("--stop")), tp = flag("--tp") ? Number(flag("--tp")) : NaN, mmr = Number(flag("--mmr", "0.005"));
if (!["long", "short"].includes(side) || ![entry, notional, lev, stop].every(Number.isFinite)) { console.error("need --side long|short --entry --notional --leverage --stop"); process.exit(1); }
// ── async: venue-direct reads are awaited ──
(async () => {
const isHL = ex.toLowerCase() === "hyperliquid";
// Hyperliquid is read VENUE-DIRECT (its own public info API: no key, no credits). Everything else goes
// through the Surf tape tier. Note HL charges funding HOURLY — it is normalised to the 8h form used below.
const hl = isHL ? await (async () => {
  const coin = pair.split("/")[0].toUpperCase();
  const [m, fh, bk] = await Promise.all([hlMarket(coin), hlFunding(coin, 24).catch(() => null), hlBook(coin).catch(() => null)]);
  return { coin, m, fh, bk };
})() : null;
const snap = isHL ? null : surf("exchange-perp", ["--exchange", ex, "--pair", pair]);
const d = isHL ? {} : (Array.isArray(snap!.data) ? snap!.data[0] : snap!.data);
const f = isHL ? {} : (d.funding ?? {});
const mark = isHL ? hl!.m.mark : (f.mark_price ?? f.index_price ?? d.mark_price ?? null);
const dir = side === "long" ? 1 : -1; const size = notional / entry; const margin = notional / lev;
const liq = side === "long" ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
const stopAdverse = dir * (stop - entry) < 0; const lossAtStop = Math.abs(stop - entry) * size; const gainAtTp = Number.isFinite(tp) ? Math.abs(tp - entry) * size : NaN;
const bufferStopToLiq = Math.abs(liq - stop) / stop; const rr = Number.isFinite(gainAtTp) ? gainAtTp / lossAtStop : NaN;
const f8 = isHL ? hl!.m.funding_8h : (f.funding_rate_8h ?? f.funding_rate ?? null); const fundPer8h = f8 != null ? -dir * f8 * notional : null; // longs pay positive funding
const out = { pair, exchange: ex, side, entry, mark, mark_vs_entry: mark ? pct(mark / entry - 1) : null, size_base: +size.toFixed(6), initial_margin_usd: +margin.toFixed(2), liquidation_price: +liq.toFixed(2), stop, stop_is_adverse: stopAdverse, stop_to_liq_buffer: pct(bufferStopToLiq), max_loss_at_stop_usd: +lossAtStop.toFixed(2), max_loss_pct_of_margin: pct(lossAtStop / margin), take_profit: Number.isFinite(tp) ? tp : null, target_profit_usd: Number.isFinite(gainAtTp) ? +gainAtTp.toFixed(2) : null, rr: Number.isFinite(rr) ? +rr.toFixed(2) : null, funding_8h_rate: f8, funding_annualized: isHL ? +(hl!.m.funding_annual * 100).toFixed(2) + "%" : (f.funding_annualized ?? f.funding_rate_annualized ?? null), funding_usd_per_8h: fundPer8h != null ? +fundPer8h.toFixed(2) : null, funding_usd_per_day: fundPer8h != null ? +(fundPer8h * 3).toFixed(2) : null, funding_direction: fundPer8h == null ? null : fundPer8h >= 0 ? `${side} RECEIVES` : `${side} PAYS`, open_interest_usd: isHL ? +hl!.m.open_interest_usd.toFixed(0) : (d.open_interest?.open_interest_usd ?? d.open_interest_usd ?? null), mmr_assumed: mmr, next_funding: f.next_funding ?? null,
  source: isHL ? { tier: "venue-direct", provider: "hyperliquid-api", credits: 0 } : { tier: "tape", provider: "surf", credits: 1 },
  ...(isHL ? { hl_oracle_price: hl!.m.oracle, hl_mark_vs_oracle: pct(hl!.m.mark / hl!.m.oracle - 1, 3), hl_funding_realised_24h_annual: pct(hl!.fh?.mean_annual ?? NaN), hl_funding_usd_per_1k_24h: hl!.fh ? +hl!.fh.paid_per_1k_notional_over_window.toFixed(2) : null, hl_spread_bps: hl!.bk ? +hl!.bk.spread_bps.toFixed(2) : null, hl_book_depth_usd_5: hl!.bk ? { bid: +hl!.bk.bid_depth_usd.toFixed(0), ask: +hl!.bk.ask_depth_usd.toFixed(0) } : null, hl_venue_max_leverage: hl!.m.max_leverage, hl_24h_notional_volume: +hl!.m.day_notional_volume.toFixed(0) } : {}) };
const flags: string[] = []; if (!stopAdverse) flags.push("stop is on the profit side of entry — not a stop"); if (bufferStopToLiq < 0.05) flags.push(`stop→liquidation buffer ${pct(bufferStopToLiq)} < 5% — a wick through the stop can liquidate`); if (lossAtStop / margin > 0.5) flags.push(`stop risks ${pct(lossAtStop / margin)} of margin`); if (Number.isFinite(rr) && rr < 1.5) flags.push(`R:R ${rr.toFixed(2)} < 1.5`); if (mark && Math.abs(mark / entry - 1) > 0.01) flags.push(`entry is ${pct(entry / mark - 1)} from current mark — stale entry`);
if (isHL && lev > hl!.m.max_leverage) flags.push(`leverage ${lev}x exceeds the venue's max ${hl!.m.max_leverage}x for ${hl!.coin} — the order will be rejected or capped`);
if (isHL && hl!.bk) { const side_depth = side === "long" ? hl!.bk.ask_depth_usd : hl!.bk.bid_depth_usd; if (notional > side_depth) flags.push(`notional ${notional.toLocaleString()} exceeds top-5 book depth on the fill side (${Math.round(side_depth).toLocaleString()}) — expect slippage beyond the quoted spread`); }
console.log(`GATE 2 · MECHANICS ONLY — this is not a verdict on the thesis. Gate 1 (the engine) decides whether a reason exists.\n${JSON.stringify(out, null, 2)}\nFLAGS: ${flags.length ? "\n  - " + flags.join("\n  - ") : "none"}\nliquidation uses isolated-margin approximation with mmr=${mmr}; confirm against the venue's tier table before relying on it.`);
})();
