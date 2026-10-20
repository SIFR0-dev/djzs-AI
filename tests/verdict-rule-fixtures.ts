/**
 * DJZS-VR-v1.0 equivalence sweep and fixture.
 *
 * Runs the real deterministic engine over its full input space (the same enumeration as
 * tests/pm-engine-integrity.ts and tests/lf-engine-integrity.ts), and on EVERY input checks that
 * server/engine-v2/verdict-rule.ts reproduces the engine's verdict and risk_score from the tally the
 * engine emitted. Then writes the distinct tallies with their outcomes to
 * tests/fixtures/verdict-rule.json, the table test/DJZSVerdictRule.test.cjs replays against the
 * contract on Base, so the three copies of the rule cannot drift apart.
 *
 *   npx tsx tests/verdict-rule-fixtures.ts           regenerate the fixture
 *   npx tsx tests/verdict-rule-fixtures.ts --check   exit 1 if the file on disk differs (CI)
 *
 * No network, no model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runDeterministicAudit, type EngineResult } from "../server/engine-v2/deterministic-engine";
import { AUDIT_FIELDS, type AuditInput, type Field } from "../server/engine-v2/audit-input-schema";
import { VERDICT_CODE, VERDICT_RULE_VERSION, tallyKey, verdictFromTally, type VerdictTally } from "../server/engine-v2/verdict-rule";
import { PM_SCHEMA_VERSION } from "../shared/pm-taxonomy";
import { SCHEMA_VERSION } from "../shared/audit-schema";

type S = "present" | "absent" | "unknown";
const STATES: S[] = ["present", "absent", "unknown"];
const f = <T,>(s: S, v: T): Field<T> => (s === "present" ? { state: "present", value: v } : { state: s });

const OUT = new URL("./fixtures/verdict-rule.json", import.meta.url);
const fails: string[] = [];
const bad = (m: string) => { if (fails.length < 30) fails.push(m); };

type Row = { ruleset: string; codes: string[]; unknown_count: number; bounded: boolean; thesis_present: boolean; risk_score: number; verdict: string; verdict_code: 1 | 2 | 3; inputs: number };
const rows = new Map<string, Row>();

function record(r: EngineResult, id: string): void {
  const t: VerdictTally = r.tally;
  const sortedCodes = r.flags.map((x) => x.code).sort();
  if (JSON.stringify(t.codes) !== JSON.stringify(sortedCodes)) bad(`${id}: tally.codes ${t.codes} != flags ${sortedCodes}`);
  if (t.unknown_count !== r.unknown_fields.length) bad(`${id}: tally.unknown_count ${t.unknown_count} != ${r.unknown_fields.length}`);
  let out;
  try { out = verdictFromTally(t); } catch (e) { bad(`${id}: rule threw ${(e as Error).message}`); return; }
  if (out.verdict !== r.verdict) bad(`${id}: rule ${out.verdict} != engine ${r.verdict} for ${tallyKey(t)}`);
  if (out.risk_score !== r.risk_score) bad(`${id}: rule risk ${out.risk_score} != engine ${r.risk_score}`);
  const key = tallyKey(t);
  const existing = rows.get(key);
  if (existing) {
    if (existing.verdict !== r.verdict || existing.risk_score !== r.risk_score) bad(`${id}: same tally, different outcome (${key})`);
    existing.inputs++;
  } else {
    rows.set(key, { ruleset: t.ruleset, codes: t.codes, unknown_count: t.unknown_count, bounded: t.bounded, thesis_present: t.thesis_present, risk_score: r.risk_score, verdict: r.verdict, verdict_code: VERDICT_CODE[r.verdict], inputs: 1 });
  }
}

// PM space: the tests/pm-engine-integrity.ts enumeration, 108 inputs.
function mkPM(inv: S, res: S, prob: S, edge: S | "omitted"): AuditInput {
  const b: any = { agent_type: "t", intended_action: "bet", audit_context: "prediction_market",
    leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
    invalidation_condition: f(inv, "x"), resolution_engagement: f(res, "y"), probability_basis: f(prob, "z"),
    data_sources: { state: "present", value: ["c"] }, oracle_source: { state: "present", value: "k" }, confidence: { state: "absent" } };
  if (edge !== "omitted") b.edge_claim = f(edge, "e");
  return b;
}
let pmInputs = 0;
for (const inv of STATES) for (const res of STATES) for (const prob of STATES) for (const edge of [...STATES, "omitted"] as const) {
  record(runDeterministicAudit(mkPM(inv, res, prob, edge)), `pm ${inv}/${res}/${prob}/${edge}`); pmInputs++;
}

// LF space: the tests/lf-engine-integrity.ts enumeration, 3^9 states x 3 variants = 59,049 inputs.
const VALUES: Record<string, unknown> = { leverage: 10, position_size: 3000, stop_loss: 79800, take_profit: 73000, invalidation_condition: "hike delivered and BTC > 82K", data_sources: ["Binance funding"], oracle_source: "Binance mark price", confidence: 60, thesis_statement: "funding is extreme and 82K rejected four times" };
const VARIANTS: { name: string; over: Record<string, unknown> }[] = [
  { name: "clean", over: {} },
  { name: "social", over: { data_sources: ["twitter"] } },
  { name: "unverified-oracle", over: { oracle_source: "the team's dashboard" } },
];
let lfInputs = 0;
const n = AUDIT_FIELDS.length;
for (const v of VARIANTS) for (let k = 0; k < 3 ** n; k++) {
  const input: any = { agent_type: "t", intended_action: "open", audit_context: "perp", market_type: "perp", resolution_engagement: { state: "unknown" }, probability_basis: { state: "unknown" }, edge_claim: { state: "unknown" } };
  let x = k;
  for (const field of AUDIT_FIELDS) { const s = STATES[x % 3]; x = Math.floor(x / 3); input[field] = s === "present" ? { state: "present", value: (v.over as any)[field] ?? VALUES[field] } : { state: s }; }
  record(runDeterministicAudit(input), `lf ${v.name}#${k}`); lfInputs++;
}

// Refusals the rule must make: unknown ruleset, unknown code, duplicate code.
for (const t of [
  { ruleset: "DJZS-PM-v0.9", codes: [], unknown_count: 0, bounded: true, thesis_present: true },
  { ruleset: PM_SCHEMA_VERSION, codes: ["DJZS-S01"], unknown_count: 0, bounded: true, thesis_present: true },
  { ruleset: SCHEMA_VERSION, codes: ["DJZS-M01"], unknown_count: 0, bounded: true, thesis_present: true },
  { ruleset: SCHEMA_VERSION, codes: ["DJZS-E01", "DJZS-E01"], unknown_count: 0, bounded: true, thesis_present: true },
] as VerdictTally[]) {
  let threw = false;
  try { verdictFromTally(t); } catch { threw = true; }
  if (!threw) bad(`rule accepted ${tallyKey(t)}`);
}

const sorted = [...rows.values()].sort((a, b) => (a.ruleset === b.ruleset ? tallyKey(a as VerdictTally).localeCompare(tallyKey(b as VerdictTally)) : a.ruleset.localeCompare(b.ruleset)));
const dist: Record<string, number> = {};
for (const r of sorted) dist[`${r.ruleset}:${r.verdict}`] = (dist[`${r.ruleset}:${r.verdict}`] ?? 0) + r.inputs;
const doc = {
  _source: `Generated by tests/verdict-rule-fixtures.ts from the deterministic engine over its full input space. Do not edit by hand. Rule ${VERDICT_RULE_VERSION}: FAIL when any fired code is CRITICAL or the weights reach the ruleset threshold (DJZS-PM-v1.0: 25, DJZS-LF-v1.2: 50); else PASS when no code fired and bounded (LF: and thesis present); else WAIT when any scored field is unknown; else PASS. Verdict codes PASS 1, WAIT 2, FAIL 3. Each row is one distinct tally; inputs is how many engine inputs produced it.`,
  rule: VERDICT_RULE_VERSION,
  rulesets: { [PM_SCHEMA_VERSION]: { threshold: 25, inputs: pmInputs }, [SCHEMA_VERSION]: { threshold: 50, inputs: lfInputs } },
  distribution: dist,
  count: sorted.length,
  rows: sorted,
};
const rendered = `${JSON.stringify(doc, null, 2)}\n`;

if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
if (process.argv.includes("--check")) {
  let onDisk = "";
  try { onDisk = readFileSync(OUT, "utf8"); } catch { /* missing */ }
  if (onDisk !== rendered) { console.error(`FAIL: tests/fixtures/verdict-rule.json is not what the sweep renders. Run: npx tsx tests/verdict-rule-fixtures.ts`); process.exit(1); }
  console.log(`PASS - verdict rule agrees with the engine on ${pmInputs + lfInputs} inputs; fixture (${sorted.length} distinct tallies) matches`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`PASS - verdict rule agrees with the engine on ${pmInputs + lfInputs} inputs; wrote ${sorted.length} distinct tallies to tests/fixtures/verdict-rule.json · ${JSON.stringify(dist)}`);
}
