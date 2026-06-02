// DJZS-PM trade-mechanics gate.
// Pure deterministic verification layer for PREDICTION MARKETS (Limitless first).
// No network, no side effects. evaluate(intent, marketState) -> Verdict.
// Same inputs => same verdict, always. Order matters: first failure short-circuits.
//
// This is the trade-mechanics complement to the thesis audit in
// server/prediction-audit.ts. The thesis audit judges whether an ARGUMENT is sound;
// this gate judges whether the TRADE is sound (edge, liquidity, fees, sizing,
// resolution risk). A market order should forward only if BOTH pass.

export type Outcome = "YES" | "NO";

export interface PMTradeIntent {
  marketSlug: string;
  outcome: Outcome; // which side you're buying
  // priceProb: share price as a probability, 0.01..0.99 (the market's IMPLIED prob of `outcome`).
  priceProb: number;
  // modelProb: YOUR estimated probability that `outcome` resolves true, 0..1.
  // This is the ONLY non-deterministic input — supplied by the probabilistic layer
  // (server/claude-client.ts or server/venice.ts).
  modelProb: number;
  sizeUsd: number; // intended notional (USDC) to deploy
}

export interface PMMarketState {
  accountEquityUsd: number;
  resolutionObjective: boolean; // source is objective/trusted (oracle, official print), not discretionary
  hoursToResolution: number;
  bookDepthUsd: number; // resting liquidity at/near the intended price on the side you'd take
  feeBps: number; // round-trip fee in basis points
  realizedLossTodayUsd: number; // positive number = loss taken today
}

export interface PMGateResult {
  pass: boolean;
  code: string;
  reason: string;
}

export interface PMVerdict {
  decision: "PASS" | "REJECT";
  failedGate?: string;
  reason?: string;
  edge?: number; // signed edge in your favor (probability points)
  evPerShare?: number; // expected value per $1 share, net of fees
  maxLossUsd?: number; // structural worst case on this position
  results: PMGateResult[];
}

// --- Tunables (kept consistent with the GRVT perp gate where it makes sense) ---
export const PM_FUNDING_FLOOR = 2000;
export const PM_MIN_EDGE = 0.05;
export const PM_MIN_NET_EV_PER_SHARE = 0.02;
export const PM_MIN_DEPTH_MULT = 2;
export const PM_MIN_HOURS_TO_RES = 0.25;
export const PM_MAX_HOURS_TO_RES = 24 * 14;
export const PM_MAX_POSITION_FRACTION = 0.1;
export const PM_DAILY_LOSS_CAP = 100;

function edgeOf(intent: PMTradeIntent): number {
  return intent.modelProb - intent.priceProb;
}

export function evaluatePMTrade(intent: PMTradeIntent, m: PMMarketState): PMVerdict {
  const results: PMGateResult[] = [];
  const edge = edgeOf(intent);
  const feeFraction = m.feeBps / 10_000;
  const evPerShare = edge - feeFraction;
  const maxLossUsd = intent.sizeUsd * intent.priceProb;

  const gates: PMGateResult[] = [
    {
      code: "FUNDING_GATE",
      pass: m.accountEquityUsd >= PM_FUNDING_FLOOR,
      reason: `equity $${m.accountEquityUsd} ${m.accountEquityUsd >= PM_FUNDING_FLOOR ? ">=" : "<"} $${PM_FUNDING_FLOOR} floor`,
    },
    {
      code: "PRICE_SANITY",
      pass: intent.priceProb > 0 && intent.priceProb < 1 && intent.modelProb >= 0 && intent.modelProb <= 1,
      reason:
        intent.priceProb > 0 && intent.priceProb < 1
          ? "price within $0.01-$0.99 band"
          : `price ${intent.priceProb} outside tradable band`,
    },
    {
      code: "EDGE",
      pass: edge >= PM_MIN_EDGE,
      reason: `edge ${(edge * 100).toFixed(1)}pts ${edge >= PM_MIN_EDGE ? ">=" : "<"} ${(PM_MIN_EDGE * 100).toFixed(0)}pts (model ${(intent.modelProb * 100).toFixed(0)}% vs price ${(intent.priceProb * 100).toFixed(0)}%)`,
    },
    {
      code: "RESOLUTION_RISK",
      pass: m.resolutionObjective,
      reason: m.resolutionObjective ? "objective resolution source" : "subjective/discretionary resolution — unpriceable",
    },
    {
      code: "HORIZON",
      pass: m.hoursToResolution >= PM_MIN_HOURS_TO_RES && m.hoursToResolution <= PM_MAX_HOURS_TO_RES,
      reason: `${m.hoursToResolution.toFixed(2)}h to resolution; window [${PM_MIN_HOURS_TO_RES}h, ${PM_MAX_HOURS_TO_RES}h]`,
    },
    {
      code: "LIQUIDITY",
      pass: m.bookDepthUsd >= intent.sizeUsd * PM_MIN_DEPTH_MULT,
      reason: `book $${m.bookDepthUsd.toFixed(0)} vs ${PM_MIN_DEPTH_MULT}x size $${(intent.sizeUsd * PM_MIN_DEPTH_MULT).toFixed(0)} needed`,
    },
    {
      code: "FEE_DRAG",
      pass: evPerShare >= PM_MIN_NET_EV_PER_SHARE,
      reason: `net EV ${(evPerShare * 100).toFixed(1)}c/share ${evPerShare >= PM_MIN_NET_EV_PER_SHARE ? ">=" : "<"} ${(PM_MIN_NET_EV_PER_SHARE * 100).toFixed(0)}c after ${m.feeBps}bps fees`,
    },
    {
      code: "SIZING",
      pass: intent.sizeUsd > 0 && intent.sizeUsd <= m.accountEquityUsd * PM_MAX_POSITION_FRACTION,
      reason: `size $${intent.sizeUsd} vs cap $${(m.accountEquityUsd * PM_MAX_POSITION_FRACTION).toFixed(0)} (${PM_MAX_POSITION_FRACTION * 100}% of equity)`,
    },
    {
      code: "DAILY_CAP",
      pass: m.realizedLossTodayUsd < PM_DAILY_LOSS_CAP,
      reason: `today's loss $${m.realizedLossTodayUsd} ${m.realizedLossTodayUsd < PM_DAILY_LOSS_CAP ? "<" : ">="} $${PM_DAILY_LOSS_CAP} cap`,
    },
  ];

  for (const g of gates) {
    results.push(g);
    if (!g.pass) {
      return { decision: "REJECT", failedGate: g.code, reason: g.reason, edge, evPerShare, maxLossUsd, results };
    }
  }

  return { decision: "PASS", edge, evPerShare, maxLossUsd, results };
}
