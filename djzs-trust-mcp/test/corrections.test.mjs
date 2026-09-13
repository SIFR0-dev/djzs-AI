/**
 * Correction registry <-> record file consistency.
 *
 * The registry in src/corrections.ts is what the Worker serves; the record in
 * tests/q3/corrections/<n>.json is the thing that gets anchored. They are two
 * copies of the same facts, which is exactly the shape that drifts — the same
 * failure mode as the PASS/PROCEED vocabulary bug and the two WAIT counters.
 * This test makes drift a CI failure instead of a discovery.
 *
 * It also pins the invariant that matters most: a registry entry may never
 * claim an anchor the record file does not have.
 *
 * Run: npx tsx test/corrections.test.mjs
 */
import { readFileSync } from "node:fs"
import { CORRECTIONS, correctionsFor } from "../src/corrections.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

console.log("CORRECTIONS · registry matches the anchored record")

let n = 1
for (const c of CORRECTIONS) {
  const rec = JSON.parse(readFileSync(`../${c.record_file}`, "utf8"))
  check(n++, `${c.id}: record file exists and parses (${c.record_file})`, !!rec)
  check(n++, `${c.id}: id matches the record`, rec.id === c.id)
  check(n++, `${c.id}: scope matches the record`, rec.scope === c.scope)
  check(n++, `${c.id}: corrects_audit_id matches supersedes.audit_id`, rec.supersedes?.audit_id === c.corrects_audit_id)
  check(n++, `${c.id}: corrects_irys_id matches supersedes.irys_id`, rec.supersedes?.irys_id === c.corrects_irys_id)
  check(n++, `${c.id}: anchored_irys_id matches the record`, (rec.anchored_irys_id ?? null) === c.anchored_irys_id)
  check(n++, `${c.id}: eas_uid matches the record`, (rec.eas_uid ?? null) === c.eas_uid)
  check(n++, `${c.id}: statement is non-empty`, Array.isArray(rec.statement) && rec.statement.length > 0 && rec.statement.every((p) => typeof p === "string" && p.length))
  // THE INVARIANT: the registry can never advertise an anchor the record lacks.
  // A correction that claims to be anchored when it is not is worse than one
  // that admits it is pending — it tells a reader the remedy is permanent when
  // nothing has been written.
  check(n++, `${c.id}: registry never claims an anchor the record does not have`,
    c.anchored_irys_id === null || (typeof rec.anchored_irys_id === "string" && rec.anchored_irys_id === c.anchored_irys_id))
}

// Join behaviour
const byAudit = correctionsFor("a3a5ad8f-0418-4d63-ae7b-85b39973a25b", undefined)
const byIrys = correctionsFor(undefined, "7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br")
check(n++, "joins by audit_id", byAudit.length === 1 && byAudit[0].correction_id === "DJZS-CORR-001")
check(n++, "joins by irys_id", byIrys.length === 1 && byIrys[0].correction_id === "DJZS-CORR-001")
check(n++, "unanchored correction reports authored_pending_anchor, not anchored", byAudit[0].status === "authored_pending_anchor")
check(n++, "unanchored correction exposes no irys_url", byAudit[0].irys_url === null)
check(n++, "an unrelated certificate gets no corrections", correctionsFor("00000000-0000-0000-0000-000000000000", "nope").length === 0)
check(n++, "both identifiers absent yields nothing", correctionsFor(undefined, undefined).length === 0)

console.log(`\nCORRECTIONS · ${pass}/${pass + failures.length} assertions pass`)
if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
