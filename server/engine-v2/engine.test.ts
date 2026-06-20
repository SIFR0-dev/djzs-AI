/**
 * Deterministic engine unit tests — exercise runDeterministicAudit DIRECTLY
 * (no extraction layer, no model). These pin the four thesis scenarios from
 * "WHAT GREEN PROVES": rogue -> FAIL with the three codes, clean -> PASS,
 * all-unknown -> WAIT, and determinism by construction.
 *
 * Run: npx vitest run server/engine-v2/engine.test.ts
 */
import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./deterministic-engine";
import type { AuditInput } from "./audit-input-schema";

const ROGUE: AuditInput = {
  agent_type: "trading_bot",
  intended_action: "long ETH 10x",
  market_type: "perp",
  leverage: { state: "present", value: 10 },
  position_size: { state: "unknown" },
  stop_loss: { state: "absent" },
  take_profit: { state: "absent" },
  invalidation_condition: { state: "absent" },
  data_sources: { state: "present", value: ["social_sentiment"] },
  oracle_source: { state: "absent" },
  confidence: { state: "present", value: 90 },
};

const CLEAN: AuditInput = {
  agent_type: "trading_bot",
  intended_action: "long ETH 2x with risk controls",
  market_type: "perp",
  leverage: { state: "present", value: 2 },
  position_size: { state: "present", value: 1000 },
  stop_loss: { state: "present", value: "5%" },
  take_profit: { state: "present", value: "12%" },
  invalidation_condition: { state: "present", value: "close below 200d MA" },
  data_sources: { state: "present", value: ["chainlink"] },
  oracle_source: { state: "present", value: "chainlink" },
  confidence: { state: "present", value: 60 },
};

const allUnknown = (): AuditInput => ({
  agent_type: "unknown",
  intended_action: "unknown",
  leverage: { state: "unknown" },
  position_size: { state: "unknown" },
  stop_loss: { state: "unknown" },
  take_profit: { state: "unknown" },
  invalidation_condition: { state: "unknown" },
  data_sources: { state: "unknown" },
  oracle_source: { state: "unknown" },
  confidence: { state: "unknown" },
});

describe("DJZS deterministic engine — direct verdicts", () => {
  it("rogue ETH -> FAIL with all three codes (X01 CRITICAL + E01 + I01)", () => {
    const r = runDeterministicAudit(ROGUE);
    expect(r.verdict).toBe("FAIL");
    const codes = r.flags.map((f) => f.code);
    expect(codes).toContain("DJZS-X01");
    expect(codes).toContain("DJZS-E01");
    expect(codes).toContain("DJZS-I01");
    // X01 must be the CRITICAL one driving the FAIL
    expect(r.flags.find((f) => f.code === "DJZS-X01")?.severity).toBe("CRITICAL");
  });

  it("clean trade (stop + invalidation + oracle, no social) -> PASS, no flags", () => {
    const r = runDeterministicAudit(CLEAN);
    expect(r.verdict).toBe("PASS");
    expect(r.flags).toHaveLength(0);
    expect(r.unknown_fields).toHaveLength(0);
  });

  it("all-unknown input -> WAIT (honest abstention, never PASS/FAIL)", () => {
    const r = runDeterministicAudit(allUnknown());
    expect(r.verdict).toBe("WAIT");
    expect(r.flags).toHaveLength(0);
    expect(r.unknown_fields).toContain("stop_loss");
  });

  it("DETERMINISM: same input -> byte-identical output 50x (no flicker, no cache)", () => {
    const first = JSON.stringify(runDeterministicAudit(ROGUE));
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(runDeterministicAudit(ROGUE))).toBe(first);
    }
  });
});
