/**
 * What the agent is made to say. Offline, pure.
 *
 * The tool is registered with on_resolve "response_in_result", so Tavus speaks the response body
 * word for word. These lines are therefore part of the product, and this file pins every one of
 * them. Changing what the gate says is a visible change, the same as changing what it decides.
 *
 * Pins:
 *   - every decision the ruleset can reach has a line, and no line is empty;
 *   - no line contains a flag code, a full address, or a claim code;
 *   - a refusal names ONE defect (the first in canonical order) and stops;
 *   - a request with fields missing is told exactly which, in a sentence that reads aloud;
 *   - an approval never says money was sent: without a wallet it says no funds move, and with one
 *     it says "queued".
 *
 * Run: npx tsx test/say.test.mjs
 */
import { FLAGS, FLAG_CLASS, evaluate } from "../src/ruleset.ts"
import { say } from "../src/say.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}

const A = "0x" + "a".repeat(36) + "beef"
const ctx = { amount_micro: 1_500_000n, recipient: A, moves_funds: false }
const d = (verdict, disposition, flags) => ({ verdict, disposition, flags, ruleset: "PALGATE-TRANSFER-v0.1" })

// 1. every refusal, pinned
const REFUSALS = {
  RECIPIENT_INVALID: "Refused. That is not a valid wallet address.",
  AMOUNT_INVALID: "Refused. That is not a valid amount.",
  REFERENCE_UNKNOWN: "Refused. That claim code is not in the records.",
  REFERENCE_VOID: "Refused. That claim code was cancelled.",
  REFERENCE_REDEEMED: "Refused. That claim code has already been paid out.",
  REFERENCE_IN_USE: "Refused. That claim code is already tied to another request.",
  REFERENCE_EXPIRED: "Refused. That claim code has expired.",
  RECIPIENT_MISMATCH: "Refused. That claim code belongs to a different wallet address.",
  AMOUNT_MISMATCH: "Refused. That is not the amount the claim code is for.",
}
const defects = FLAGS.filter((f) => FLAG_CLASS[f] === "defect")
check(1, "every defect flag has a pinned refusal, and nothing else does", defects.join(",") === Object.keys(REFUSALS).join(","), defects.join(","))
check(2, "each refusal is spoken exactly as pinned", defects.every((f) => say(d("FAIL", "REFUSE", [f]), ctx) === REFUSALS[f]), defects.filter((f) => say(d("FAIL", "REFUSE", [f]), ctx) !== REFUSALS[f]).join(","))
check(3, "a refusal names one defect, the first in canonical order, and stops", say(d("FAIL", "REFUSE", ["REFERENCE_UNKNOWN", "REASON_ABSENT"]), ctx) === REFUSALS.REFERENCE_UNKNOWN && say(d("FAIL", "REFUSE", ["RECIPIENT_INVALID", "AMOUNT_INVALID", "REFERENCE_VOID"]), ctx) === REFUSALS.RECIPIENT_INVALID && say(d("FAIL", "REFUSE", ["REFERENCE_EXPIRED", "RECIPIENT_MISMATCH", "AMOUNT_MISMATCH"]), ctx) === REFUSALS.REFERENCE_EXPIRED)
check(4, "a refusal with a missing field beside it still speaks the defect, not the missing field", say(d("FAIL", "REFUSE", ["AMOUNT_MISMATCH", "REASON_ABSENT"]), ctx) === REFUSALS.AMOUNT_MISMATCH)

// 2. what is still needed
const need = (flags) => say(d("WAIT", "NEEDS_INFO", flags), ctx)
check(5, "one thing missing", need(["REASON_ABSENT"]) === "I can't release anything yet. I still need your reason for the payout.")
check(6, "two things missing", need(["RECIPIENT_ABSENT", "AMOUNT_ABSENT"]) === "I can't release anything yet. I still need the wallet address to send to and the amount.")
check(7, "three things missing", need(["AMOUNT_ABSENT", "REFERENCE_ABSENT", "REASON_ABSENT"]) === "I can't release anything yet. I still need the amount, the claim code this payout is based on, and your reason for the payout.")
check(8, "everything missing", need(["RECIPIENT_ABSENT", "AMOUNT_ABSENT", "REFERENCE_ABSENT", "REASON_ABSENT"]) === "I can't release anything yet. I still need the wallet address to send to, the amount, the claim code this payout is based on, and your reason for the payout.")

