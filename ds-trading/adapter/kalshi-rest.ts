// Kalshi trade-api v2 — read-only public-data client.
// Workers-native: plain fetch, no Node APIs. No auth — public market data only.
// Hosts are injected; never hardcode one (elections host is the working prod
// data host; api.kalshi.com is unreachable from some networks).

import { parsePriceE4, parseQtyE2 } from "./fixed.ts";

export const KALSHI_DEMO_HOST = "https://demo-api.kalshi.co/trade-api/v2";
export const KALSHI_PROD_DATA_HOST =
  "https://api.elections.kalshi.com/trade-api/v2";

export class KalshiApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`kalshi ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "KalshiApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

// 2026 API shape: all money fields are exact decimal STRINGS
// (yes_bid_dollars "0.9600", count_fp "1.99"). Legacy integer-cent fields
// are gone from the wire — verified live on demo + elections hosts 2026-08-21.
export interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  market_type: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  open_interest_fp: string;
  close_time: string;
  price_level_structure?: string;
  [k: string]: unknown;
}

/** Normalized level: price in e4 units ($0.0001), qty in e2 units (0.01 contracts). */
export interface Level {
  priceE4: number;
  qtyE2: number;
}

export interface Orderbook {
  yes: Level[];
  no: Level[];
}

/** Raw wire shape: {"orderbook_fp":{"yes_dollars":[["0.6100","400.00"],...],...}} */
interface OrderbookFpWire {
  orderbook_fp: {
    yes_dollars: Array<[string, string]> | null;
    no_dollars: Array<[string, string]> | null;
  };
}

export interface Trade {
  trade_id: string;
  ticker: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: string;
  created_time: string;
  [k: string]: unknown;
}

export interface MarketsPage {
  markets: Market[];
  cursor: string;
}

export interface TradesPage {
  trades: Trade[];
  cursor: string;
}

export class KalshiPublicClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new KalshiApiError(res.status, path, await res.text());
    }
    return (await res.json()) as T;
  }

  getMarkets(params?: {
    limit?: number;
    cursor?: string;
    event_ticker?: string;
    series_ticker?: string;
    status?: string;
  }): Promise<MarketsPage> {
    return this.get("/markets", params as Record<string, string | number>);
  }

  async getMarket(ticker: string): Promise<Market> {
    const r = await this.get<{ market: Market }>(
      `/markets/${encodeURIComponent(ticker)}`,
    );
    return r.market;
  }

  async getOrderbook(ticker: string, depth?: number): Promise<Orderbook> {
    const r = await this.get<OrderbookFpWire>(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      depth === undefined ? undefined : { depth },
    );
    const norm = (side: Array<[string, string]> | null | undefined): Level[] =>
      (side ?? []).map(([p, q]) => ({ priceE4: parsePriceE4(p), qtyE2: parseQtyE2(q) }));
    return {
      yes: norm(r.orderbook_fp?.yes_dollars),
      no: norm(r.orderbook_fp?.no_dollars),
    };
  }

  getTrades(params?: {
    ticker?: string;
    limit?: number;
    cursor?: string;
    min_ts?: number;
    max_ts?: number;
  }): Promise<TradesPage> {
    return this.get("/markets/trades", params as Record<string, string | number>);
  }
}
