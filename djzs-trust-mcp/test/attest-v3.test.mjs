/**
 * EAS schema v3 (DJZS-VR-v1.0) - fully offline.
 *
 * No key, no network. Asserts:
 *   - the Worker attests under v2 when no resolver is configured, and under v3 when one is,
 *     and refuses to attest under v2 silently when a resolver is set but the tally is missing;
 *   - the v3 schema string is character for character the one DJZSVerdictResolver.sol publishes,
 *     and schemaUIDv3 is keccak256(abi.encodePacked(schema, resolver, false));
 *   - the v2 payload is a prefix of the v3 payload's field list, decoded either way;
 *   - what the engine emits as its tally, once attested, is what the resolver derives the same
 *     verdict from (simulated here with the TypeScript rule, proven on chain in
 *     test/DJZSVerdictResolver.test.cjs).
 *
 * Run: npx tsx test/attest-v3.test.mjs
 */
import { readFileSync } from "node:fs"
import { encodePacked, keccak256 } from "viem"
import {
  DJZS_SCHEMA_UID, EAS_SCHEMA_V3, decodeVerdict, decodeVerdictV3, encodeForSchema, encodeVerdict, encodeVerdictV3,
  isAddress, schemaUIDFor, schemaUIDv3,
} from "../src/attest-worker.ts"
import { EAS_SCHEMA } from "../src/djzs-intent.ts"
import { runDeterministicAudit } from "../../server/engine-v2/deterministic-engine.ts"
import { verdictFromTally } from "../../server/engine-v2/verdict-rule.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

const RESOLVER = "0x1111111111111111111111111111111111111111"
const INTENT = keccak256(new TextEncoder().encode("intent"))
const base = { intentHash: INTENT, verdict: "FAIL", riskScore: 40, flags: ["DJZS-M03", "DJZS-M04"], rulesetVersion: "DJZS-PM-v1.0", agent: "0x2222222222222222222222222222222222222222" }
const withTally = { ...base, tally: { unknownCount: 0, bounded: true, thesisPresent: true } }

// 1. schema text and UID
const sol = readFileSync(new URL("../../contracts/DJZSVerdictResolver.sol", import.meta.url), "utf8")
const solSchema = sol.match(/string public constant SCHEMA =\s*"([^"]+)"/)?.[1]
check(1, "v3 schema string equals DJZSVerdictResolver.SCHEMA", solSchema === EAS_SCHEMA_V3)
check(2, "v3 schema begins with the v2 schema, verbatim", EAS_SCHEMA_V3.startsWith(EAS_SCHEMA + ","))
check(3, "schemaUIDv3 is keccak256(encodePacked(schema, resolver, false))",
  schemaUIDv3(RESOLVER) === keccak256(encodePacked(["string", "address", "bool"], [EAS_SCHEMA_V3, RESOLVER, false])))
check(4, "schemaUIDFor: v2 without a resolver, v3 with one", schemaUIDFor(undefined) === DJZS_SCHEMA_UID && schemaUIDFor("") === DJZS_SCHEMA_UID && schemaUIDFor(RESOLVER) === schemaUIDv3(RESOLVER))
check(5, "isAddress is strict", isAddress(RESOLVER) && !isAddress("0x123") && !isAddress(undefined) && !isAddress(RESOLVER + "0"))

// 2. schema selection
const v2 = encodeForSchema(withTally, undefined)
const v3 = encodeForSchema(withTally, RESOLVER)
check(6, "no resolver: v2 schema and v2 payload", v2.version === 2 && v2.schema === DJZS_SCHEMA_UID && v2.data === encodeVerdict(withTally))
check(7, "resolver: v3 schema and v3 payload", v3.version === 3 && v3.schema === schemaUIDv3(RESOLVER) && v3.data === encodeVerdictV3(withTally))
let threw = false
try { encodeForSchema(base, RESOLVER) } catch { threw = true }
check(8, "resolver set but no tally: refuses rather than attesting under v2 silently", threw)
check(9, "a v3 payload is longer than the v2 payload of the same verdict", v3.data.length > v2.data.length)

// 3. round trips
const d3 = decodeVerdictV3(v3.data)
check(10, "v3 round trip", d3.intentHash === INTENT && d3.verdict === "FAIL" && d3.riskScore === 40 && d3.flags.join() === "DJZS-M03,DJZS-M04" && d3.rulesetVersion === "DJZS-PM-v1.0" && d3.tally.unknownCount === 0 && d3.tally.bounded === true && d3.tally.thesisPresent === true)
const d2 = decodeVerdict(v2.data)
check(11, "v2 round trip unchanged", d2.intentHash === INTENT && d2.verdict === "FAIL" && d2.riskScore === 40 && d2.rulesetVersion === "DJZS-PM-v1.0")

// 4. bounds
threw = false
try { encodeVerdict({ ...base, riskScore: 201 }) } catch { threw = true }
check(12, "riskScore above 200 refused", threw)
check(13, "riskScore 200 (the LF budget) accepted", typeof encodeVerdict({ ...base, riskScore: 200 }) === "string")
threw = false
try { encodeVerdictV3({ ...withTally, tally: { ...withTally.tally, unknownCount: 256 } }) } catch { threw = true }
check(14, "unknownCount above 255 refused", threw)

// 5. engine tally -> v3 payload -> the rule derives the attested verdict (the resolver's check, in TS)
const f = (s, v) => (s === "present" ? { state: "present", value: v } : { state: s })
const pm = (inv, res, prob) => ({ agent_type: "t", intended_action: "bet", audit_context: "prediction_market",
  leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
  invalidation_condition: f(inv, "x"), resolution_engagement: f(res, "y"), probability_basis: f(prob, "z"),
  data_sources: { state: "present", value: ["c"] }, oracle_source: { state: "present", value: "k" }, confidence: { state: "absent" } })
let agree = 0, total = 0
for (const inv of ["present", "absent", "unknown"]) for (const res of ["present", "absent", "unknown"]) for (const prob of ["present", "absent", "unknown"]) {
  const r = runDeterministicAudit(pm(inv, res, prob))
  const att = { intentHash: INTENT, verdict: r.verdict, riskScore: r.risk_score, flags: r.flags.map((x) => x.code).sort(), rulesetVersion: r.tally.ruleset, agent: base.agent,
    tally: { unknownCount: r.tally.unknown_count, bounded: r.tally.bounded, thesisPresent: r.tally.thesis_present } }
  const decoded = decodeVerdictV3(encodeVerdictV3(att))
  const derived = verdictFromTally({ ruleset: decoded.rulesetVersion, codes: decoded.flags, unknown_count: decoded.tally.unknownCount, bounded: decoded.tally.bounded, thesis_present: decoded.tally.thesisPresent })
  total++
  if (derived.verdict === decoded.verdict && derived.risk_score === decoded.riskScore) agree++
}
check(15, `engine tally attested under v3 derives the attested verdict on every PM state (${agree}/${total})`, agree === total && total === 27)

// 6. a lie the resolver would refuse: same tally, verdict flipped
const lie = decodeVerdictV3(encodeVerdictV3({ ...withTally, verdict: "PASS" }))
const derivedLie = verdictFromTally({ ruleset: lie.rulesetVersion, codes: lie.flags, unknown_count: 0, bounded: true, thesis_present: true })
check(16, "a PASS attested over a FAIL tally is what the resolver refuses", derivedLie.verdict === "FAIL" && lie.verdict === "PASS")

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { console.error("FAIL:\n  " + failures.join("\n  ")); process.exit(1) }
