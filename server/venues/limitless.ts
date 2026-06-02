// Limitless venue adapter for the DJZS-PM signal surface.
// READS (markets, orderbook) are public — no auth. EXECUTION (EIP-712 signing +
// order submit) needs a scoped HMAC token + a Base signing key, kept on the relay
// box, never in this repo. See documents/DJZS/engineering/2026-06-01_Limitless_App_Integration.md
//
// Base URL: https://api.limitless.exchange | Chain: Base 8453 | USDC 6 decimals.

import type { Outcome, PMMarketState, PMTradeIntent } from "@shared/pm-gate";

const API = process.env.LIMITLESS_API_URL ?? "https://api.limitless.exchange";
const USDC_DECIMALS = 6;

export interface OrderbookLevel { price: number; size: number; side: "BUY" | "SELL" }
export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  tokenId: string;
  midpoint: number;
  adjustedMidpoint: number;
  lastTradePrice: number;
  maxSpread: string;
  minSize: string;
}
// Structured oracle metadata Limitless attaches to each automated market. This is
// the SOURCE OF TRUTH for how a market resolves — read this, not the prose
// description. chartSource names the oracle ("pyth", "chainlink", ...) and the
// *Address / *FeedId fields carry the on-chain feed when present.
export interface PriceOracleMetadata {
  ticker?: string;
  assetType?: string; // CRYPTO | COMMODITIES | ...
  chartSource?: string; // "pyth" | "chainlink" | etc.
  pythAddress?: string | null;
  chainlinkFeedId?: string | null;
  chainlinkFeedAddress?: string | null;
}
export interface MarketDetail {
  slug: string;
  title: string;
  venue: { exchange: string; adapter: string | null };
  positionIds: [string, string] | null;
  prices: [number, number]; // [YES, NO] implied
  tradeType: string; // "clob" | "amm"
  expirationTimestamp: number; // ms epoch
  description?: string;
  automationType?: string; // "lumy" => oracle-automated resolution
  priceOracleMetadata?: PriceOracleMetadata | null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`Limitless ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export async function getActiveSlugs(): Promise<{ slug: string; deadline: string }[]> {
  return get(`/markets/active/slugs`);
}

export async function getMarket(slug: string): Promise<MarketDetail> {
  const d: any = await get(`/markets/${slug}`);
  return {
    slug: d.slug,
    title: d.title,
    venue: d.venue,
    positionIds: d.positionIds ?? d.position_ids ?? null,
    prices: d.prices,
    tradeType: d.tradeType,
    expirationTimestamp: d.expirationTimestamp,
    description: d.description,
    automationType: d.automationType,
    priceOracleMetadata: d.priceOracleMetadata ?? null,
  };
}

export async function getOrderbook(slug: string): Promise<Orderbook> {
  return get(`/markets/${slug}/orderbook`);
}

// USDC-denominated depth available to a taker buying `outcome`, counting only
// levels within `band` of the midpoint (ignores the wide 0.001/0.999 walls).
export function bookDepthUsd(ob: Orderbook, outcome: Outcome, band = 0.15): number {
  const levels = outcome === "YES" ? ob.asks : ob.bids;
  const mid = ob.adjustedMidpoint || ob.midpoint;
  let usd = 0;
  for (const lvl of levels) {
    if (Math.abs(lvl.price - mid) > band) continue;
    const shares = lvl.size / 10 ** USDC_DECIMALS;
    usd += shares * lvl.price;
  }
  return usd;
}

// Is this market's resolution OBJECTIVE (decided by a trusted price oracle)?
// Parse the STRUCTURED oracle field first — never rely on the prose description.
// The old prose regex false-rejected oracle markets whose description does not name
// the oracle (e.g. a Chainlink/Pyth market that just says "the official settlement
// price"). A market is objective if it carries a recognised oracle source or a
// concrete on-chain feed address; prose is kept only as a last-resort fallback.
const OBJECTIVE_ORACLES = new Set(["pyth", "chainlink", "chainlink data stream", "data stream", "redstone", "uma"]);
export function resolutionLooksObjective(market: MarketDetail): boolean {
  const o = market.priceOracleMetadata;
  if (o) {
    const source = (o.chartSource ?? "").trim().toLowerCase();
    if (source && OBJECTIVE_ORACLES.has(source)) return true;
    if (o.pythAddress || o.chainlinkFeedAddress || o.chainlinkFeedId) return true;
  }
  // Fallback: prose hints, for markets the API exposes without structured oracle metadata.
  const text = (market.description ?? "").toLowerCase();
  return /chainlink|data stream|oracle|official|pyth|coingecko|resolution source/.test(text);
}

// Map live market data + the probabilistic layer's modelProb into gate inputs.
export function toGateInputs(args: {
  market: MarketDetail;
  ob: Orderbook;
  outcome: Outcome;
  modelProb: number;
  sizeUsd: number;
  accountEquityUsd: number;
  feeBps: number;
  realizedLossTodayUsd: number;
  now?: number;
}): { intent: PMTradeIntent; state: PMMarketState } {
  const { market, ob, outcome, modelProb, sizeUsd } = args;
  const mid = ob.adjustedMidpoint || ob.midpoint;
  const priceProb = outcome === "YES" ? mid : 1 - mid;
  const hoursToResolution = (market.expirationTimestamp - (args.now ?? Date.now())) / 3_600_000;
  return {
    intent: { marketSlug: market.slug, outcome, priceProb, modelProb, sizeUsd },
    state: {
      accountEquityUsd: args.accountEquityUsd,
      resolutionObjective: resolutionLooksObjective(market),
      hoursToResolution,
      bookDepthUsd: bookDepthUsd(ob, outcome),
      feeBps: args.feeBps,
      realizedLossTodayUsd: args.realizedLossTodayUsd,
    },
  };
}

// ---- Execution (NOT wired — needs creds) ----
// Mirrors the Limitless TS quickstart: sign an EIP-712 Order, POST /orders with
// scoped HMAC headers. Left as a typed stub so wiring it is a fill-in, not a rewrite.
// EIP-712 domain: { name: "Limitless CTF Exchange", version: "1", chainId: 8453,
//                   verifyingContract: market.venue.exchange }
export async function submitOrder(): Promise<never> {
  throw new Error(
    "Limitless submitOrder not wired: provide a scoped HMAC token + Base signing key (kept on the relay box) first."
  );
}
