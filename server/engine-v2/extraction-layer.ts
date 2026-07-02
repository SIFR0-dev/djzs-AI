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
- resolution_engagement — ONLY meaningful when audit_context is "prediction_market" (for anything
  else, always return unknown). It captures whether the REASONING engages the market's OWN
  resolution criteria — its window/date, its threshold or event definition, its resolution
  source — versus arguing a proposition adjacent to all of them.
    PRESENT (engaged): the reasoning engages at least ONE of the market's own resolution
    criteria specifically — the market's window/date, the market's threshold or event
    definition, or the market's resolution source — either directly or by deriving the outcome
    through it. Schedule math against the market's stated deadline counts as engaging the
    window; component math against the resolved index counts as engaging the definition.
    value = a short quote/paraphrase of HOW it engages.
    Engagement means arguing about THE MARKET'S criterion itself. Reasoning about a DIFFERENT
    date, a DIFFERENT threshold, or a DIFFERENT authority than the market's own is adjacency,
    not engagement ("this year" does not engage a market resolving on a specific meeting).
    ABSENT (adjacent): the reasoning makes an identifiable argued claim that engages NONE of the
    market's criteria — adjacent to all of them. Four shapes, all ABSENT:
      (a) title/direction only: argues the headline or direction, not the resolved question
      (b) wrong source: relies on an authority other than the market's resolution source
      (c) wrong threshold/definition: argues an adjacent cutoff or definition
      (d) wrong window: argues the event happens but not within the market's resolution window
    For THIS FIELD ONLY, absent carries evidence and MUST be emitted as:
      {"state":"absent","shape":"a"|"b"|"c"|"d","quote":"<verbatim text from the intent — the adjacent claim>"}
    Never absent — these are NOT adjacency:
    - A personal invalidation or exit level is trade construction, not adjacency; a
      falsification clause is never the argued thesis.
    - Absence of a source citation is never, by itself, evidence of adjacency.
    - A thesis that argues NOTHING (just the bet, an exit level, or position mechanics) argues
      no adjacent claim — mark unknown, never absent. Absent requires an identifiable argued
      adjacent claim.
    - Judge the REASONING, not the bet statement — the market's terms appearing in the bet
      description is neither engagement nor adjacency; the criterion must be engaged IN THE
      REASONING.
    UNKNOWN: when unclear, unknown. Mark absent only on a clearly argued adjacent claim; mark
    present only when a market criterion is clearly engaged in the reasoning; otherwise unknown.

Keys:
  agent_type (string), intended_action (string), market_type (string),
  leverage (number), position_size (number), stop_loss (number|string),
  take_profit (number|string), invalidation_condition (string),
  resolution_engagement (string),
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
  // CONSENSUS_FIELDS, not AUDIT_FIELDS: every tri-state fact in AuditInput must
  // be set (incl. the PM-only resolution_engagement), or a failsafe sample
  // carries an undefined field into the consensus merge.
  for (const field of CONSENSUS_FIELDS) {
    (base as Record<ConsensusField, Field<unknown>>)[field] = UNKNOWN;
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
  const { input, failsafe } = parseOne(raw, text);
  return { input, raw, failsafe };
}

/** Parse one raw model output into a trusted AuditInput (the fail-safe pipeline). */
function parseOne(raw: string, originalText: string): { input: AuditInput; failsafe: boolean } {
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
    return { input: allUnknownInput(), failsafe: true };
  }

  const gated = gateResolutionEngagement(parsed.resolution_engagement, originalText);
  const input: AuditInput = {
    agent_type: asString(parsed.agent_type),
    intended_action: asString(parsed.intended_action),
    leverage: coerceField(parsed.leverage) as Field<number>,
    position_size: coerceField(parsed.position_size) as Field<number>,
    stop_loss: coerceField(parsed.stop_loss) as Field<number | string>,
    take_profit: coerceField(parsed.take_profit) as Field<number | string>,
    invalidation_condition: coerceField(parsed.invalidation_condition) as Field<string>,
    resolution_engagement: coerceField(gated.field) as Field<string>,
    data_sources: coerceField(parsed.data_sources) as Field<string[]>,
    oracle_source: coerceField(parsed.oracle_source) as Field<string>,
    confidence: coerceField(parsed.confidence) as Field<number>,
  };
  // A falsification clause cannot serve as evidence that the thesis argues an adjacent proposition.
  if (gated.quote !== null &&
      input.resolution_engagement.state === "absent" &&
      input.invalidation_condition.state === "present" &&
      typeof input.invalidation_condition.value === "string") {
    const q = collapseWs(gated.quote);
    const v = collapseWs(input.invalidation_condition.value);
    if (v !== "" && (q.includes(v) || v.includes(q))) {
      input.resolution_engagement = UNKNOWN;
    }
  }
  if (typeof parsed.market_type === "string" && parsed.market_type.trim() !== "") {
    input.market_type = parsed.market_type;
  }
  // audit_context is a plain enum, not tri-state. Honor it ONLY when the model
  // emits exactly "prediction_market"; anything else (absent, "perp", garbage)
  // leaves it unset → the engine's default perp path. Conservative by design.
  if (parsed.audit_context === "prediction_market") {
    input.audit_context = "prediction_market";
  }

  return { input, failsafe: false };
}

