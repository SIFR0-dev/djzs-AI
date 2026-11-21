/**
 * unsettled.ts - naming the sentence a WAIT is about. Offline: stub model, no network, no key.
 *
 * Pins:
 *   - the three kinds of unsettled field come from the engine's own disagreement list
 *     (split, evidence, silent) and the per-reading states from the extraction layer's own gates;
 *   - a sentence is the caller's text, located, never written: exact quotes, paraphrases matched to
 *     one sentence, stated figures, the rendered "key: " prefix removed;
 *   - a quote that failed the verbatim gate is never shown;
 *   - unreadable input fails open (no field), never throws.
 *
 * Run: npx tsx test/unsettled.test.mjs
 */
import { explainUnsettled, splitSentences, locateExact, locateFuzzy, locateNumber, MAX_SENTENCE_CHARS } from "../src/unsettled.ts"
import { runVerifyPmTradeDetailed, runVerifyPmTrade } from "../src/verify-pm-trade.ts"
import { runVerifyPerpTradeDetailed } from "../src/verify-perp-trade.ts"
import { renderIntentText } from "../src/engine-adapter.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}
const collapse = (s) => s.toLowerCase().replace(/\s+/g, " ").trim()
/** One payload per call, in call order (the consensus issues its three calls synchronously). */
const seqModel = (payloads) => { let i = 0; return async () => { const p = payloads[i++ % payloads.length]; return typeof p === "string" ? p : JSON.stringify(p) } }

// The thesis DJ ran on 2026-11-20, as the home page sends it: { thesis }.
const THESIS = "Kalshi, KXFEDDECISION-26DEC-H0: \"Will the Federal Reserve hike rates by 0bps at their December 2026 meeting?\" I am buying YES at 62c.\n\nResolution: the market resolves YES if the Fed leaves the target range unchanged at the December 2026 FOMC meeting, per the Federal Reserve's own statement that day. My view is about that statement and nothing else.\n\nMy odds: CME FedWatch gave a 71% probability of no change at the December 2026 meeting as of November 20, 2026. That figure is my basis for buying YES at 62c.\n\nWhy the market is wrong: Kalshi's price has lagged the futures-implied odds since the last inflation print.\n\nI am wrong if a voting FOMC member publicly calls for a rate change at the December 2026 meeting before December 8, 2026. If that happens, this bet is invalid and I exit."
const INTENT = { thesis: THESIS }
const TEXT = renderIntentText(INTENT)
const FALSIFIER = "I am wrong if a voting FOMC member publicly calls for a rate change at the December 2026 meeting before December 8, 2026."
const ODDS = "My odds: CME FedWatch gave a 71% probability of no change at the December 2026 meeting as of November 20, 2026."
const EDGE = "Why the market is wrong: Kalshi's price has lagged the futures-implied odds since the last inflation print."

const U = { state: "unknown" }
const BASE = {
  agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market",
  leverage: U, position_size: U, stop_loss: U, take_profit: U,
  invalidation_condition: { state: "present", value: "a voting FOMC member publicly calls for a rate change at the December 2026 meeting before December 8, 2026" },
  resolution_engagement: { state: "present", value: "resolves YES if the Fed leaves the target range unchanged at the December 2026 FOMC meeting" },
  probability_basis: { state: "present", value: "CME FedWatch gave a 71% probability of no change" },
  edge_claim: { state: "present", value: "Kalshi's price has lagged the futures-implied odds" },
  data_sources: U, oracle_source: U, confidence: U,
}
const pbAbsent = (quote) => ({ ...BASE, probability_basis: { state: "absent", quote } })

async function explain(readings, intent = INTENT, kind = "pm") {
  const text = renderIntentText(intent)
  const run = kind === "perp" ? runVerifyPerpTradeDetailed : runVerifyPmTradeDetailed
  const { result, raw } = await run(text, seqModel(readings))
  const unsettled = await explainUnsettled({ text, raw, unknownFields: result.unknown_fields ?? [], disagreements: result.disagreements ?? [], context: kind === "perp" ? "perp" : undefined, keyPrefixes: Object.keys(intent) })
  return { result, unsettled }
}

// ── sentence splitting ──
{
  const s = splitSentences(TEXT).map((x) => TEXT.slice(x.start, x.end))
  check(1, "the quoted market question stays one sentence, closing quote included", s[0] === "thesis: Kalshi, KXFEDDECISION-26DEC-H0: \"Will the Federal Reserve hike rates by 0bps at their December 2026 meeting?\"", s[0])
  check(2, "the falsifier is one sentence", s.includes(FALSIFIER))
  check(3, "paragraph breaks split", s.includes(EDGE) && s.includes(ODDS))
  const d = splitSentences("Wrong if they cut before Dec. 9, 2026. Then I exit. Odds are 0.62 e.g. the ask.").map((x) => x.norm)
  check(4, "\"Dec. 9\", \"0.62\" and \"e.g. the\" do not split", d.length === 3 && d[0] === "wrong if they cut before dec. 9, 2026." && d[2] === "odds are 0.62 e.g. the ask.", JSON.stringify(d))
}

