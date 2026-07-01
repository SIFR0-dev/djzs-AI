/**
 * DJZS engine-v2 — Extraction Layer (Step 2)
 * ───────────────────────────────────────────
 * Free text → structured AuditInput. This is the ONLY model-dependent stage
 * in Architecture C, and it is deliberately quarantined here: the model's
 * single job is to *report observable facts in tri-state form*, never to
 * judge. Judgment lives downstream in the pure deterministic engine.
 *
 * The model is injected (`ModelFn`) so this layer is testable with a stub and
 * runs with NO API key. The hard guarantees this layer enforces — regardless
 * of how the model behaves:
 *
 *   1. STRICT tri-state: every fact is present / absent / unknown.
 *   2. `present` with a null/empty value is a contradiction → coerced UNKNOWN.
 *   3. Non-JSON / unparseable model output → ALL facts UNKNOWN (fail-safe).
 *      The engine then returns WAIT — never a silently fabricated verdict.
 *
 * In short: the model can be wrong, lazy, or garbled, and the worst it can do
 * is make us WAIT. It can never make us PASS or FAIL on a guess.
 */
import {
  AUDIT_FIELDS,
  type AuditField,
  type AuditInput,
  type Field,
  UNKNOWN,
} from "./audit-input-schema";
import { callClaudeText } from "../claude-client";

/** The injected model transport: prompt in, raw text out. */
export type ModelFn = (prompt: string) => Promise<string>;

export interface ExtractionResult {
  input: AuditInput;
  /** raw model output, retained for the audit trail / debugging */
  raw: string;
  /** true when the model output could not be parsed and we fell back to all-UNKNOWN */
  failsafe: boolean;
}

export const STRICT_EXTRACTION_PROMPT = `You are a fact extractor for a deterministic audit engine. You do NOT judge,
score, or advise. You ONLY report observable facts from the agent's stated intent.

Return STRICT JSON with exactly these keys. Every scored fact MUST be a tri-state object:
  { "state": "present", "value": <the value> }   when the fact is explicitly given
  { "state": "absent" }                            when the text affirmatively says it does NOT exist
  { "state": "unknown" }                           when you cannot tell — DO NOT GUESS

Rules you must obey:
- "absent" = the text affirmatively indicates NO such control exists, INCLUDING a stated plan
  to act with no exit logic. Treat ALL of these as ABSENT (not unknown): "no stop loss",
  "unhedged", "all in", "diamond hands", "just hold until target", "hold until we hit target",
  "ride it until it tops out", "ride the momentum", "just monitor manually", "hold through anything".
  A stated intention to hold/ride with no protective exit IS an affirmative absence of both
  stop_loss and invalidation_condition — mark BOTH absent.
- "unknown" = the text is SILENT (never addresses exit/stop logic) OR genuinely vague about a
  value ("I'll bail if it tanks" gives no level → unknown). Use unknown only when you truly
  cannot tell, NOT when a no-exit plan is stated.
- Never invent a number. A vague gesture toward a VALUE is "unknown"; a stated no-exit PLAN is "absent".
- An AGGRESSIVE ENTRY with no risk management is an affirmative ABSENT of stop_loss. A position
  described ONLY by direction + size/leverage + a momentum/sentiment rationale ("go long ETH 10x
  because Twitter is bullish", "ape into X, it's pumping", "max long, sentiment is hot"), with NO
  exit, stop, or invalidation mentioned anywhere, is a stated plan to enter with no protective
  exit — mark stop_loss absent (not unknown). The test: did the trader describe an aggressive/
  leveraged entry AND conspicuously include no protective exit? → absent. This does NOT override the
  unknown cases above: a vague gesture at an exit with no level ("I'll bail if it drops") stays
  unknown, and a neutral factual mention with no leverage/urgency that simply doesn't discuss stops
  stays unknown. Aggressive entry + conspicuous silence on exits → absent; merely not mentioning
  stops in passing → unknown.
- PREDICTION-MARKET theses: invalidation_condition is the FALSIFICATION — a stated observable
  condition that would prove the thesis WRONG before the market resolves (e.g. "I'm wrong if the
  poll average drops below 45% by Oct 1", "invalid if the official source reports under 2% growth").
  A stated falsification → present. A thesis that asserts the outcome with NO falsifiable condition
  (pure narrative, "it'll definitely happen", "the vibe is clearly YES", "everyone knows this
  resolves YES") IS an affirmative absence of a falsification → absent. A thesis that is simply
  SILENT on what would make it wrong → unknown. (This mirrors the no-exit-plan rule above: a stated
  no-falsification stance is "absent", mere silence is "unknown".)

Keys:
  agent_type (string), intended_action (string), market_type (string),
  leverage (number), position_size (number), stop_loss (number|string),
  take_profit (number|string), invalidation_condition (string),
  data_sources (string[]), oracle_source (string), confidence (number 0-100)

Optional key — audit_context:
  Set "audit_context": "prediction_market" ONLY if the intent is a bet on a market OUTCOME — it
  mentions a prediction-market venue (Kalshi, Polymarket, Limitless), a YES/NO outcome, a resolution
  date, or the probability of an event resolving. Otherwise OMIT this key entirely (the default is a
  perpetual/spot trade). Be conservative: if you are unsure, OMIT it. This is a plain string, NOT a
  tri-state object.`;

