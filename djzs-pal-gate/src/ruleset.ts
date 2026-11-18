/**
 * ruleset.ts - PALGATE-TRANSFER-v0.1, the whole decision.
 *
 * THE MODEL PROPOSES, THIS FILE DECIDES. A conversational agent asks to move USDC by calling a
 * tool. Everything the model supplies (who, how much, on what basis, why) arrives here as a set of
 * field states, next to the RECORD the stated basis points at and the operator's limits. This
 * function turns those facts into a verdict. It is pure: no clock, no network, no storage, no
 * model. The same facts give the same decision, always.
 *
 * What "the reason holds" means here. The caller cites a claim: a payout the operator issued in
 * advance, to one address, for one amount, usable once. The gate does not weigh how persuasive the
 * caller was; it looks the claim up and checks the request against it, field for field. A request
 * that cites nothing is incomplete (WAIT). A request that cites something false is defective
 * (FAIL). Nobody talks a lookup into a different answer.
 *
 * THE AMOUNT MUST MATCH EXACTLY, not "up to". A claim is spent by its first payout. If a smaller
 * amount were accepted, anyone who learned a code could spend it on one cent and leave the person
 * it was issued to with nothing. With an exact match, the only thing a claim can ever do, whoever
 * cites it, is pay its own address its own amount. A leaked code gains a stranger nothing.
 *
 * Verdict vocabulary is the house one: PASS, WAIT, FAIL.
 *   FAIL  a defect: the stated basis is false or the request is malformed. Never executes.
 *   WAIT  not a defect, but not executable now: something is missing, or a person must approve,
 *         or the gate is closed.
 *   PASS  every record check holds and the amount is inside the operator's limits.
 *
 * A LIMIT IS NOT A REASON. The two limit flags (OVER_AUTO_LIMIT, BUDGET_EXHAUSTED) are computed
 * only for a request that already passes every record check, and they can only turn a PASS into a
 * hold for a human. They never turn a FAIL into anything else and never stand in for a check.
 */

export const RULESET_VERSION = "PALGATE-TRANSFER-v0.1"

/** Every flag this ruleset can raise, in canonical order. Decisions list their flags in this order. */
export const FLAGS = [
  "GATE_CLOSED",
  "RECIPIENT_INVALID",
  "AMOUNT_INVALID",
  "REFERENCE_UNKNOWN",
  "REFERENCE_VOID",
  "REFERENCE_REDEEMED",
  "REFERENCE_IN_USE",
  "REFERENCE_EXPIRED",
  "RECIPIENT_MISMATCH",
  "AMOUNT_MISMATCH",
  "RECIPIENT_ABSENT",
  "AMOUNT_ABSENT",
  "REFERENCE_ABSENT",
  "REASON_ABSENT",
  "OVER_AUTO_LIMIT",
  "BUDGET_EXHAUSTED",
] as const
export type Flag = (typeof FLAGS)[number]

/**
 *   closed      the operator has the gate shut
 *   defect      the request is wrong against the records, or malformed          -> FAIL
 *   incomplete  a field the gate needs was not given; the caller can supply it  -> WAIT
 *   hold        the request is valid but beyond what the gate releases alone    -> WAIT
 */
export type FlagClass = "closed" | "defect" | "incomplete" | "hold"
export const FLAG_CLASS: Record<Flag, FlagClass> = {
  GATE_CLOSED: "closed",
  RECIPIENT_INVALID: "defect",
  AMOUNT_INVALID: "defect",
  REFERENCE_UNKNOWN: "defect",
  REFERENCE_VOID: "defect",
  REFERENCE_REDEEMED: "defect",
  REFERENCE_IN_USE: "defect",
  REFERENCE_EXPIRED: "defect",
  RECIPIENT_MISMATCH: "defect",
  AMOUNT_MISMATCH: "defect",
  RECIPIENT_ABSENT: "incomplete",
  AMOUNT_ABSENT: "incomplete",
  REFERENCE_ABSENT: "incomplete",
  REASON_ABSENT: "incomplete",
  OVER_AUTO_LIMIT: "hold",
  BUDGET_EXHAUSTED: "hold",
}

export type Verdict = "PASS" | "WAIT" | "FAIL"
/** What the caller's request becomes. One per verdict, except WAIT, which has three causes. */
export type Disposition = "EXECUTE_AFTER_CALL" | "NEEDS_INFO" | "HOLD_FOR_HUMAN" | "CLOSED" | "REFUSE"

