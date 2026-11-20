/**
 * executor.ts - the thing that would move the money. In v0.1 nothing does.
 *
 * The gate decides; an executor carries out a decision that was approved. They are separate so the
 * deciding code never holds a key. v0.1 ships exactly one executor, "dry_run": it records what
 * would have been sent and sends nothing. A real USDC executor is NOT in this version. Which wallet
 * signs, where its key lives and how a transfer is confirmed are the operator's rulings (README,
 * open ruling R2), and none of them is answered by code written before they are made.
 *
 * FAIL CLOSED. An EXECUTOR value this file does not know yields no executor at all, and the routes
 * answer 503 executor_unavailable. The gate never reports a payout it cannot make.
 *
 * THREE OUTCOMES, because a money movement has three, not two:
 *   done       it happened; `ref` identifies it.
 *   failed     it definitely did not happen. The approval stands and can be retried.
 *   uncertain  it may or may not have happened. NEVER retried automatically: the operator
 *              reconciles against the chain first. (Same doctrine as djzs-trust-mcp's
 *              SETTLEMENT_UNCERTAIN.)
 */

export interface ExecutionRequest {
  decision_id: string
  /** Lowercase 0x address, already checked against the claim record. */
  recipient: string
  amount_micro: bigint
}

export type ExecutionResult =
  | { outcome: "done"; mode: string; ref: string }
  | { outcome: "failed"; mode: string; code: string }
  | { outcome: "uncertain"; mode: string; code: string }

export interface Executor {
  readonly mode: string
  /** True when a "done" from this executor means no funds moved. Spoken lines must say so. */
  readonly dry_run: boolean
  execute(req: ExecutionRequest): Promise<ExecutionResult>
}

const dryRun: Executor = {
  mode: "dry_run",
  dry_run: true,
  async execute(req) {
    return { outcome: "done", mode: "dry_run", ref: `dryrun:${req.decision_id}` }
  },
}

/** The executor named by the EXECUTOR var, or null when that name is not one this version ships. */
export function executorFor(name: string | undefined): Executor | null {
  return name === "dry_run" ? dryRun : null
}