// ── locating ──
{
  const sents = splitSentences(TEXT)
  const at = (idx) => idx && TEXT.slice(sents[idx[0]].start, sents[idx[idx.length - 1]].end)
  check(5, "exact: a sub-span finds its sentence, case and spacing ignored", at(locateExact("A VOTING fomc member   publicly calls for a rate change", sents)) === FALSIFIER)
  check(6, "exact: a quote across two sentences returns both", at(locateExact("this bet is invalid and I exit", sents))?.endsWith("I exit.") && locateExact("before December 8, 2026. If that happens", sents)?.length === 2)
  check(7, "exact: too short to place", locateExact("YES", sents) === null)
  check(8, "fuzzy: a paraphrase lands on the falsifier", at(locateFuzzy("an FOMC voter publicly calls for a December rate change before Dec 8", sents)) === FALSIFIER)
  check(9, "fuzzy: unrelated words name nothing", locateFuzzy("bitcoin miners capitulate", sents) === null)
  const p = splitSentences("Long BTC-PERP at 64,200. My stop is at 61,500. Size 3 contracts.")
  check(10, "number: 61500 finds \"61,500\"", locateNumber(61500, p)?.[0] === 1)
  check(11, "number: under three digits is not placed", locateNumber(3, p) === null)
}

// ── the three kinds, through the real pipeline ──
{
  const { result, unsettled } = await explain([BASE, BASE, { ...BASE, invalidation_condition: U }])
  const u = unsettled[0]
  check(12, "split: the pipeline WAITs on the falsifier", result.verdict === "WAIT" && JSON.stringify(result.unknown_fields) === '["invalidation_condition"]' && JSON.stringify(result.disagreements) === '["invalidation_condition"]', JSON.stringify({ v: result.verdict, u: result.unknown_fields, d: result.disagreements }))
  check(13, "split: why, states", u?.field === "invalidation_condition" && u.why === "split" && u.states.present === 2 && u.states.absent === 0 && u.states.unknown === 1, JSON.stringify(u))
  check(14, "split: names the falsifier sentence, two readings", u?.sentences.length === 1 && u.sentences[0].text === FALSIFIER && u.sentences[0].present === 2 && u.sentences[0].absent === 0, JSON.stringify(u?.sentences))
}
{
  const q1 = "CME FedWatch gave a 71% probability of no change at the December 2026 meeting as of November 20, 2026"
  const q2 = "Kalshi's price has lagged the futures-implied odds since the last inflation print"
  const { result, unsettled } = await explain([pbAbsent(q1), pbAbsent(q1), pbAbsent(q2)])
  const u = unsettled[0]
  check(15, "evidence: all three flag the odds, quotes differ, WAIT not FAIL", result.verdict === "WAIT" && JSON.stringify(result.disagreements) === '["probability_basis(evidence)"]', JSON.stringify({ v: result.verdict, d: result.disagreements }))
  check(16, "evidence: both sentences, in text order, with their counts", u?.why === "evidence" && u.states.absent === 3 && u.sentences.length === 2 && u.sentences[0].text === ODDS && u.sentences[0].absent === 2 && u.sentences[1].text === EDGE && u.sentences[1].absent === 1, JSON.stringify(u))
}
{
  const { result, unsettled } = await explain([{ ...BASE, invalidation_condition: U }, { ...BASE, invalidation_condition: U }, { ...BASE, invalidation_condition: U }])
  const u = unsettled[0]
  check(17, "silent: no disagreement, no sentence", result.verdict === "WAIT" && u?.why === "silent" && u.states.unknown === 3 && u.sentences.length === 0, JSON.stringify(u))
}
{
  const q1 = "CME FedWatch gave a 71% probability of no change at the December 2026 meeting as of November 20, 2026"
  const { unsettled } = await explain([pbAbsent(q1), pbAbsent(q1), pbAbsent("experts agree it is ninety percent")])
  const u = unsettled[0]
  check(18, "a quote that failed the verbatim gate counts as unknown and is never shown", u?.why === "split" && u.states.absent === 2 && u.states.unknown === 1 && u.sentences.length === 1 && u.sentences[0].text === ODDS && !JSON.stringify(unsettled).includes("experts agree"), JSON.stringify(u))
}
{
  const para = { ...BASE, invalidation_condition: { state: "present", value: "an FOMC voter publicly calls for a December rate change before Dec 8" } }
  const { unsettled } = await explain([para, "not json at all", { ...BASE, invalidation_condition: U }])
  const u = unsettled[0]
  check(19, "an unreadable reading counts as unknown; a paraphrase still names its sentence", u?.why === "split" && u.states.present === 1 && u.states.unknown === 2 && u.sentences[0]?.text === FALSIFIER, JSON.stringify(u))
}
{
  const first = { ...BASE, resolution_engagement: { state: "present", value: "Will the Federal Reserve hike rates by 0bps at their December 2026 meeting" } }
  const { unsettled } = await explain([first, first, { ...BASE, resolution_engagement: U }])
  const t = unsettled[0]?.sentences[0]?.text ?? ""
  check(20, "the rendered \"thesis: \" prefix is removed from the sentence shown", t.startsWith("Kalshi, KXFEDDECISION-26DEC-H0:") && !t.startsWith("thesis:"), t)
}

