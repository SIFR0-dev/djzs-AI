/**
 * PALGATE-TRANSFER-v0.1: the whole decision space, enumerated. Offline, pure, no storage.
 *
 * The ruleset is a pure function of field states, so every input it can meet is listed here and
 * decided: gate x recipient x amount x reference/record (state, expiry, size) x reason x budget.
 * Claims come in four sizes (inside the auto limit, exactly at it, one micro over it, well over
 * it) and the requested amounts include one micro below, exactly, and one micro above each size.
 * For each state the verdict is checked against an ORACLE written independently of the engine (it
 * derives the expected verdict from the plain conditions, not from flags), and against these
 * invariants:
 *
 *   I1  deterministic: the same facts give the same decision, twice;
 *   I2  SOUND: a PASS implies every record check holds (the amount EQUAL to the claim's, not
 *       merely under it) and the amount is inside both limits;
 *   I3  COMPLETE: every record check holding and the amount inside both limits implies PASS;
 *   I4  FAIL if and only if a defect flag is present (gate open);
 *   I5  A LIMIT IS NOT A REASON: a hold flag never appears beside a defect or a missing field,
 *       and a held request would PASS if the limits were lifted;
 *   I6  a closed gate answers WAIT with GATE_CLOSED alone, whatever was asked;
 *   I7  flags are known, unique and in canonical order; PASS has none; the disposition follows
 *       from the flag classes;
 *   I8  lifting a limit never turns a FAIL into anything else.
 *
 * It ends with a PIN: the tally by verdict and a sha256 over every (input, decision) pair. A
 * change to the ruleset moves the pin. Moving it is a ruling: bump RULESET_VERSION with it.
 *
 * Run: npx tsx test/ruleset-exhaustive.test.mjs
 */
import { createHash } from "node:crypto"
import { FLAGS, FLAG_CLASS, RULESET_VERSION, evaluate } from "../src/ruleset.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}

const A = "0x" + "a".repeat(40) // the address the claim pays
const B = "0x" + "b".repeat(40) // some other address
const AUTO_LIMIT = 1_000_000n // the gate releases at most 1 USDC on its own
// four claim sizes: inside the auto limit, exactly at it, one micro over it, well over it
const CLAIM_AMOUNTS = [500_000n, AUTO_LIMIT, AUTO_LIMIT + 1n, 5_000_000n]

const GATES = [true, false]
const RECIPIENTS = [
  { key: "absent", field: { state: "absent" } },
  { key: "invalid", field: { state: "invalid" } },
  { key: "match", field: { state: "present", value: A } },
  { key: "mismatch", field: { state: "present", value: B } },
]
const AMOUNTS = [
  { key: "absent", field: { state: "absent" } },
  { key: "invalid", field: { state: "invalid" } },
  // one micro below, exactly, and one micro above every claim size, plus the smallest amount there is
  ...[1n, 499_999n, 500_000n, 500_001n, 999_999n, 1_000_000n, 1_000_001n, 1_000_002n, 4_999_999n, 5_000_000n, 5_000_001n].map((micro) => ({ key: `m${micro}`, field: { state: "present", micro } })),
]
// reference x record: nothing cited, a citation no record can match, a well-formed code with no record, then each record state
const REFERENCES = [
  { key: "absent", field: { state: "absent" }, claim: null },
  { key: "malformed", field: { state: "malformed" }, claim: null },
  { key: "notfound", field: { state: "present", value: "PGNOSUCHCODE" }, claim: null },
  ...["open", "reserved", "redeemed", "void"].flatMap((state) =>
    [false, true].flatMap((expired) =>
      CLAIM_AMOUNTS.map((amount_micro) => ({
        key: `${state}${expired ? "+expired" : ""}@${amount_micro}`,
        field: { state: "present", value: "PGCODE" },
        claim: { state, recipient: A, amount_micro, expired },
      })),
    ),
  ),
]
const REASONS = [true, false]
const BUDGETS = [0n, 500_000n, AUTO_LIMIT, 5_000_000n]