// 3. closed, held, approved
check(9, "closed", say(d("WAIT", "CLOSED", ["GATE_CLOSED"]), ctx) === "The gate is closed right now, so nothing can be released.")
const HELD = "That request matches the records, but it is more than I can release on my own. A person has to approve it, and nothing moves until they do."
check(10, "held, whichever limit caused it: the line does not say which", say(d("WAIT", "HOLD_FOR_HUMAN", ["OVER_AUTO_LIMIT"]), ctx) === HELD && say(d("WAIT", "HOLD_FOR_HUMAN", ["BUDGET_EXHAUSTED"]), ctx) === HELD && say(d("WAIT", "HOLD_FOR_HUMAN", ["OVER_AUTO_LIMIT", "BUDGET_EXHAUSTED"]), ctx) === HELD)
const approvedDry = say(d("PASS", "EXECUTE_AFTER_CALL", []), ctx)
const approvedLive = say(d("PASS", "EXECUTE_AFTER_CALL", []), { ...ctx, moves_funds: true })
check(11, "approved with no wallet attached: says plainly that no funds move", approvedDry === "Approved by the gate: 1.50 USDC to the address ending in beef. This gate has no wallet attached, so no funds move.", approvedDry)
check(12, "approved with a wallet: \"queued\", after the call, and never \"sent\"", approvedLive === "Approved. 1.50 USDC to the address ending in beef is queued to go out after this call ends." && !/\bsent\b|\bpaid\b|\btransferred\b/i.test(approvedLive), approvedLive)
check(13, "an approval names the amount exactly and the address by its last four characters only", approvedDry.includes("1.50 USDC") && approvedDry.includes("ending in beef") && !approvedDry.includes(A) && !approvedLive.includes(A))

// 4. across the whole decision space
const open = (amount_micro) => ({ state: "open", recipient: A, amount_micro, expired: false })
const lines = new Set()
let states = 0
let empty = 0
let coded = 0
let hex = 0
const FLAG_WORD = new RegExp(FLAGS.join("|"))
for (const gate_open of [true, false])
  for (const recipient of [{ state: "absent" }, { state: "invalid" }, { state: "present", value: A }, { state: "present", value: "0x" + "b".repeat(40) }])
    for (const amount of [{ state: "absent" }, { state: "invalid" }, { state: "present", micro: 1_500_000n }, { state: "present", micro: 9_000_000n }])
      for (const [reference, claim] of [[{ state: "absent" }, null], [{ state: "malformed" }, null], [{ state: "present", value: "PGCODE01" }, null], ...["open", "reserved", "redeemed", "void"].flatMap((state) => [false, true].map((expired) => [{ state: "present", value: "PGCODE01" }, { ...open(1_500_000n), state, expired }]))])
        for (const reason_present of [true, false])
          for (const budget_remaining_micro of [0n, 5_000_000n]) {
            const decision = evaluate({ gate_open, recipient, amount, reference, reason_present, claim, auto_limit_micro: 2_000_000n, budget_remaining_micro })
            const line = say(decision, { amount_micro: amount.state === "present" ? amount.micro : undefined, recipient: recipient.state === "present" ? recipient.value : undefined, moves_funds: false })
            states++
            lines.add(line)
            if (typeof line !== "string" || line.trim() === "") empty++
            if (FLAG_WORD.test(line)) coded++
            if (/0x[0-9a-fA-F]{8,}/.test(line) || line.includes("PGCODE01")) hex++
          }
check(14, `every reachable decision has a line (${lines.size} distinct lines over ${states} states), and none is empty`, states === 1408 && empty === 0 && lines.size >= 20, `${lines.size} lines, ${states} states`)
check(15, "no line contains a flag code", coded === 0, String(coded))
check(16, "no line reads out an address or a claim code", hex === 0, String(hex))
check(17, "every line ends as a sentence and fits in one breath (under 200 characters)", [...lines].every((l) => /[.]$/.test(l) && l.length < 200), [...lines].filter((l) => !/[.]$/.test(l) || l.length >= 200).join(" | "))

console.log(failures.length ? `\nSAY: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nSAY: PASS (${pass} checks)`)
process.exit(failures.length ? 1 : 0)
