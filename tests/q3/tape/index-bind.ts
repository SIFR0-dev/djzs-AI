/** Use 4 — widen the bindable universe: Kalshi index/economics contracts (venue-direct, record-bearing) + equity tape from Surf (tape only).
 *  npx tsx tests/q3/tape/index-bind.ts [--q "S&P"] [--no-surf] */
import { CFG, surf, surfAvailable } from "./surf";
const a = process.argv.slice(2); const q = a.includes("--q") ? a[a.indexOf("--q") + 1] : "S&P"; const noSurf = a.includes("--no-surf");
(async () => {
  // venue-direct: Kalshi public API — this is the record-bearing side
  const SERIES = ["KXINX", "KXINXAB", "KXSPXFOMC", "NASDAQ100W", "KXINXHIGH"]; // Kalshi index series (financials) — venue-direct, record-bearing
  const ms: any[] = []; for (const st of SERIES) { const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${st}&status=open&limit=50`); const j = await r.json() as any; for (const m of j.markets ?? []) ms.push(m); }
  ms.sort((x: any, y: any) => Number(y.volume_24h_fp ?? y.volume_24h ?? 0) - Number(x.volume_24h_fp ?? x.volume_24h ?? 0)); ms.splice(10);
  console.log(`KALSHI INDEX CONTRACTS (venue-direct · open · by 24h volume) — record-bearing tickers`); for (const m of ms) console.log(`  ${m.ticker.padEnd(30)} yes ${m.yes_bid_dollars}/${m.yes_ask_dollars}  vol24h ${m.volume_24h_fp ?? m.volume_24h}  ${m.title.slice(0, 70)}`); if (!ms.length) console.log("  (none matched — try --q with the series name; Kalshi index series tickers vary)");
  if (noSurf || !surfAvailable()) { console.log("tape: skipped (--no-surf or surf not on PATH)"); return; }
  // tape: Surf discovery of the same category + SPY candles for the card's tape line
  try { const s = surf("search-prediction-market", ["--platform", "kalshi", "--category", "financials", "--q", q, "--status", "active", "--limit", "5"]); console.log(`SURF DISCOVERY · kalshi financials · q="${q}"`); for (const m of s.data) console.log(`  ${String(m.market_ticker).padEnd(30)} p ${m.latest_price ?? "?"}  oi ${Math.round(m.open_interest_usd)}  ${m.question.slice(0, 60)}`); } catch (e) { console.log("surf discovery:", (e as Error).message.slice(0, 120)); }
  try { const c = surf("equity-candles", ["--symbol", "SPY", "--interval", "day"]); const rows = Array.isArray(c.data) ? c.data : c.data?.candles ?? []; const last = rows[rows.length - 1] ?? rows[0]; console.log(`TAPE · SPY last candle: ${JSON.stringify(last).slice(0, 160)}`); } catch (e) { console.log("equity tape:", (e as Error).message.slice(0, 120)); }
})();
