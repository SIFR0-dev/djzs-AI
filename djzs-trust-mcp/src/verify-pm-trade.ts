/**
 * verify_pm_trade — the deterministic PM-trade audit pipeline, factored OUT of the
 * MCP/Hono wiring so it is exercisable offline with a stubbed model (no network,
 * no key, no MCP SDK). index.ts imports this; the offline contract harness imports
 * this. Nothing here touches the MCP SDK.
 *
 * The engine + extraction are imported across the package boundary by RELATIVE
 * path (../../server/...). Their transitive `@shared/*` imports resolve:
 *   - at BUILD time via the esbuild alias in wrangler.toml ([alias] @shared → ../../shared)
 *   - at TYPECHECK time via the "@shared/*" paths entry in this package's tsconfig
 * No file under server/ or shared/ is modified — the seam is the injectable ModelFn.
 */
import {
  extractAuditInputConsensus,
  type ModelFn,
} from "../../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../../server/engine-v2/deterministic-engine";
import { SCHEMA_VERSION, WEIGHTS_HASH, TAXONOMY_HASH } from "@shared/audit-schema";
import { PM_SCHEMA_VERSION, PM_WEIGHTS_HASH, PM_TAXONOMY_HASH } from "@shared/pm-taxonomy";

import { z } from "zod";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-6";

/** The tool's input shape — shared by the MCP registration and the offline harness. */
export const VERIFY_PM_TRADE_INPUT = {
  intent: z
    .string()
    .min(10, "intent must be at least 10 characters")
    .describe("Free-text prediction-market trade thesis to audit"),
};

/**
 * Request-scoped model function. Mirrors claude-client.callClaudeText's request
 * shape exactly, but reads the key from the passed-in `apiKey` (the Worker's
 * request-time env binding) rather than module-scope process.env — the one thing
 * that made the shared client Worker-incompatible.
 */
export function buildAnthropicModelFn(apiKey: string): ModelFn {
  return async (prompt: string): Promise<string> => {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? "";
  };
}

export type VerifyPmTradeResult = Record<string, unknown>;

/**
 * Pure audit pipeline: (intent, modelFn) → ratified contract object.
 * The only I/O is via modelFn (N=3 consensus extraction); the engine is pure.
 */
export async function runVerifyPmTrade(
  intent: string,
  modelFn: ModelFn,
): Promise<VerifyPmTradeResult> {
  const r = await extractAuditInputConsensus(intent, modelFn, 3);

  // PM-ONLY SCOPE (ratified): never silently run a perp audit on a non-PM intent.
  if (r.input.audit_context !== "prediction_market") {
    return {
      schema_version: "DJZS-ENGINE-V2",
      tool: "verify_pm_trade",
      in_scope: false,
      reason:
        "PM-only tool: the intent did not extract as a prediction-market thesis. Perp auditing ships separately.",
      verdict: null,
    };
  }

  const result = runDeterministicAudit(r.input);
  const action =
    result.verdict === "PASS" ? "PROCEED" : result.verdict === "FAIL" ? "FAIL" : "HALT";

  const response: VerifyPmTradeResult = {
    schema_version: "DJZS-ENGINE-V2",
    tool: "verify_pm_trade",
    in_scope: true,
    taxonomy: {
      perp: SCHEMA_VERSION,
      pm: PM_SCHEMA_VERSION,
      weights_hash: WEIGHTS_HASH,
      taxonomy_hash: TAXONOMY_HASH,
      pm_weights_hash: PM_WEIGHTS_HASH,
      pm_taxonomy_hash: PM_TAXONOMY_HASH,
    },
        verdict: result.verdict,
    action,
    risk_score: result.risk_score,
    flags: result.flags, // full objects — a solo M04 advisory rides a PASS here by design
    unknown_fields: result.unknown_fields,
    disagreements: r.disagreements, // ratified telemetry; "(evidence)" variants included
    verdict_hash: result.verdict_hash,
    extraction_failsafe: r.failsafe, // true only when ALL samples failsafed
  };

  if (action === "HALT") {
    response.halt_reason =
      `WAIT: ${result.unknown_fields.length} field(s) unresolvable from intent — ` +
      `[${result.unknown_fields.join(", ")}]. Clarify intent and re-audit.`;
  }

  return response;
}
