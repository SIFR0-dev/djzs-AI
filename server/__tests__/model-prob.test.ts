import { describe, it, expect, vi, afterEach } from "vitest";
import { estimateModelProb } from "../model-prob";

function mockVenice(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ model: "llama-3.3-70b", choices: [{ message: { content } }] }),
    })) as any,
  );
}

describe("estimateModelProb", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses a clean JSON probability", async () => {
    mockVenice('{"prob": 0.42, "confidence": "low", "reasoning": "x"}');
    const r = await estimateModelProb({ title: "Will BTC be up?", marketPriceProb: 0.5, apiKey: "test" });
    expect(r.prob).toBeCloseTo(0.42);
    expect(r.confidence).toBe("low");
  });

  it("strips markdown fences and clamps extremes", async () => {
    mockVenice('```json\n{"prob": 1.5, "confidence": "high", "reasoning": "y"}\n```');
    const r = await estimateModelProb({ title: "Certain market", apiKey: "test" });
    expect(r.prob).toBe(0.99);
  });

  it("throws when no API key is available", async () => {
    // Isolate the env var so the assertion holds regardless of ambient
    // VENICE_API_KEY (e.g. when CI injects it as a repository secret).
    const ENV_KEY = "VENICE_API_KEY";
    const prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      await expect(estimateModelProb({ title: "x" })).rejects.toThrow("VENICE_API_KEY not set");
    } finally {
      if (prev !== undefined) process.env[ENV_KEY] = prev;
    }
  });
});