/**
 * Normalize one raw field from the model into a trusted tri-state Field.
 * This is the fail-safe gate: anything malformed collapses to UNKNOWN.
 */
function coerceField(raw: unknown): Field<unknown> {
  if (!raw || typeof raw !== "object") return UNKNOWN;
  const obj = raw as Record<string, unknown>;

  switch (obj.state) {
    case "absent":
      return { state: "absent" };
    case "present": {
      const value = obj.value;
      // `present` with no real value is a contradiction — refuse to trust it.
      const empty =
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      return empty ? UNKNOWN : { state: "present", value };
    }
    case "unknown":
      return UNKNOWN;
    default:
      // Unrecognized / missing state — fail safe.
      return UNKNOWN;
  }
}

function asString(raw: unknown, fallback = "unknown"): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw : fallback;
}

/** Build an all-UNKNOWN input — the fail-safe used when the model output is unusable. */
function allUnknownInput(): AuditInput {
  const base = {
    agent_type: "unknown",
    intended_action: "unknown",
  } as AuditInput;
  for (const field of AUDIT_FIELDS) {
    (base as Record<AuditField, Field<unknown>>)[field] = UNKNOWN;
  }
  return base;
}

/**
 * Extract a structured AuditInput from free text via the injected model.
 * Pure orchestration around a (possibly unreliable) model — all guarantees
 * are enforced here, not assumed of the model.
 */
const defaultModel: ModelFn = (prompt) => callClaudeText(prompt);

export async function extractAuditInput(
  text: string,
  model: ModelFn = defaultModel,
): Promise<ExtractionResult> {
  const prompt = `${STRICT_EXTRACTION_PROMPT}\n\nAGENT INTENT:\n${text}`;
  const raw = await model(prompt);

  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(extractJsonBlock(raw));
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  // Fail-safe: unparseable output → all-UNKNOWN → engine will WAIT.
  if (!parsed) {
    return { input: allUnknownInput(), raw, failsafe: true };
  }

  const input: AuditInput = {
    agent_type: asString(parsed.agent_type),
    intended_action: asString(parsed.intended_action),
    leverage: coerceField(parsed.leverage) as Field<number>,
    position_size: coerceField(parsed.position_size) as Field<number>,
    stop_loss: coerceField(parsed.stop_loss) as Field<number | string>,
    take_profit: coerceField(parsed.take_profit) as Field<number | string>,
    invalidation_condition: coerceField(parsed.invalidation_condition) as Field<string>,
    // Not in the extraction prompt yet — coerceField(undefined) → UNKNOWN, so
    // this is a type-completeness fill, not an extraction behavior change.
    resolution_engagement: coerceField(parsed.resolution_engagement) as Field<string>,
    data_sources: coerceField(parsed.data_sources) as Field<string[]>,
    oracle_source: coerceField(parsed.oracle_source) as Field<string>,
    confidence: coerceField(parsed.confidence) as Field<number>,
  };
  if (typeof parsed.market_type === "string" && parsed.market_type.trim() !== "") {
    input.market_type = parsed.market_type;
  }
  // audit_context is a plain enum, not tri-state. Honor it ONLY when the model
  // emits exactly "prediction_market"; anything else (absent, "perp", garbage)
  // leaves it unset → the engine's default perp path. Conservative by design.
  if (parsed.audit_context === "prediction_market") {
    input.audit_context = "prediction_market";
  }

  return { input, raw, failsafe: false };
}

/**
 * Pull the first balanced JSON object out of a model response, tolerating
 * markdown fences or surrounding prose. If none is found, returns the raw
 * string (which JSON.parse will reject → fail-safe).
 */
function extractJsonBlock(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return raw;
  return raw.slice(start, end + 1);
}
