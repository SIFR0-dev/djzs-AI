// Tests for the Limitless adapter's resolution-source detection.
// Regression target: prose-based detection false-rejected oracle markets whose
// description does not name the oracle. resolutionLooksObjective() now reads the
// STRUCTURED priceOracleMetadata field first, with prose only as a fallback.
import { describe, it, expect } from "vitest";
import { resolutionLooksObjective, type MarketDetail } from "./limitless";

function market(over: Partial<MarketDetail> = {}): MarketDetail {
  return {
    slug: "x",
    title: "Test market",
    venue: { exchange: "0xabc", adapter: null },
    positionIds: null,
    prices: [0.5, 0.5],
    tradeType: "clob",
    expirationTimestamp: Date.now() + 3_600_000,
    description: "<p>This market resolves to the official settlement price.</p>",
    automationType: "lumy",
    priceOracleMetadata: null,
    ...over,
  };
}

describe("resolutionLooksObjective", () => {
  it("treats a Pyth-resolved market as objective via structured field", () => {
    expect(
      resolutionLooksObjective(
        market({
          description: "<p>no oracle word here</p>",
          priceOracleMetadata: { chartSource: "pyth", pythAddress: "0x2737", chainlinkFeedId: null, chainlinkFeedAddress: null },
        })
      )
    ).toBe(true);
  });

  it("treats a Chainlink-resolved market as objective even when prose omits the oracle", () => {
    expect(
      resolutionLooksObjective(
        market({
          description: "<p>resolves to the official settlement price</p>",
          priceOracleMetadata: { chartSource: "chainlink", pythAddress: null, chainlinkFeedId: "0xfeed", chainlinkFeedAddress: "0xabc" },
        })
      )
    ).toBe(true);
  });

  it("falls back to objective when a feed address is present but chartSource is unknown", () => {
    expect(
      resolutionLooksObjective(
        market({
          description: "<p>nothing</p>",
          priceOracleMetadata: { chartSource: "", pythAddress: "0x9999", chainlinkFeedId: null, chainlinkFeedAddress: null },
        })
      )
    ).toBe(true);
  });

  it("is not objective when there is no oracle metadata and prose has no hint", () => {
    expect(resolutionLooksObjective(market({ description: "<p>a moderator decides the winner</p>", priceOracleMetadata: null }))).toBe(false);
  });

  it("still uses prose as a fallback when structured metadata is absent", () => {
    expect(resolutionLooksObjective(market({ description: "<p>resolves via Chainlink oracle</p>", priceOracleMetadata: null }))).toBe(true);
  });
});
