/**
 * gate.ts - one tool call in, one recorded decision out; and the lane approved decisions leave by.
 *
 * ORDER OF EVENTS for a tool call (the route has already verified the signature):
 *   1. open the decision row for this tool_call_id, or get the one that exists (idempotency);
 *   2. read the model's arguments strictly (intent.ts);
 *   3. read the records the request points at: the cited claim, today's automatic spend;
 *   4. decide (ruleset.ts, pure);
 *   5. write the decision. An approval or a hold is written together with its claim reservation,
 *      conditionally, in one transaction (store.ts). If the records moved since step 3 the write
 *      does not land, and steps 3 to 5 run again against the new records.
 *
 * NOTHING EXECUTES HERE. A PASS reserves the claim and stops. Money leaves by one of two doors,
 * both after the fact: the post-call action Tavus fires when the conversation ends
 * (settleConversation), or a person approving a held request (resolveDecision). Tavus allows a
 * tool call at most 60 seconds, which is not long enough for a person to approve anything, and an
 * irreversible action should not race the conversation that asked for it.
 *
 * CLOSED MEANS NOTHING MOVES. GATE_MODE is the kill switch, and it covers both doors as well as
 * the deciding: while the gate is closed no executor is called by any route. Approvals made before
 * it closed keep their claims and wait; a person can still deny them.
 */
import { executorFor, type Executor } from "./executor"
import { decisionPreimage, intentPreimage, parseToolArguments, sha256Hex, type ParsedIntent } from "./intent"
import { microToNumber, numberToMicro, parseMicroVar } from "./money"
import { evaluate, type ClaimFacts, type Decision, type Facts } from "./ruleset"
import { say } from "./say"
import {
  approvedForConversation,
  autoSpentToday,
  beginExecution,
  denyUnexecuted,
  finalizeApproved,
  finalizeHeld,
  finalizePlain,
  finishExecutionDone,
  finishExecutionFailed,
  finishExecutionUncertain,
  getClaim,
  getDecision,
  heldCountForConversation,
  openDecision,
  type ClaimRow,
  type D1Like,
  type DecidedFields,
  type DecisionRow,
} from "./store"
import type { ToolEnvelope } from "./tavus"

/** The [vars] the gate reads. All plain strings; none is a secret. */
export interface GateVars {
  GATE_MODE?: string
  EXECUTOR?: string
  AUTO_LIMIT_MICRO?: string
  DAILY_BUDGET_MICRO?: string
}

/** Anything other than the exact string "open" is closed. A typo closes the gate; it cannot open it. */
export function gateOpen(vars: GateVars): boolean {
  return vars.GATE_MODE === "open"
}

/** The record as the ruleset sees it. A reservation held by THIS decision reads as open: it is ours to use. */
function claimFacts(row: ClaimRow | null, decisionId: string, nowIso: string): ClaimFacts | null {
  if (!row) return null
  const ours = row.state === "reserved" && row.reserved_by === decisionId
  return {
    state: ours ? "open" : row.state,
    recipient: row.recipient,
    amount_micro: numberToMicro(row.amount_micro),
    expired: row.expires_at !== null && row.expires_at <= nowIso,
  }
}

function buildFacts(vars: GateVars, p: ParsedIntent, claim: ClaimFacts | null, spentMicro: bigint): Facts {
  const budget = parseMicroVar(vars.DAILY_BUDGET_MICRO)
  return {
    gate_open: gateOpen(vars),
    recipient: p.recipient,
    amount: p.amount,
    reference: p.reference,
    reason_present: p.reason.state === "present",
    claim,
    auto_limit_micro: parseMicroVar(vars.AUTO_LIMIT_MICRO),
    budget_remaining_micro: budget > spentMicro ? budget - spentMicro : 0n,
  }
}

/** How many times a write may lose to a concurrent change before the request is failed back to Tavus. */
const MAX_DECIDE_ATTEMPTS = 4

/**
 * Decide one tool call. Returns the recorded decision row, which is the same row for every
 * delivery of the same tool_call_id.
 */
