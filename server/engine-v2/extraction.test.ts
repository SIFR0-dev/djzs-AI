/**
 * Extraction layer tests — STRICT mode behavior, with a STUBBED model so these
 * run deterministically with NO API key. Proves: clean parse, ambiguity→UNKNOWN,
 * "absent" only on affirmative none, parse-failure fail-safe, and the full
 * free-text → extraction → engine → verdict pipeline.
 *
 * Run: npx vitest run server/engine-v2/extraction.test.ts
 */
import { describe, it, expect } from "vitest";
import { extractAuditInput } from "./extraction-layer";
import { runDeterministicAudit } from "./deterministic-engine";

// a stub that returns whatever JSON we hand it — simulates the model's output
const stub = (json: string) => async () => json;

describe("DJZS extraction layer — STRICT mode", () => {
  it("rogue ETH: extracts facts, engine FAILs", async () => {
    const modelOut = JSON.stringify({
      agent_type: "trading_bot", intended_action: "long ETH 10x", market_type: "perp",
      leverage: { state: "present", value: 10 },
      position_size: { state: "unknown" },
      stop_loss: { state: "absent" },
      take_profit: { state: "absent" },
      invalidation_condition: { state: "absent" },
      data_sources: { state: "present", value: ["social_sentiment"] },
      oracle_source: { state: "absent" },
      confidence: { state: "present", value: 90 },
    });
    const { input } = await extractAuditInput("go long ETH 10x cuz twitter is bullish", stub(modelOut));
    expect(input.leverage).toEqual({ state: "present", value: 10 });
    expect(input.stop_loss).toEqual({ state: "absent" });

    const r = runDeterministicAudit(input);
    expect(r.verdict).toBe("FAIL");
    expect(r.flags.map(f => f.code)).toContain("DJZS-X01");
  });

  it("VAGUE stop ('I'll bail if it tanks') → UNKNOWN → WAIT, not a guess", async () => {
    // model correctly refuses to coerce a vague gesture into a stop value
    const modelOut = JSON.stringify({
      agent_type: "trading_bot", intended_action: "long ETH",
      leverage: { state: "present", value: 3 },
      position_size: { state: "unknown" },
      stop_loss: { state: "unknown" },          // <-- vague, NOT absent, NOT a value
      take_profit: { state: "unknown" },
      invalidation_condition: { state: "unknown" },
      data_sources: { state: "present", value: ["chainlink"] },
      oracle_source: { state: "present", value: "chainlink" },
      confidence: { state: "unknown" },
    });
    const { input } = await extractAuditInput("long ETH 3x, I'll bail if it tanks", stub(modelOut));
    expect(input.stop_loss).toEqual({ state: "unknown" });

    const r = runDeterministicAudit(input);
    expect(r.verdict).toBe("WAIT");
    expect(r.unknown_fields).toContain("stop_loss");
  });

  it("null value in 'present' is coerced to UNKNOWN (fail-safe)", async () => {
    const modelOut = JSON.stringify({
      agent_type: "bot", intended_action: "x",
      leverage: { state: "present", value: null }, // malformed: present w/ null
      position_size: { state: "unknown" }, stop_loss: { state: "unknown" },
      take_profit: { state: "unknown" }, invalidation_condition: { state: "unknown" },
      data_sources: { state: "unknown" }, oracle_source: { state: "unknown" },
      confidence: { state: "unknown" },
    });
    const { input } = await extractAuditInput("...", stub(modelOut));
    expect(input.leverage).toEqual({ state: "unknown" });
  });

  it("non-JSON model output → all-UNKNOWN fail-safe → WAIT (never a verdict)", async () => {
    const { input } = await extractAuditInput("garbled", stub("I'm not sure, sorry!"));
    expect(input.stop_loss).toEqual({ state: "unknown" });
    expect(input.oracle_source).toEqual({ state: "unknown" });
    const r = runDeterministicAudit(input);
    expect(r.verdict).toBe("WAIT"); // fail-safe never silently PASSes or FAILs
  });

  it("DETERMINISM: same model output → same verdict 25×", async () => {
    const modelOut = JSON.stringify({
      agent_type: "trading_bot", intended_action: "long ETH 10x",
      leverage: { state: "present", value: 10 }, position_size: { state: "unknown" },
      stop_loss: { state: "absent" }, take_profit: { state: "absent" },
      invalidation_condition: { state: "absent" },
      data_sources: { state: "present", value: ["social_sentiment"] },
      oracle_source: { state: "absent" }, confidence: { state: "present", value: 90 },
    });
    const { input } = await extractAuditInput("rogue", stub(modelOut));
    const first = JSON.stringify(runDeterministicAudit(input));
    for (let i = 0; i < 25; i++) expect(JSON.stringify(runDeterministicAudit(input))).toBe(first);
  });
});
