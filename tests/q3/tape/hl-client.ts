/**
 * Hyperliquid venue-direct client — public `info` API, unauthenticated, no key, no credits.
 *
 * Tier: VENUE-DIRECT. Same class as tests/q3/kalshi-client.ts (protocol v1.3.1), not the Surf tape tier:
 * this is the venue's own record of its own book, so it may back Gate 2 mechanics for Hyperliquid
 * positions and, if a perp outcome study is ever pre-registered, price and settlement for HL-bound
 * records. It is NOT a substitute for Binance/Coinbase data: HL funding, mark and depth describe HL
 * only. Never call this from the deterministic engine — the engine stays network-independent.
 *
 * Endpoint: POST https://api.hyperliquid.xyz/info  {"type": ...}
 */
const URL_INFO = "https://api.hyperliquid.xyz/info";

async function info<T = any>(body: Record<string, unknown>, tries = 3): Promise<T> {
  let last = "";
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(URL_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) return (await r.json()) as T;
      last = `HTTP ${r.status}`;
      if (r.status < 500 && r.status !== 429) break; // client error: retrying will not help
    } catch (e) {
      last = (e as Error).message;
    }
    if (t < tries) await new Promise((s) => setTimeout(s, 800 * t)); // polite: HL rate-limits by IP weight
  }
  throw new Error(`hyperliquid info ${JSON.stringify(body.type)} failed — ${last}`);
}

export interface HlMarket {
  coin: string;
  mark: number;
  oracle: number;
  mid: number | null;
  prev_day: number | null;
  /** Funding is charged HOURLY on Hyperliquid, not 8-hourly. Both forms given; do not confuse them. */
  funding_hourly: number;
  funding_8h: number;
  funding_annual: number;
  premium: number | null;
  open_interest_base: number;
  open_interest_usd: number;
  day_notional_volume: number;
  max_leverage: number;
  sz_decimals: number;
}

/** Every perpetual market with its context: mark, oracle, funding, OI, 24h notional. One call. */
export async function hlMarkets(): Promise<Map<string, HlMarket>> {
  const [meta, ctxs] = await info<[{ universe: any[] }, any[]]>({ type: "metaAndAssetCtxs" });
  const m = new Map<string, HlMarket>();
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c) return;
    const hourly = Number(c.funding);
    const mark = Number(c.markPx);
    const oi = Number(c.openInterest);
    m.set(u.name, {
      coin: u.name,
      mark,
      oracle: Number(c.oraclePx),
      mid: c.midPx == null ? null : Number(c.midPx),
      prev_day: c.prevDayPx == null ? null : Number(c.prevDayPx),
      funding_hourly: hourly,
      funding_8h: hourly * 8,
      funding_annual: hourly * 24 * 365,
      premium: c.premium == null ? null : Number(c.premium),
      open_interest_base: oi,
      open_interest_usd: oi * mark,
      day_notional_volume: Number(c.dayNtlVlm),
      max_leverage: Number(u.maxLeverage),
      sz_decimals: Number(u.szDecimals),
    });
  });
  return m;
}

export async function hlMarket(coin: string): Promise<HlMarket> {
  const m = (await hlMarkets()).get(coin.toUpperCase());
  if (!m) throw new Error(`hyperliquid: no perp market "${coin}"`);
  return m;
}

/** Realised funding over a window, from the venue's own history. Mean hourly + annualised. */
export async function hlFunding(coin: string, hours = 24): Promise<{
  rows: { time: number; rate: number; premium: number | null }[];
  mean_hourly: number;
  mean_annual: number;
  paid_per_1k_notional_over_window: number;
}> {
  const startTime = Date.now() - hours * 3_600_000;
  const raw = await info<any[]>({ type: "fundingHistory", coin: coin.toUpperCase(), startTime });
  const rows = raw.map((r) => ({ time: Number(r.time), rate: Number(r.fundingRate), premium: r.premium == null ? null : Number(r.premium) }));
  if (!rows.length) return { rows, mean_hourly: NaN, mean_annual: NaN, paid_per_1k_notional_over_window: NaN };
  const sum = rows.reduce((s, r) => s + r.rate, 0);
  const mean = sum / rows.length;
  return { rows, mean_hourly: mean, mean_annual: mean * 24 * 365, paid_per_1k_notional_over_window: sum * 1000 };
}

/** Top-of-book and depth — the inputs to spread and slippage, which Gate 2 reports and never scores. */
export async function hlBook(coin: string, levels = 5): Promise<{
  bid: number; ask: number; mid: number; spread_bps: number;
  bid_depth_usd: number; ask_depth_usd: number; levels: number;
}> {
  const d = await info<{ levels: [any[], any[]] }>({ type: "l2Book", coin: coin.toUpperCase() });
  const [bids, asks] = d.levels;
  if (!bids?.length || !asks?.length) throw new Error(`hyperliquid: empty book for ${coin}`);
  const bid = Number(bids[0].px), ask = Number(asks[0].px), mid = (bid + ask) / 2;
  const depth = (side: any[]) => side.slice(0, levels).reduce((s, l) => s + Number(l.px) * Number(l.sz), 0);
  return { bid, ask, mid, spread_bps: ((ask - bid) / mid) * 10_000, bid_depth_usd: depth(bids), ask_depth_usd: depth(asks), levels: Math.min(levels, bids.length) };
}

/** OHLCV. interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d" … */
export async function hlCandles(coin: string, interval: string, startMs: number, endMs = Date.now()) {
  const raw = await info<any[]>({ type: "candleSnapshot", req: { coin: coin.toUpperCase(), interval, startTime: startMs, endTime: endMs } });
  return raw.map((c) => ({ t: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) }));
}

/**
 * Per-wallet fills — the outcome half of a perp calibration dataset (handoff §15/§16).
 * Public and unauthenticated: any address, no key. Pair with a PUBLICLY STATED, timestamped thesis;
 * fills alone are outcomes without reasoning, which is the half DJZS does not audit.
 */
export async function hlUserFills(address: string) {
  const raw = await info<any[]>({ type: "userFills", user: address });
  return raw.map((f) => ({
    time: Number(f.time), coin: f.coin, side: f.side, dir: f.dir,
    price: Number(f.px), size: Number(f.sz), fee: Number(f.fee ?? 0),
    closed_pnl: f.closedPnl == null ? null : Number(f.closedPnl),
    start_position: f.startPosition == null ? null : Number(f.startPosition),
    liquidation: Boolean(f.liquidation), hash: f.hash, oid: f.oid,
  }));
}

/** Current positions and margin for an address — leverage actually used, unrealised PnL, liq price. */
export async function hlClearinghouse(address: string) {
  const d = await info<any>({ type: "clearinghouseState", user: address });
  return {
    account_value: Number(d.marginSummary?.accountValue ?? 0),
    total_notional: Number(d.marginSummary?.totalNtlPos ?? 0),
    withdrawable: Number(d.withdrawable ?? 0),
    positions: (d.assetPositions ?? []).map((p: any) => ({
      coin: p.position.coin,
      size: Number(p.position.szi),
      entry: p.position.entryPx == null ? null : Number(p.position.entryPx),
      leverage: Number(p.position.leverage?.value ?? 0),
      leverage_type: p.position.leverage?.type ?? null,
      liquidation_price: p.position.liquidationPx == null ? null : Number(p.position.liquidationPx),
      unrealized_pnl: Number(p.position.unrealizedPnl ?? 0),
      margin_used: Number(p.position.marginUsed ?? 0),
    })),
  };
}

export const HL_TIER = { tier: "venue-direct", provider: "hyperliquid-api", endpoint: URL_INFO, credits: 0 } as const;