export async function decideTransfer(db: D1Like, vars: GateVars, env: ToolEnvelope, now: Date = new Date()): Promise<DecisionRow> {
  const ts = now.toISOString()
  let row = await openDecision(db, {
    id: crypto.randomUUID(),
    tool_call_id: env.tool_call_id,
    conversation_id: env.conversation_id,
    conversation_tag: (await sha256Hex(env.conversation_id)).slice(0, 12),
    ts,
    day: ts.slice(0, 10),
    args_sha256: await sha256Hex(env.argumentsJson),
  })
  if (row.state !== "pending") return row // already decided: a retry or a replay gets the recorded answer

  const parsed = await parseToolArguments(env.argumentsJson)
  const intent_preimage = await intentPreimage(parsed)
  const intent_sha256 = await sha256Hex(intent_preimage)
  const reference_sha256 = parsed.reference.state === "present" ? await sha256Hex(parsed.reference.value) : null
  const open = gateOpen(vars)
  const executor = executorFor(vars.EXECUTOR)
  const budgetMicro = parseMicroVar(vars.DAILY_BUDGET_MICRO)
  const autoLimitMicro = parseMicroVar(vars.AUTO_LIMIT_MICRO)

  for (let attempt = 0; attempt < MAX_DECIDE_ATTEMPTS; attempt++) {
    const nowIso = new Date().toISOString()
    // A closed gate does not look at the records at all: it has one answer for every request.
    const claimRow = open && parsed.reference.state === "present" ? await getClaim(db, parsed.reference.value) : null
    const spent = open ? numberToMicro(await autoSpentToday(db, row.day)) : 0n
    const facts = buildFacts(vars, parsed, claimFacts(claimRow, row.id, nowIso), spent)
    const decision: Decision = evaluate(facts)
    const decision_preimage = decisionPreimage(intent_sha256, decision)

    const fields: DecidedFields = {
      verdict: decision.verdict,
      disposition: decision.disposition,
      flags: decision.flags.join(","),
      ruleset: decision.ruleset,
      recipient: parsed.recipient.state === "present" ? parsed.recipient.value : null,
      amount_micro: parsed.amount.state === "present" ? microToNumber(parsed.amount.micro) : null,
      claim_id: claimRow ? claimRow.id : null,
      reference_sha256,
      reason_sha256: parsed.reason.state === "present" ? parsed.reason.sha256 : null,
      intent_preimage,
      intent_sha256,
      decision_preimage,
      decision_sha256: await sha256Hex(decision_preimage),
      say: say(decision, {
        amount_micro: parsed.amount.state === "present" ? parsed.amount.micro : undefined,
        recipient: parsed.recipient.state === "present" ? parsed.recipient.value : undefined,
        moves_funds: executor ? !executor.dry_run : false,
      }),
    }

    const reserving = decision.verdict === "PASS" || decision.disposition === "HOLD_FOR_HUMAN"
    if (reserving && fields.recipient !== null && fields.amount_micro !== null && fields.claim_id !== null) {
      const f = { ...fields, recipient: fields.recipient, amount_micro: fields.amount_micro, claim_id: fields.claim_id }
      if (decision.verdict === "PASS") {
        await finalizeApproved(db, row.id, f, { now: nowIso, day: row.day, budget_micro: microToNumber(budgetMicro), auto_limit_micro: microToNumber(autoLimitMicro) })
      } else {
        await finalizeHeld(db, row.id, f, { now: nowIso })
      }
    } else if (reserving) {
      // Unreachable by construction: the ruleset only reaches PASS or a hold with all three present.
      throw new Error("reserving decision without recipient, amount and claim")
    } else {
      await finalizePlain(db, row.id, fields)
    }

    const after = await getDecision(db, row.id)
    if (!after) throw new Error("decision row vanished")
    if (after.state !== "pending") return after
    row = after
    // Still pending: the claim or the budget changed between the read and the write. Read again.
  }
  throw new Error("decision did not settle")
}