const DEFECT = new Set(FLAGS.filter((f) => FLAG_CLASS[f] === "defect"))
const INCOMPLETE = new Set(FLAGS.filter((f) => FLAG_CLASS[f] === "incomplete"))
const HOLD = new Set(FLAGS.filter((f) => FLAG_CLASS[f] === "hold"))
const ORDER = new Map(FLAGS.map((f, i) => [f, i]))

/** The oracle. Plain conditions, no flags, no shared code with the engine. */
function oracle(s) {
  if (!s.gate) return { verdict: "WAIT", disposition: "CLOSED" }
  const c = s.ref.claim
  const cited = s.ref.field.state !== "absent"
  const amt = s.amt.field.state === "present" ? s.amt.field.micro : null
  const defect =
    s.rec.field.state === "invalid" ||
    s.amt.field.state === "invalid" ||
    (cited && c === null) ||
    (c !== null && (c.state !== "open" || c.expired)) ||
    (c !== null && s.rec.field.state === "present" && s.rec.field.value !== c.recipient) ||
    (c !== null && amt !== null && amt !== c.amount_micro)
  if (defect) return { verdict: "FAIL", disposition: "REFUSE" }
  const missing = s.rec.field.state === "absent" || s.amt.field.state === "absent" || !cited || !s.reason
  if (missing) return { verdict: "WAIT", disposition: "NEEDS_INFO" }
  if (amt > AUTO_LIMIT || amt > s.budget) return { verdict: "WAIT", disposition: "HOLD_FOR_HUMAN" }
  return { verdict: "PASS", disposition: "EXECUTE_AFTER_CALL" }
}

const facts = (s, over = {}) => ({
  gate_open: s.gate,
  recipient: s.rec.field,
  amount: s.amt.field,
  reference: s.ref.field,
  reason_present: s.reason,
  claim: s.ref.claim,
  auto_limit_micro: AUTO_LIMIT,
  budget_remaining_micro: s.budget,
  ...over,
})

const tally = { PASS: 0, WAIT: 0, FAIL: 0 }
const dispositions = {}
const bad = { oracle: [], determinism: [], sound: [], complete: [], failIff: [], limit: [], closed: [], shape: [], lift: [] }
const table = []
let n = 0

for (const gate of GATES) for (const rec of RECIPIENTS) for (const amt of AMOUNTS) for (const ref of REFERENCES) for (const reason of REASONS) for (const budget of BUDGETS) {
  n++
  const s = { gate, rec, amt, ref, reason, budget }
  const id = `${gate ? "open" : "closed"}|${rec.key}|${amt.key}|${ref.key}|${reason ? "reason" : "noreason"}|b${budget}`
  const d = evaluate(facts(s))
  const d2 = evaluate(facts(s))
  const want = oracle(s)
  tally[d.verdict]++
  dispositions[d.disposition] = (dispositions[d.disposition] ?? 0) + 1
  table.push(`${id}=>${d.verdict}/${d.disposition}/${d.flags.join(",")}`)

  if (d.verdict !== want.verdict || d.disposition !== want.disposition) bad.oracle.push(`${id}: engine ${d.verdict}/${d.disposition}, oracle ${want.verdict}/${want.disposition}`)
  if (JSON.stringify(d) !== JSON.stringify(d2)) bad.determinism.push(id)

  const amount = amt.field.state === "present" ? amt.field.micro : null
  const allHold =
    gate && rec.key === "match" && amount !== null && ref.claim !== null && ref.claim.state === "open" && !ref.claim.expired && amount === ref.claim.amount_micro && reason
  const inLimits = amount !== null && amount <= AUTO_LIMIT && amount <= budget
  if (d.verdict === "PASS" && !(allHold && inLimits)) bad.sound.push(id)
  if (allHold && inLimits && d.verdict !== "PASS") bad.complete.push(id)

  const hasDefect = d.flags.some((f) => DEFECT.has(f))
  const hasIncomplete = d.flags.some((f) => INCOMPLETE.has(f))
  const hasHold = d.flags.some((f) => HOLD.has(f))
  if (gate && (d.verdict === "FAIL") !== hasDefect) bad.failIff.push(id)
  if (hasHold && (hasDefect || hasIncomplete)) bad.limit.push(`${id}: a hold flag beside a defect or a missing field`)
  if (hasHold) {
    const lifted = evaluate(facts(s, { auto_limit_micro: 10n ** 13n, budget_remaining_micro: 10n ** 13n }))
    if (lifted.verdict !== "PASS") bad.limit.push(`${id}: held, but would not PASS with the limits lifted`)
  }
  if (!gate && !(d.verdict === "WAIT" && d.flags.length === 1 && d.flags[0] === "GATE_CLOSED")) bad.closed.push(id)

  const known = d.flags.every((f) => ORDER.has(f))
  const unique = new Set(d.flags).size === d.flags.length
  const sorted = d.flags.every((f, i) => i === 0 || ORDER.get(d.flags[i - 1]) < ORDER.get(f))
  const passEmpty = (d.verdict === "PASS") === (d.flags.length === 0)
  if (!(known && unique && sorted && passEmpty && d.ruleset === RULESET_VERSION)) bad.shape.push(id)

  if (d.verdict === "FAIL") {
    const lifted = evaluate(facts(s, { auto_limit_micro: 10n ** 13n, budget_remaining_micro: 10n ** 13n }))
    if (lifted.verdict !== "FAIL" || lifted.flags.join(",") !== d.flags.join(",")) bad.lift.push(id)
  }
}

