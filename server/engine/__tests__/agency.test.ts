import { DJZSEngine } from "../engine";
import type { ToolCall } from "../types";
import { AGENCY_WEIGHTS } from "../weights";
import { AGENCY_MAX_SCORE, computeAgencyVerdict } from "../../../shared/agency-lf-codes";
import { DOMAIN_REGISTRY } from "../../../shared/universal-lf-codes";

const engine = new DJZSEngine({
  codeSets: ["agency"],
  failThreshold: 40,
  warnThreshold: 20,
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fired(call: ToolCall) {
  return engine.evaluate(call).firedCodes;
}

console.log("\n── Invariant: agency weights sum to 100 ──");
assert(
  Object.values(AGENCY_WEIGHTS).reduce((a, b) => a + b, 0) === 100,
  "AGENCY_WEIGHTS sum to exactly 100"
);
assert(AGENCY_MAX_SCORE === 100, "AGENCY_MAX_SCORE is 100");
assert(DOMAIN_REGISTRY["agency"]?.maxScore === 100, "agency domain registered in DOMAIN_REGISTRY");

console.log("\n── A01: MISSING_FALSIFIABLE_THESIS ──");
assert(
  fired({
    name: "deploy_agent",
    params: {},
    reasoning: "This agent is a great idea and will help the enterprise a lot.",
    domain: "general",
  }).includes("A01"),
  "Fires when no quantified claim or falsification condition is present"
);
assert(
  !fired({
    name: "deploy_agent",
    params: {},
    reasoning:
      "This agent will reduce mean breach dwell time by at least 35% with p<0.05. The thesis is falsified if dwell time does not drop within 30 days.",
    domain: "general",
  }).includes("A01"),
  "Does NOT fire with a quantified directional claim and explicit falsification"
);

console.log("\n── A02: UNTESTABLE_METRICS ──");
assert(
  fired({
    name: "deploy_agent",
    params: {},
    reasoning:
      "Success means the workflow is generally better and the outcome improves overall. The thesis fails if it does not.",
    domain: "general",
  }).includes("A02"),
  "Fires when success metric is referenced but not quantified"
);
assert(
  !fired({
    name: "deploy_agent",
    params: {},
    reasoning:
      "Success metric: false-positive rate stays below 2% while throughput increases by 15%. Falsified otherwise.",
    domain: "general",
  }).includes("A02"),
  "Does NOT fire when metrics are quantified"
);

console.log("\n── A03: STATIC_REASONING ──");
assert(
  fired({
    name: "rebalance",
    params: {},
    reasoning:
      "This will be a long-term hold and the agent will maintain the position indefinitely. Target return 20% by year end, falsified if drawdown exceeds 10%.",
    domain: "general",
  }).includes("A03"),
  "Fires on forward/ongoing commitment with no plan to update on evidence"
);
assert(
  !fired({
    name: "rebalance",
    params: {},
    reasoning:
      "Ongoing position, but we monitor threat intel continuously and re-evaluate when new evidence shifts the signal by >15%. Target 20% by year end, falsified if drawdown exceeds 10%.",
    domain: "general",
  }).includes("A03"),
  "Does NOT fire when an evidence-update plan is present"
);

console.log("\n── A04: IGNORES_CONSTRAINTS ──");
assert(
  fired({
    name: "modify_records",
    params: {},
    reasoning:
      "The agent writes directly to the regulated system of record and the production database. It will reduce manual entry by 40%, falsified if error rate rises.",
    domain: "general",
  }).includes("A04"),
  "Fires when a constrained/regulated environment is touched with no constraint acknowledgment"
);
assert(
  !fired({
    name: "modify_records",
    params: {},
    reasoning:
      "The agent writes to the regulated system of record within a permissioned, SOC2-compliant sandbox bounded by an audit trail. Reduces manual entry by 40%, falsified if error rate rises.",
    domain: "general",
  }).includes("A04"),
  "Does NOT fire when constraints are explicitly acknowledged"
);

console.log("\n── A05: INTERFACE_EROSION_ONLY ──");
assert(
  fired({
    name: "ship_agent",
    params: {},
    reasoning:
      "The whole pitch is to replace the UI and cut headcount. It will eliminate seats, falsified if adoption stalls.",
    domain: "general",
  }).includes("A05"),
  "Fires on interface/seat replacement with no outcome-improvement claim"
);
assert(
  !fired({
    name: "ship_agent",
    params: {},
    reasoning:
      "We replace the UI but the real value is improved data quality and predictive accuracy on breaches. Target 30% fewer errors, falsified if accuracy regresses.",
    domain: "general",
  }).includes("A05"),
  "Does NOT fire when replacement is paired with an outcome/data improvement"
);

console.log("\n── Verdict + isolation ──");
assert(
  computeAgencyVerdict(["A01"]) === "FAIL",
  "Single CRITICAL (A01) forces FAIL"
);
assert(
  computeAgencyVerdict(["A05"]) === "PASS",
  "Single MEDIUM (A05) below threshold PASSes"
);
assert(
  engine.evaluate({
    name: "swap_tokens",
    params: {},
    reasoning: "This swap is recommended because it is recommended.",
    domain: "financial",
  }).firedCodes.every((c) => c.startsWith("A")),
  "agency code-set does not emit DJZS/universal codes"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} agency engine test(s) failed`);
}
