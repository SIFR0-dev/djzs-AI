// The break-even floor as one call, for gates that audit a perp thesis without the rest of this engine
// (verify_perp_trade, evaluate.ts). Depends only on ./bracket. Copy both files unchanged.
import { breakEven, expectedFunding, expectedHoldMs, noDriftHitE4, type PerpSide } from "./bracket";

/** A claim must clear p* by this much (1 pt, the same margin ds-price-gate uses). Canon: DJ's ruling. */
export const BREAKEVEN_MIN_EDGE_E4 = 100;

export interface FloorInput {
  side: PerpSide;
  /** One integer price unit throughout (cents of the underlying, micro-dollars per contract, ticks). */
  entry: number;
  stop: number;
  target: number;
  /** Mid at audit time; defaults to entry. */
  fair?: number;
  /** The thesis's stated hit rate (target before stop), e4; null when none is stated. */
  pClaimE4: number | null;
  /** Venue taker fee, charged in and out: 1200 = 12.00 bps. */
  takerFeeBpsE2: number;
  /** Expected slippage on the stop exit, price units. */
  exitImpact?: number;
  /** Funding rate per interval, signed: longs pay a positive rate. */
  fundingRate: number;
  fundingIntervalMs: number;
  /** Realized annual volatility, for the expected hold (and so the funding paid). */
  sigmaAnnual: number;
}

export interface FloorResult {
  pass: boolean;
  pStarE4: number;
  p0E4: number;
  rE4: number;
  cE4: number;
  holdMs: number;
  reason: string;
}

const pct = (e4: number) => `${(e4 / 100).toFixed(2)}%`;

export function breakevenFloor(x: FloorInput): FloorResult {
  const fair = x.fair ?? x.entry;
  const holdMs = expectedHoldMs(fair, x.stop, x.target, x.sigmaAnnual);
  const funding = expectedFunding(x.side, fair, x.fundingRate, holdMs, x.fundingIntervalMs);
  const be = breakEven(
    { side: x.side, entry: x.entry, stop: x.stop, target: x.target },
    { entryFeeBpsE2: x.takerFeeBpsE2, exitFeeBpsE2: x.takerFeeBpsE2, exitImpact: x.exitImpact ?? 0, funding },
  );
  const p0E4 = noDriftHitE4(x.side, fair, x.stop, x.target, "floor");
  const pass = x.pClaimE4 !== null && x.pClaimE4 - be.pStarE4 >= BREAKEVEN_MIN_EDGE_E4;
  const reason =
    x.pClaimE4 === null
      ? `No stated hit rate. The bracket needs ${pct(be.pStarE4)} to break even; a stop alone is not a thesis.`
      : pass
        ? `Claims ${pct(x.pClaimE4)} against a ${pct(be.pStarE4)} break-even (no-drift rate ${pct(p0E4)}).`
        : `Claims ${pct(x.pClaimE4)}, under the ${pct(be.pStarE4)} break-even plus 1 pt.`;
  return { pass, pStarE4: be.pStarE4, p0E4, rE4: be.rE4, cE4: be.cE4, holdMs: Math.round(holdMs), reason };
}