const show = (xs) => (xs.length ? `${xs.length} e.g. ${xs.slice(0, 3).join(" ; ")}` : "")
check(1, `every one of ${n} input states was decided`, n === GATES.length * RECIPIENTS.length * AMOUNTS.length * REFERENCES.length * REASONS.length * BUDGETS.length && n === 29120, String(n))
check(2, "the engine agrees with the independent oracle on every state (verdict and disposition)", bad.oracle.length === 0, show(bad.oracle))
check(3, "I1 deterministic", bad.determinism.length === 0, show(bad.determinism))
check(4, "I2 SOUND: no PASS unless every record check holds and both limits allow it", bad.sound.length === 0, show(bad.sound))
check(5, "I3 COMPLETE: every such request does PASS", bad.complete.length === 0, show(bad.complete))
check(6, "I4 FAIL if and only if a defect flag is present", bad.failIff.length === 0, show(bad.failIff))
check(7, "I5 a limit is not a reason: holds stand alone and would PASS with the limits lifted", bad.limit.length === 0, show(bad.limit))
check(8, "I6 a closed gate answers WAIT with GATE_CLOSED alone", bad.closed.length === 0, show(bad.closed))
check(9, "I7 flags known, unique, canonical; PASS has none; ruleset stamped", bad.shape.length === 0, show(bad.shape))
check(10, "I8 lifting the limits never changes a FAIL or its flags", bad.lift.length === 0, show(bad.lift))

// every flag is reachable: a flag nothing can raise is dead vocabulary
const seen = new Set(table.flatMap((row) => (row.split("/")[2] ?? "").split(",").filter(Boolean)))
const unreachable = FLAGS.filter((f) => !seen.has(f))
check(11, "every flag in the vocabulary is raised by some input", unreachable.length === 0, unreachable.join(","))

