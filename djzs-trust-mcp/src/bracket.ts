// A perp stop/target bracket is a binary bet on which level prints first.
// Dependency-free on purpose: this file drops into verify_perp_trade and evaluate.ts unchanged.
//
// Prices are integers in one unit of the caller's choosing: cents of the underlying, micro-dollars
// per contract, exchange ticks. The math is scale-free; only the unit must be the same everywhere.
// ds-price-gate uses micro-dollars per Kalshi contract, which keeps six significant digits from
// BTC down to XRP.
//
//   d     = |entry - stop|                    (stop distance, the unit of risk)
//   R     = |target - entry| / d
//   p0    = P(target first | no drift)        = |fair - stop| / |target - stop|
//           Optional stopping on a continuous martingale; equals 1/(1+R) when fair = entry.
//   gain  = |target - entry| - fee_in - fee_out(target)
//   loss  = d + fee_in + fee_out(stop) + exit impact
//   F     = expected funding paid over the hold, per unit (negative when received)
//   p*    = (loss + F) / (gain + loss)        break-even hit rate
//           With the same cost c (in units of d) on both outcomes this is (1 + c) / (1 + R).
//
// R changes the payoff's shape, never its expectation: at p = p0 the bracket's EV is minus its costs
// whatever R is, so an RR rule alone cannot create an edge. A thesis has one only if it claims, with a
// basis, a hit rate above p*.
//
// Integer prices in, integer e4 probabilities out. Model floats (volatility, funding rate) are
// quantized before they reach the money path.

export type PerpSide = "long" | "short";

export interface BracketLevels {
  side: PerpSide;
  entry: number;
  stop: number;
  target: number;
}

export interface BracketCosts {
  /** Fee rates in hundredths of a basis point of notional: 1200 = 12.00 bps. */
  entryFeeBpsE2: number;
  exitFeeBpsE2: number;
  /** Expected adverse fill on the stop exit, in price units. */
  exitImpact: number;
  /** Expected funding paid over the hold, in price units; negative when received. */
  funding: number;
}

export interface BreakEven {
  stopDist: number;
  targetDist: number;
  /** R x 1e4, rounded down. */
  rE4: number;
  feeIn: number;
  feeOutStop: number;
  feeOutTarget: number;
  gain: number;
  loss: number;
  /** Break-even hit rate, e4, rounded up (conservative). 10000 or more means no hit rate pays. */
  pStarE4: number;
  /** Equivalent symmetric cost c in units of d, e4: p* (1 + R) - 1. */
  cE4: number;
}

const E4 = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: non-positive divisor");
  return a >= 0n ? (a + b - 1n) / b : -(-a / b);
}

function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("floorDiv: non-positive divisor");
  return a >= 0n ? a / b : -((-a + b - 1n) / b);
}

function isPosInt(v: number): boolean {
  return Number.isSafeInteger(v) && v > 0;
}

/** Null when the levels form a valid bracket, else the reason. */
export function validateBracket(l: BracketLevels): string | null {
  if (!isPosInt(l.entry) || !isPosInt(l.stop) || !isPosInt(l.target)) return "entry, stop and target must be positive prices";
  if (l.side === "long" && !(l.stop < l.entry && l.entry < l.target)) return "a long needs stop < entry < target";
  if (l.side === "short" && !(l.target < l.entry && l.entry < l.stop)) return "a short needs target < entry < stop";
  return null;
}

/** Fee at a price, in the same price units, rounded up. */
export function feeAt(price: number, bpsE2: number): number {
  return Number(ceilDiv(BigInt(price) * BigInt(bpsE2), 1_000_000n));
}

export function breakEven(l: BracketLevels, c: BracketCosts): BreakEven {
  const why = validateBracket(l);
  if (why) throw new Error(`breakEven: ${why}`);
  for (const [k, v] of Object.entries(c)) if (!Number.isSafeInteger(v)) throw new Error(`breakEven: ${k} must be an integer`);
  const d = Math.abs(l.entry - l.stop);
  const g0 = Math.abs(l.target - l.entry);
  const feeIn = feeAt(l.entry, c.entryFeeBpsE2);
  const feeOutStop = feeAt(l.stop, c.exitFeeBpsE2);
  const feeOutTarget = feeAt(l.target, c.exitFeeBpsE2);
  const gain = g0 - feeIn - feeOutTarget;
  const loss = d + feeIn + feeOutStop + Math.max(0, c.exitImpact);
  const denom = gain + loss; // = g0 + d + feeOutStop - feeOutTarget + impact > 0 for any sane bracket
  if (denom <= 0) throw new Error("breakEven: bracket has no room after fees");
  // A funding credit larger than the loss makes every hit rate pay: p* = 0 and c = -1, never below.
  const num = BigInt(Math.max(0, loss + c.funding));
  const pStar = ceilDiv(num * E4, BigInt(denom));
  const rE4 = floorDiv(BigInt(g0) * E4, BigInt(d));
  // c = p*(1+R) - 1 = (loss + F)(d + g0) / (d (gain + loss)) - 1, reported in e4 (rounded up)
  const cE4 = ceilDiv(num * BigInt(d + g0) * E4, BigInt(d) * BigInt(denom)) - E4;
  return {
    stopDist: d,
    targetDist: g0,
    rE4: Number(rE4),
    feeIn,
    feeOutStop,
    feeOutTarget,
    gain,
    loss,
    pStarE4: Number(pStar),
    cE4: Number(cE4),
  };
}

/** P(target prints before stop) for a driftless continuous price, measured from the fair price. e4. */
export function noDriftHitE4(side: PerpSide, fair: number, stop: number, target: number, mode: "floor" | "ceil" | "round" = "round"): number {
  const num = side === "long" ? fair - stop : stop - fair;
  const den = side === "long" ? target - stop : stop - target;
  if (den <= 0) throw new Error("noDriftHitE4: target and stop are on the wrong sides");
  const clamped = Math.min(Math.max(num, 0), den);
  const n = BigInt(clamped) * E4;
  const dd = BigInt(den);
  const v = mode === "floor" ? floorDiv(n, dd) : mode === "ceil" ? ceilDiv(n, dd) : (n * 2n + dd) / (2n * dd);
  return Number(v);
}

/**
 * Expected time until one of the two levels prints, for a driftless price with annual volatility sigma:
 * E[tau] = a b / sigma^2 in years, with a and b the relative distances to the levels.
 */
export function expectedHoldMs(fair: number, stop: number, target: number, sigmaAnnual: number): number {
  if (!(sigmaAnnual > 0)) throw new Error("expectedHoldMs: sigma must be positive");
  const a = Math.abs(fair - stop) / fair;
  const b = Math.abs(target - fair) / fair;
  return ((a * b) / (sigmaAnnual * sigmaAnnual)) * 365 * 24 * 3_600_000;
}

/**
 * Expected funding paid per unit over the hold, in price units. Longs pay a positive rate, shorts
 * receive it. Rounded up, so a cost is never understated and a credit is never overstated.
 */
export function expectedFunding(side: PerpSide, fair: number, ratePerInterval: number, holdMs: number, intervalMs: number): number {
  const events = holdMs / intervalMs;
  const sign = side === "long" ? 1 : -1;
  const v = Math.ceil(sign * ratePerInterval * fair * events - 1e-9);
  return v === 0 ? 0 : v; // never -0
}
