// Live read-only smoke vs the Kalshi DEMO env. No auth, no key, no orders.
//   node --experimental-strip-types probe-live.ts
import { KalshiPublicClient, KALSHI_DEMO_HOST } from "./kalshi-rest.ts";
import { formatPriceE4 } from "./fixed.ts";

const c = new KalshiPublicClient(KALSHI_DEMO_HOST);

const { markets } = await c.getMarkets({ limit: 20, status: "open" });
if (markets.length === 0) throw new Error("demo env returned zero open markets");
console.log(`markets: ${markets.length} open, first=${markets[0]!.ticker}`);

// prefer a market with a live bid so the orderbook exercise is non-trivial
const pick =
  markets.find((m) => m.yes_bid_dollars && m.yes_bid_dollars !== "0.0000") ?? markets[0]!;
const ob = await c.getOrderbook(pick.ticker, 5);
const best = ob.yes[ob.yes.length - 1];
console.log(
  `orderbook ${pick.ticker}: yes levels=${ob.yes.length} no levels=${ob.no.length}` +
    (best ? ` best_yes=${formatPriceE4(best.priceE4)}` : ""),
);

const { trades } = await c.getTrades({ limit: 5 });
console.log(
  `trades: ${trades.length} recent` +
    (trades[0] ? `, last taker=${trades[0].taker_side} @ ${trades[0].yes_price_dollars}` : ""),
);

console.log("PROBE_OK");