export interface SettleSummary {
  executed: number
  failed: number
  uncertain: number
  /** Requests from this conversation still waiting for a person. */
  held: number
}

async function executeOne(db: D1Like, executor: Executor, d: DecisionRow, from: "approved" | "held", summary: SettleSummary): Promise<void> {
  if (d.recipient === null || d.amount_micro === null || d.claim_id === null) return
  const now = new Date().toISOString()
  // Exactly one caller wins this. A second delivery of the post-call action finds nothing to take.
  if (!(await beginExecution(db, d.id, from, now))) return
  let result
  try {
    result = await executor.execute({ decision_id: d.id, recipient: d.recipient, amount_micro: numberToMicro(d.amount_micro) })
  } catch {
    // An executor that throws has told us nothing about whether funds moved.
    result = { outcome: "uncertain" as const, mode: executor.mode, code: "executor_threw" }
  }
  const execution = JSON.stringify({ ...result, at: new Date().toISOString() })
  if (result.outcome === "done") {
    await finishExecutionDone(db, d.id, d.claim_id, execution, new Date().toISOString())
    summary.executed++
  } else if (result.outcome === "failed") {
    await finishExecutionFailed(db, d.id, execution)
    summary.failed++
  } else {
    await finishExecutionUncertain(db, d.id, execution)
    summary.uncertain++
  }
}

export type SettleOutcome = { ok: true; summary: SettleSummary } | { ok: false; error: "gate_closed" | "executor_unavailable" }

/**
 * The post-call door. Executes every decision this conversation had approved, once each.
 * Refuses, changing nothing, while the gate is closed or when no executor exists for the
 * configured EXECUTOR. The approvals keep their claims and can be settled or denied later.
 */
export async function settleConversation(db: D1Like, vars: GateVars, conversationId: string): Promise<SettleOutcome> {
  if (!gateOpen(vars)) return { ok: false, error: "gate_closed" }
  const executor = executorFor(vars.EXECUTOR)
  if (!executor) return { ok: false, error: "executor_unavailable" }
  const summary: SettleSummary = { executed: 0, failed: 0, uncertain: 0, held: 0 }
  for (const d of await approvedForConversation(db, conversationId)) {
    await executeOne(db, executor, d, "approved", summary)
  }
  summary.held = await heldCountForConversation(db, conversationId)
  return { ok: true, summary }
}

export type ResolveOutcome =
  | { ok: true; decision: DecisionRow }
  | { ok: false; error: "not_found" | "conflict" | "gate_closed" | "executor_unavailable" }

/**
 * The human door.
 *   approve  a HELD request. It executes at once: the conversation that asked is usually over, so
 *            no post-call action is coming for it. Refused while the gate is closed.
 *   deny     a request that has not executed, held or approved. Allowed while the gate is closed:
 *            a denial moves nothing.
 */
export async function resolveDecision(db: D1Like, vars: GateVars, decisionId: string, action: "approve" | "deny"): Promise<ResolveOutcome> {
  const d = await getDecision(db, decisionId)
  if (!d) return { ok: false, error: "not_found" }

  if (action === "deny") {
    if (d.state !== "held" && d.state !== "approved") return { ok: false, error: "conflict" }
    if (!(await denyUnexecuted(db, decisionId, new Date().toISOString()))) return { ok: false, error: "conflict" }
  } else {
    if (d.state !== "held") return { ok: false, error: "conflict" }
    if (!gateOpen(vars)) return { ok: false, error: "gate_closed" }
    const executor = executorFor(vars.EXECUTOR)
    if (!executor) return { ok: false, error: "executor_unavailable" }
    const summary: SettleSummary = { executed: 0, failed: 0, uncertain: 0, held: 0 }
    await executeOne(db, executor, d, "held", summary)
    if (summary.executed + summary.failed + summary.uncertain === 0) return { ok: false, error: "conflict" }
  }
  const after = await getDecision(db, decisionId)
  return after ? { ok: true, decision: after } : { ok: false, error: "not_found" }
}
