// Fusion tests — fully mocked (no API keys, no network).
// Mocks the thesis-audit engine, the Limitless reads, and Irys; keeps the pure
// pm-gate + toGateInputs real so the AND logic is exercised end to end.
// Run: npx vitest run server/pm-fusion.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./prediction-audit", () => ({
  executePredictionAudit: vi.fn(),
}));
vi.mock("./irys", () => ({
  uploadAuditToIrys: vi.fn(async () => ({ irys_tx_id: "tx_test", irys_url: "https://gateway.irys.xyz/tx_test" })),
}));
vi.mock("./venues/limitless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./venues/limitless")>();
  return { ...actual, getMarket: vi.fn(), getOrderbook: vi.fn() };
});

import { fuseVerdict } from "./pm-fusion";
import { executePredictionAudit } from "./prediction-audit";
import { getMarket, getOrderbook } from "./venues/limitless";

const ctx: any = {
  market_question: "Will BTC be up at the close?",
  market_id: "btc-up-or-down-daily",
  category: "CRYPTO",
  position: "YES",
  entry_price: 0.5,
  size_usdc: 50,
  thesis: "BTC has held the support band; falsified if it closes below the band. Source disclosed.",
  source_signal: "INDEPENDENT_RESEARCH",
};

const deepMarket = {
  slug: "btc-up-or-down-daily",
  title: "BTC Up or Down - Daily",
  venue: { exchange: "0xExchange", adapter: null },
  positionIds: null,
  prices: [0.5, 0.5],
  tradeType: "clob",
  expirationTimestamp: Date.now() + 6 * 3_600_000, // 6h out — inside HORIZON
  description: "Resolves via Chainlink BTC/USD data stream.",
};
const deepBook = {
  bids: [{ price: 0.5, size: 500_000_000, side: "BUY" }],
  asks: [{ price: 0.5, size: 500_000_000, side: "SELL" }],
  tokenId: "1",
  midpoint: 0.5,
  adjustedMidpoint: 0.5,
  lastTradePrice: 0.5,
  maxSpread: "0.05",
  minSize: "100000000",
};

beforeEach(() => {
  vi.mocked(getMarket).mockResolvedValue(deepMarket as any);
  vi.mocked(getOrderbook).mockResolvedValue(deepBook as any);
  vi.mocked(executePredictionAudit).mockResolvedValue({ verdict: "PASS", risk_score: 0, logic_hash: "0xabc", primary_flaw: "None" } as any);
});

describe("fuseVerdict", () => {
  it("FORWARD_ELIGIBLE only when thesis PASS and mechanics PASS — and never auto-executes", async () => {
    const v = await fuseVerdict({ context: ctx, modelProb: 0.7, accountEquityUsd: 5000, sizeUsd: 50 });
    expect(v.decision).toBe("FORWARD_ELIGIBLE");
    expect(v.order_forwarded).toBe(false);
    expect(v.execution).toBe("STUBBED_NO_CREDENTIALS");
  });

  it("BLOCKs when the thesis fails even if mechanics would pass", async () => {
    vi.mocked(executePredictionAudit).mockResolvedValue({ verdict: "FAIL", risk_score: 80, logic_hash: "0xbad", primary_flaw: "E02" } as any);
    const v = await fuseVerdict({ context: ctx, modelProb: 0.7, accountEquityUsd: 5000, sizeUsd: 50 });
    expect(v.decision).toBe("BLOCK");
    expect(v.reason).toContain("thesis");
  });

  it("BLOCKs when mechanics fail even if thesis passes", async () => {
    const v = await fuseVerdict({ context: ctx, modelProb: 0.51, accountEquityUsd: 5000, sizeUsd: 50 }); // edge 1pt < 5pt min
    expect(v.decision).toBe("BLOCK");
    expect((v.mechanics as any).failedGate).toBe("EDGE");
  });

  it("WAITs on mechanics when no modelProb is supplied", async () => {
    const v = await fuseVerdict({ context: ctx, accountEquityUsd: 5000 });
    expect(v.decision).toBe("BLOCK");
    expect((v.mechanics as any).reason).toBe("MODEL_PROB_REQUIRED");
  });

  it("anchors to Irys when anchor=true", async () => {
    const v = await fuseVerdict({ context: ctx, modelProb: 0.7, accountEquityUsd: 5000, sizeUsd: 50, anchor: true });
    expect(v.irys_tx_id).toBe("tx_test");
  });
});
