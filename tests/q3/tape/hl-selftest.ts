/** hl-client self-test: every read, live, unauthenticated, zero credits. */
import { hlMarket, hlMarkets, hlFunding, hlBook, hlCandles, hlUserFills, hlClearinghouse, HL_TIER } from "./hl-client";
(async () => {
  let ok = true; const check = (c: boolean, m: string) => { console.log(`${c ? "ok " : "BAD"} ${m}`); ok &&= c; };
  const all = await hlMarkets(); check(all.size > 100, `markets: ${all.size} perps`);
  const b = await hlMarket("BTC");
  check(b.mark > 1000 && b.oracle > 1000, `BTC mark ${b.mark.toLocaleString()} · oracle ${b.oracle.toLocaleString()}`);
  check(Math.abs(b.funding_annual - b.funding_hourly * 8760) < 1e-9, `funding hourly ${(b.funding_hourly * 100).toFixed(6)}%/h → ${(b.funding_annual * 100).toFixed(2)}%/yr · 8h form ${(b.funding_8h * 100).toFixed(4)}%`);
  check(b.open_interest_usd > 0, `OI ${b.open_interest_base.toLocaleString()} BTC = $${(b.open_interest_usd / 1e6).toFixed(0)}M · 24h $${(b.day_notional_volume / 1e9).toFixed(2)}B · maxLev ${b.max_leverage}x`);
  const f = await hlFunding("BTC", 24);
  check(f.rows.length >= 12, `funding history ${f.rows.length} hourly points · mean ${(f.mean_annual * 100).toFixed(2)}%/yr · $${f.paid_per_1k_notional_over_window.toFixed(2)} per $1k over 24h`);
  const k = await hlBook("BTC");
  check(k.ask > k.bid && k.spread_bps < 100, `book ${k.bid.toLocaleString()}/${k.ask.toLocaleString()} · ${k.spread_bps.toFixed(2)} bps · depth $${(k.bid_depth_usd / 1e3).toFixed(0)}k/$${(k.ask_depth_usd / 1e3).toFixed(0)}k`);
  const c = await hlCandles("BTC", "1h", Date.now() - 6 * 3_600_000);
  check(c.length >= 3, `candles ${c.length}×1h · last close ${c.at(-1)?.close.toLocaleString()}`);
  const empty = await hlUserFills("0x0000000000000000000000000000000000000001");
  check(Array.isArray(empty), `userFills reachable unauthenticated (${empty.length} fills for the null address)`);
  const ch = await hlClearinghouse("0x0000000000000000000000000000000000000001");
  check(Array.isArray(ch.positions), `clearinghouseState reachable (${ch.positions.length} positions)`);
  check(HL_TIER.credits === 0, `tier ${HL_TIER.tier} · ${HL_TIER.provider} · ${HL_TIER.credits} credits`);
  console.log(ok ? "HL CLIENT SELF-TEST PASS" : "HL CLIENT SELF-TEST FAIL"); if (!ok) process.exit(1);
})();
