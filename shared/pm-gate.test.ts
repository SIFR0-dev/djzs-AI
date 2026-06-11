// DJZS-PM gate tests. Run: npx vitest run shared/pm-gate.test.ts
import { describe, it, expect } from "vitest";
import { evaluatePMTrade, PMTradeIntent, PMMarketState } from "./pm-gate";

function baseState(over: Partial<PMMarketState> = {}): PMMarketState {
  return {
    accountEquityUsd: 5000,
    resolutionObjective: true,
    hoursToResolution: 12,
    bookDepthUsd: 2000,
    feeBps: 100,
    realizedLossTodayUsd: 0,
    ...over,
  };
}

describe("DJZS-PM trade-mechanics gate", () => {
  it("PASSes a clean edge trade at funded equity", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.7, sizeUsd: 200 };
    expect(evaluatePMTrade(intent, baseState()).decision).toBe("PASS");
  });

  it("REJECTs no-edge on EDGE", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.6, modelProb: 0.61, sizeUsd: 200 };
    const v = evaluatePMTrade(intent, baseState());
    expect(v.decision).toBe("REJECT");
    expect(v.failedGate).toBe("EDGE");
  });

  it("REJECTs unfunded on FUNDING_GATE", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.75, sizeUsd: 2 };
    expect(evaluatePMTrade(intent, baseState({ accountEquityUsd: 2 })).failedGate).toBe("FUNDING_GATE");
  });

  it("REJECTs thin book on LIQUIDITY", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.75, sizeUsd: 200 };
    expect(evaluatePMTrade(intent, baseState({ bookDepthUsd: 100 })).failedGate).toBe("LIQUIDITY");
  });

  it("REJECTs fee-eaten edge on FEE_DRAG", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.61, sizeUsd: 200 };
    expect(evaluatePMTrade(intent, baseState({ feeBps: 500 })).failedGate).toBe("FEE_DRAG");
  });

  it("REJECTs subjective resolution on RESOLUTION_RISK", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.75, sizeUsd: 200 };
    expect(evaluatePMTrade(intent, baseState({ resolutionObjective: false })).failedGate).toBe("RESOLUTION_RISK");
  });

  it("REJECTs oversized position on SIZING", () => {
    const intent: PMTradeIntent = { marketSlug: "m", outcome: "YES", priceProb: 0.55, modelProb: 0.75, sizeUsd: 1000 };
    expect(evaluatePMTrade(intent, baseState()).failedGate).toBe("SIZING");
  });
});