// spot checks, written out so a reader can see the rules without reading the engine
const claimOf = (amount_micro, over = {}) => ({ state: "open", recipient: A, amount_micro, expired: false, ...over })
const amountOf = (micro) => ({ state: "present", micro })
// the clean request: a 1.00 claim, cited by its own address for exactly 1.00, with a reason, inside both limits
const base = { gate_open: true, recipient: { state: "present", value: A }, amount: amountOf(AUTO_LIMIT), reference: { state: "present", value: "PGCODE" }, reason_present: true, claim: claimOf(AUTO_LIMIT), auto_limit_micro: AUTO_LIMIT, budget_remaining_micro: 5_000_000n }
const flagsOf = (over) => evaluate({ ...base, ...over }).flags.join(",")
check(12, "the clean request PASSES with no flags", evaluate(base).verdict === "PASS" && evaluate(base).flags.length === 0)
check(13, "a claim exactly at the auto limit PASSES; a claim one micro over it is held", evaluate(base).verdict === "PASS" && flagsOf({ amount: amountOf(AUTO_LIMIT + 1n), claim: claimOf(AUTO_LIMIT + 1n) }) === "OVER_AUTO_LIMIT")
check(14, "THE AMOUNT MUST MATCH: one micro under the claim is a defect, and so is one micro over", flagsOf({ amount: amountOf(AUTO_LIMIT - 1n) }) === "AMOUNT_MISMATCH" && flagsOf({ amount: amountOf(AUTO_LIMIT + 1n) }) === "AMOUNT_MISMATCH" && evaluate({ ...base, amount: amountOf(1n) }).verdict === "FAIL")
check(15, "a budget of zero holds a valid request, it does not refuse it", evaluate({ ...base, budget_remaining_micro: 0n }).disposition === "HOLD_FOR_HUMAN" && flagsOf({ budget_remaining_micro: 0n }) === "BUDGET_EXHAUSTED")
check(16, "nothing cited is incomplete (WAIT), something false is a defect (FAIL)", evaluate({ ...base, reference: { state: "absent" }, claim: null }).verdict === "WAIT" && evaluate({ ...base, claim: null }).verdict === "FAIL")
check(17, "no reason given is incomplete, even when everything else checks out", flagsOf({ reason_present: false }) === "REASON_ABSENT" && evaluate({ ...base, reason_present: false }).disposition === "NEEDS_INFO")
check(18, "another address citing a real claim is refused", flagsOf({ recipient: { state: "present", value: B } }) === "RECIPIENT_MISMATCH")
check(19, "a defect outranks a missing field: FAIL, with both flags listed", evaluate({ ...base, claim: null, reason_present: false }).verdict === "FAIL" && flagsOf({ claim: null, reason_present: false }) === "REFERENCE_UNKNOWN,REASON_ABSENT")

// the pin
const tableHash = createHash("sha256").update(table.join("\n")).digest("hex")
console.log(`\n  tally  PASS ${tally.PASS} · WAIT ${tally.WAIT} · FAIL ${tally.FAIL}  (of ${n})`)
console.log(`  dispositions  ${Object.entries(dispositions).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log(`  table sha256  ${tableHash}`)
// The tally, derived by hand before it was pinned (29120 states, half of them behind a closed gate):
//   PASS 5            gate open, the claim's own address, a reason, an open unexpired claim, the claim's exact
//                     amount, inside both limits: the 0.50 claim under 3 of the 4 budgets, the 1.00 claim under 2.
//   HOLD_FOR_HUMAN 11 the other valid requests: 4 claim sizes x 4 budgets = 16 valid, less the 5.
//   NEEDS_INFO 400    nothing cited and nothing malformed: 3 recipients x 12 amounts x 2 x 4 = 288; plus an open
//                     unexpired claim with a field missing and none wrong: (2 x 2 x 2 x 4 - 4) x 4 sizes = 112.
//   CLOSED 14560      every state behind the closed gate.
//   WAIT = 11 + 400 + 14560 = 14971.  FAIL = 29120 - 14971 - 5 = 14144.
const PIN = { ruleset: "PALGATE-TRANSFER-v0.1", pass: 5, wait: 14971, fail: 14144, table: "94fb8fc427afa32eeb58c7e356104e1650a0cdbcada99a33c867cf40284e8dd1" }
check(20, "PIN: ruleset version", RULESET_VERSION === PIN.ruleset)
check(21, "PIN: tally by verdict", tally.PASS === PIN.pass && tally.WAIT === PIN.wait && tally.FAIL === PIN.fail, `PASS ${tally.PASS} WAIT ${tally.WAIT} FAIL ${tally.FAIL}`)
check(22, "PIN: sha256 over every (input, decision) pair", tableHash === PIN.table, tableHash)

console.log(failures.length ? `\nRULESET: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nRULESET: PASS (${pass} checks, ${n} states)`)
process.exit(failures.length ? 1 : 0)