export type RecipientField = { state: "present"; value: string } | { state: "absent" } | { state: "invalid" }
export type AmountField = { state: "present"; micro: bigint } | { state: "absent" } | { state: "invalid" }
/** `malformed`: something was cited, but it is not shaped like a claim code, so no record can match it. */
export type ReferenceField = { state: "present"; value: string } | { state: "absent" } | { state: "malformed" }

/** The record a reference resolves to, as the gate saw it at decision time. */
export interface ClaimFacts {
  state: "open" | "reserved" | "redeemed" | "void"
  /** Lowercase 0x address the claim pays. */
  recipient: string
  /** The amount this claim pays. A request must name exactly this. */
  amount_micro: bigint
  /** True when the claim carries an expiry that has passed. */
  expired: boolean
}

export interface Facts {
  gate_open: boolean
  recipient: RecipientField
  amount: AmountField
  reference: ReferenceField
  /** The caller gave a reason in words. Its content is recorded by hash and never interpreted. */
  reason_present: boolean
  /** null when nothing was cited, when the citation is malformed, or when no such record exists. */
  claim: ClaimFacts | null
  auto_limit_micro: bigint
  /** DAILY_BUDGET_MICRO minus what the gate has already approved on its own today. May be zero. */
  budget_remaining_micro: bigint
}

export interface Decision {
  verdict: Verdict
  disposition: Disposition
  /** Canonical order (the order of FLAGS), no duplicates. Empty exactly when the verdict is PASS. */
  flags: Flag[]
  ruleset: typeof RULESET_VERSION
}

function ordered(set: Set<Flag>): Flag[] {
  return FLAGS.filter((f) => set.has(f))
}

function decide(flags: Flag[]): Decision {
  const classes = new Set(flags.map((f) => FLAG_CLASS[f]))
  let verdict: Verdict
  let disposition: Disposition
  if (classes.has("defect")) {
    verdict = "FAIL"
    disposition = "REFUSE"
  } else if (classes.has("closed")) {
    verdict = "WAIT"
    disposition = "CLOSED"
  } else if (classes.has("incomplete")) {
    verdict = "WAIT"
    disposition = "NEEDS_INFO"
  } else if (classes.has("hold")) {
    verdict = "WAIT"
    disposition = "HOLD_FOR_HUMAN"
  } else {
    verdict = "PASS"
    disposition = "EXECUTE_AFTER_CALL"
  }
  return { verdict, disposition, flags, ruleset: RULESET_VERSION }
}

/** The decision. Pure and total: every combination of field states has exactly one answer. */
export function evaluate(f: Facts): Decision {
  // A closed gate answers before it looks at anything. It raises one flag and reveals nothing about
  // the request, valid or not.
  if (!f.gate_open) return decide(["GATE_CLOSED"])

  const flags = new Set<Flag>()

  if (f.recipient.state === "absent") flags.add("RECIPIENT_ABSENT")
  else if (f.recipient.state === "invalid") flags.add("RECIPIENT_INVALID")

  if (f.amount.state === "absent") flags.add("AMOUNT_ABSENT")
  else if (f.amount.state === "invalid") flags.add("AMOUNT_INVALID")

  if (f.reference.state === "absent") {
    flags.add("REFERENCE_ABSENT")
  } else if (f.reference.state === "malformed" || f.claim === null) {
    flags.add("REFERENCE_UNKNOWN")
  } else {
    const c = f.claim
    if (c.state === "void") flags.add("REFERENCE_VOID")
    else if (c.state === "redeemed") flags.add("REFERENCE_REDEEMED")
    else if (c.state === "reserved") flags.add("REFERENCE_IN_USE")
    // Expiry is a property of the record whatever its state: an expired claim is reported as
    // expired even when it is also void or spent.
    if (c.expired) flags.add("REFERENCE_EXPIRED")
    if (f.recipient.state === "present" && f.recipient.value !== c.recipient) flags.add("RECIPIENT_MISMATCH")
    if (f.amount.state === "present" && f.amount.micro !== c.amount_micro) flags.add("AMOUNT_MISMATCH")
  }

  if (!f.reason_present) flags.add("REASON_ABSENT")

  // Limits last, and only for a request with nothing else wrong. See the header: a limit is not a reason.
  if (flags.size === 0 && f.amount.state === "present") {
    if (f.amount.micro > f.auto_limit_micro) flags.add("OVER_AUTO_LIMIT")
    if (f.amount.micro > f.budget_remaining_micro) flags.add("BUDGET_EXHAUSTED")
  }

  return decide(ordered(flags))
}
