/**
 * say.ts - the one sentence the agent speaks for a decision.
 *
 * The tool is configured with on_resolve "response_in_result", so Tavus speaks the response body
 * VERBATIM. The model does not get to paraphrase a refusal into something softer, or an approval
 * into something larger. What is said about a decision is decided here, by the same code that made
 * the decision.
 *
 * Rules for these lines: plain language, no flag codes, no hex strings read aloud (an address is
 * named by its last four characters), no promise the gate cannot keep. Each FAIL names the first
 * defect in canonical flag order and stops; listing every defect would hand a prober a map.
 *
 * REASONS ARE AN ORACLE, knowingly. "That code belongs to a different wallet" confirms the code
 * exists. Saying no for a reason is the product, so the reason is given. It costs nothing, because
 * a claim code is a reference and not a secret: a claim only ever pays the one address it was
 * issued to, the one amount it was issued for, whoever cites it (ruleset.ts). Generated codes are
 * long random strings (80 bits) anyway.
 */
import { formatUsdc } from "./money"
import type { Decision, Flag } from "./ruleset"

const FAIL_LINE: Partial<Record<Flag, string>> = {
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

const NEED: Partial<Record<Flag, string>> = {
  RECIPIENT_ABSENT: "the wallet address to send to",
  AMOUNT_ABSENT: "the amount",
  REFERENCE_ABSENT: "the claim code this payout is based on",
  REASON_ABSENT: "your reason for the payout",
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

export interface SayContext {
  /** Present when the request named a usable amount. */
  amount_micro?: bigint
  /** Present when the request named a usable address (lowercase). */
  recipient?: string
  /** False when nothing can leave this gate (dry run, or no executor at all). The line must then say so. */
  moves_funds: boolean
}

export function say(d: Decision, ctx: SayContext): string {
  if (d.verdict === "FAIL") {
    for (const f of d.flags) {
      const line = FAIL_LINE[f]
      if (line) return line
    }
    return "Refused."
  }

  if (d.disposition === "CLOSED") return "The gate is closed right now, so nothing can be released."

  if (d.disposition === "NEEDS_INFO") {
    const needs = d.flags.map((f) => NEED[f]).filter((x): x is string => typeof x === "string")
    return `I can't release anything yet. I still need ${list(needs)}.`
  }

  if (d.disposition === "HOLD_FOR_HUMAN") {
    return "That request matches the records, but it is more than I can release on my own. A person has to approve it, and nothing moves until they do."
  }

  // PASS
  const amount = ctx.amount_micro !== undefined ? `${formatUsdc(ctx.amount_micro)} USDC` : "The payout"
  const to = ctx.recipient ? ` to the address ending in ${ctx.recipient.slice(-4)}` : ""
  // "Queued", not "sent": an approval is a reservation. It is released after the call ends, and a
  // person or a closed gate can still stop it before then.
  return ctx.moves_funds
    ? `Approved. ${amount}${to} is queued to go out after this call ends.`
    : `Approved by the gate: ${amount}${to}. This gate has no wallet attached, so no funds move.`
}