// ─── Quote-gated absent (resolution_engagement only) ─────────────────────

const ADJACENCY_SHAPES = ["a", "b", "c", "d"];

const collapseWs = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * An ABSENT resolution_engagement is trusted only when it carries its own
 * evidence: a shape tag (a-d) and a quote copied verbatim from the intent.
 * Anything less is demoted to UNKNOWN — which can only suppress M01, never
 * fire it. A surviving absent is stripped to a clean {state:"absent"}; the
 * shape/quote evidence persists in the retained raw output. The validated
 * quote is returned alongside so parseOne can run the falsification-overlap
 * check against the same sample's invalidation_condition.
 */
function gateResolutionEngagement(
  raw: unknown,
  originalText: string,
): { field: unknown; quote: string | null } {
  if (!raw || typeof raw !== "object") return { field: raw, quote: null };
  const obj = raw as Record<string, unknown>;
  if (obj.state !== "absent") return { field: raw, quote: null };
  const shapeOk = typeof obj.shape === "string" && ADJACENCY_SHAPES.includes(obj.shape);
  const quoteOk =
    typeof obj.quote === "string" &&
    obj.quote.trim() !== "" &&
    collapseWs(originalText).includes(collapseWs(obj.quote));
  return shapeOk && quoteOk
    ? { field: { state: "absent" }, quote: obj.quote as string }
    : { field: UNKNOWN, quote: null };
}

// ─── Consensus extraction ─────────────────────────────────────────────────

/** All tri-state facts a consensus merge must cover (perp list + PM-only field). */
const CONSENSUS_FIELDS = [...AUDIT_FIELDS, "resolution_engagement"] as const;
type ConsensusField = (typeof CONSENSUS_FIELDS)[number];

export interface ConsensusExtractionResult extends ExtractionResult {
  /** fields demoted to unknown because the n samples disagreed on state */
  disagreements: string[];
}

/** Majority value (by strict JSON identity) if one exists, else the first sample's. */
function majorityElseFirst<T>(values: T[]): T {
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const key = JSON.stringify(v);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value: v, count: 1 });
  }
  for (const { value, count } of counts.values()) {
    if (count > values.length / 2) return value;
  }
  return values[0];
}

/** Union of all sampled arrays, case-insensitive dedupe, original casing kept. */
function unionCaseInsensitive(arrays: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const key = String(item).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Consensus extraction: n independent samples of the SAME prompt, merged
 * per field by state unanimity. Any state disagreement → UNKNOWN (the engine
 * WAITs rather than acting on a fact the model can't report stably). A
 * failsafe sample contributes all-unknown votes — no special-casing.
 */
export async function extractAuditInputConsensus(
  text: string,
  model: ModelFn = defaultModel,
  n = 3,
): Promise<ConsensusExtractionResult> {
  const prompt = `${STRICT_EXTRACTION_PROMPT}\n\nAGENT INTENT:\n${text}`;
  const raws = await Promise.all(Array.from({ length: n }, () => model(prompt)));
  const samples = raws.map((raw) => parseOne(raw, text));
  const inputs = samples.map((s) => s.input);

  const input = {
    agent_type: majorityElseFirst(inputs.map((i) => i.agent_type)),
    intended_action: majorityElseFirst(inputs.map((i) => i.intended_action)),
  } as AuditInput;

  const marketTypes = inputs
    .map((i) => i.market_type)
    .filter((v): v is string => typeof v === "string");
  if (marketTypes.length > 0) {
    input.market_type = majorityElseFirst(marketTypes);
  }

  const pmVotes = inputs.filter((i) => i.audit_context === "prediction_market").length;
  if (pmVotes >= 2) {
    input.audit_context = "prediction_market";
  }

  const disagreements: string[] = [];
  const fields = input as unknown as Record<ConsensusField, Field<unknown>>;
  for (const field of CONSENSUS_FIELDS) {
    const votes = inputs.map((i) => i[field] as Field<unknown>);
    const state = votes[0].state;
    if (!votes.every((v) => v.state === state)) {
      disagreements.push(field);
      fields[field] = UNKNOWN;
      continue;
    }
    if (state === "absent") {
      fields[field] = { state: "absent" };
      continue;
    }
    if (state === "unknown") {
      fields[field] = UNKNOWN;
      continue;
    }
    const values = votes.map((v) => (v as { state: "present"; value: unknown }).value);
    const merged =
      field === "data_sources" ? unionCaseInsensitive(values as string[][]) :
      field === "oracle_source" ? [...new Set(values.map(String))].join(" | ") :
      majorityElseFirst(values);
    fields[field] = { state: "present", value: merged };
  }

  return {
    input,
    raw: JSON.stringify(raws),
    failsafe: samples.every((s) => s.failsafe),
    disagreements,
  };
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