// ── perp: a stated figure ──
{
  const PERP = { thesis: "Long BTC-PERP at 64,200 on Hyperliquid. My stop is at 61,500. ETF inflows have run positive for nine sessions, per Farside data read Nov 20." }
  const P = { agent_type: "trader", intended_action: "long BTC", leverage: U, position_size: U, stop_loss: { state: "present", value: 61500 }, take_profit: U, invalidation_condition: U, thesis_statement: { state: "present", value: "ETF inflows have run positive for nine sessions" }, resolution_engagement: U, probability_basis: U, edge_claim: U, data_sources: U, oracle_source: U, confidence: U }
  const { result, unsettled } = await explain([P, { ...P, stop_loss: U }, { ...P, stop_loss: U }], PERP, "perp")
  const u = unsettled.find((x) => x.field === "stop_loss")
  check(21, "perp: a stop one reading found is named by its figure", result.verdict === "WAIT" && u?.why === "split" && u.sentences[0]?.text === "My stop is at 61,500." && u.sentences[0].present === 1, JSON.stringify({ v: result.verdict, u }))
  check(22, "perp: every unknown field gets an entry, in engine order", JSON.stringify(unsettled.map((x) => x.field)) === JSON.stringify(result.unknown_fields))
}

// ── invariants ──
{
  const runs = await Promise.all([
    explain([BASE, BASE, { ...BASE, invalidation_condition: U }]),
    explain([pbAbsent("CME FedWatch gave a 71% probability of no change at the December 2026 meeting as of November 20, 2026"), pbAbsent("Kalshi's price has lagged the futures-implied odds"), pbAbsent("That figure is my basis for buying YES at 62c")]),
  ])
  const all = runs.flatMap((r) => r.unsettled.flatMap((u) => u.sentences.map((s) => s.text)))
  check(23, "every sentence returned is the caller's own text", all.length > 0 && all.every((t) => collapse(THESIS).includes(collapse(t.replace(/…$/, "")))), JSON.stringify(all))
  const long = { thesis: "I am wrong if " + "the committee ".repeat(60) + "votes to cut." }
  const L = { ...BASE, invalidation_condition: { state: "present", value: "the committee the committee the committee votes to cut" } }
  const { unsettled } = await explain([L, L, { ...L, invalidation_condition: U }], long)
  const t = unsettled[0]?.sentences[0]?.text ?? ""
  check(24, `a run-on sentence is cut at ${MAX_SENTENCE_CHARS} characters`, t.length === MAX_SENTENCE_CHARS && t.endsWith("…"), String(t.length))
  check(25, "unreadable raw fails open: no fields, no throw", (await explainUnsettled({ text: TEXT, raw: "{not json", unknownFields: ["invalidation_condition"], disagreements: [] })).length === 0)
  check(26, "nothing unsettled: nothing returned", (await explainUnsettled({ text: TEXT, raw: "[]", unknownFields: [], disagreements: [] })).length === 0)
}

// ── the paid path's object is the detailed path's object ──
{
  const m = [BASE, BASE, { ...BASE, invalidation_condition: U }]
  const a = await runVerifyPmTrade(TEXT, seqModel(m))
  const b = (await runVerifyPmTradeDetailed(TEXT, seqModel(m))).result
  check(27, "runVerifyPmTrade returns exactly the detailed result (no raw, no unsettled)", JSON.stringify(a) === JSON.stringify(b) && !("raw" in a) && !("unsettled" in a))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join("\n")); process.exit(1) }
