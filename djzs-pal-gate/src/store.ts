/**
 * store.ts - the gate's only state, in D1: claims, decisions, and nothing else.
 *
 * WHY THE WRITES LOOK THE WAY THEY DO. The engine decides from a READ of the records. Between that
 * read and the write that acts on it, another request can spend the same claim or the last of the
 * day's budget. So no approval is ever written on the strength of the read alone. Each approval is
 * one D1 batch (a transaction) of three statements:
 *
 *   1. reserve the claim for this decision, only if it is still open (or already ours);
 *   2. mark the decision approved, only if the claim is now reserved for it, the claim still names
 *      this recipient and this exact amount, and the limits still have room;
 *   3. release the reservation if step 2 did not land.
 *
 * Either all of it holds at one instant or nothing changes, and the caller re-reads and decides
 * again. Two requests citing one claim cannot both be approved: step 1 lets exactly one through.
 * The conditions in step 2 repeat the ruleset's record checks in SQL on purpose. The ruleset is
 * the decision; the SQL is the guarantee that the decision was still true when it was recorded.
 *
 * ONE TOOL CALL, ONE DECISION. Tavus retries a tool call once on a 5xx or a dropped connection and
 * keeps tool_call_id stable across retries. (conversation_id, tool_call_id) is UNIQUE and a
 * decision row is opened ('pending') before anything else happens, so a retry, a replay of a
 * captured request, or a second delivery racing the first all land on the same row and get the
 * same answer. The key includes the conversation so that nothing depends on tool_call_id being
 * unique across conversations, which Tavus does not promise.
 *
 * WITHOUT D1 THE GATE FAILS CLOSED. The routes answer 503 store_unavailable. An approval that
 * cannot be recorded is not an approval.
 *
 * PRIVACY. No IP address is stored, and there is no column for one. The caller's stated reason is
 * stored as a sha256 and a length, never as text. The claim code is stored on the decision row for
 * the reservation (claim_id) and is never returned by a public route; the public ledger carries
 * its sha256.
 */

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<unknown>
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}
/** The slice of D1 this Worker calls. Structural, like QuotaDB in djzs-trust-mcp/src/try-route.ts. */
export interface D1Like {
  prepare(query: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<unknown[]>
}

export type ClaimState = "open" | "reserved" | "redeemed" | "void"
export interface ClaimRow {
  id: string
  recipient: string
  amount_micro: number
  expires_at: string | null
  issued_at: string
  state: ClaimState
  reserved_by: string | null
  redeemed_at: string | null
}

/**
 *   pending              opened, not yet decided (a crash here is resumed by the retry)
 *   final                decided, nothing reserved: every FAIL, and WAIT for missing info or a closed gate
 *   approved             PASS; claim reserved; waits for the end of the call (a person may still deny it)
 *   held                 WAIT for a person; claim reserved until they approve or deny
 *   executing            an executor has been handed this decision
 *   executed             done; claim redeemed
 *   denied               a person refused it before anything executed; claim released
 *   execution_uncertain  the executor could not say whether funds moved; never retried automatically
 */
export type DecisionState = "pending" | "final" | "approved" | "held" | "executing" | "executed" | "denied" | "execution_uncertain"
export interface DecisionRow {
  id: string
  tool_call_id: string
  conversation_id: string
  conversation_tag: string
  ts: string
  day: string
  state: DecisionState
  verdict: string | null
  disposition: string | null
  flags: string | null
  ruleset: string | null
  recipient: string | null
  amount_micro: number | null
  claim_id: string | null
  reference_sha256: string | null
  reason_sha256: string | null
  args_sha256: string
  intent_preimage: string | null
  intent_sha256: string | null
  decision_preimage: string | null
  decision_sha256: string | null
  say: string | null
  resolved_by: string | null
  resolved_at: string | null
  execution: string | null
}

/** Idempotent. Also in schema/pal-gate.sql for the operator; keep the two in step. */
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS pg_claim (
     id           TEXT    PRIMARY KEY,
     recipient    TEXT    NOT NULL,
     amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
     expires_at   TEXT,
     issued_at    TEXT    NOT NULL,
     state        TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','reserved','redeemed','void')),
     reserved_by  TEXT,
     redeemed_at  TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS pg_decision (
     id                TEXT PRIMARY KEY,
     tool_call_id      TEXT NOT NULL,
     conversation_id   TEXT NOT NULL,
     conversation_tag  TEXT NOT NULL,
     ts                TEXT NOT NULL,
     day               TEXT NOT NULL,
     state             TEXT NOT NULL CHECK (state IN ('pending','final','approved','held','executing','executed','denied','execution_uncertain')),
     verdict           TEXT,
     disposition       TEXT,
     flags             TEXT,
     ruleset           TEXT,
     recipient         TEXT,
     amount_micro      INTEGER,
     claim_id          TEXT,
     reference_sha256  TEXT,
     reason_sha256     TEXT,
     args_sha256       TEXT NOT NULL,
     intent_preimage   TEXT,
     intent_sha256     TEXT,
     decision_preimage TEXT,
     decision_sha256   TEXT,
     say               TEXT,
     resolved_by       TEXT,
     resolved_at       TEXT,
     execution         TEXT,
     UNIQUE (conversation_id, tool_call_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_decision_conv ON pg_decision (conversation_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_decision_ts ON pg_decision (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_decision_day ON pg_decision (day, state)`,
]

/** One CREATE pass per D1 handle per isolate. Keyed on the binding object. */
const schemaReady = new WeakMap<object, Promise<void>>()
export function ensureSchema(db: D1Like): Promise<void> {
  let p = schemaReady.get(db)
  if (!p) {
    p = (async () => {
      for (const sql of SCHEMA_SQL) await db.prepare(sql).bind().run()
    })()
    p.catch(() => schemaReady.delete(db)) // a failed CREATE is retried on the next request
    schemaReady.set(db, p)
  }
  return p
}

/** Decision states that hold a claim reservation. Step 3 of every batch keeps the reservation for these. */
const HOLDING = "('approved','held','executing','executed','execution_uncertain')"
/** States that count against the day's automatic budget (operator-approved holds do not). */
const SPENDING = "('approved','executing','executed','execution_uncertain')"

// ── claims ────────────────────────────────────────────────────────────────────────────────

export async function getClaim(db: D1Like, id: string): Promise<ClaimRow | null> {
  return db.prepare("SELECT * FROM pg_claim WHERE id = ?").bind(id).first<ClaimRow>()
}

/** Returns false when a claim with this id already exists. */
export async function insertClaim(db: D1Like, c: { id: string; recipient: string; amount_micro: number; expires_at: string | null; issued_at: string }): Promise<boolean> {
  const row = await db
    .prepare("INSERT INTO pg_claim (id, recipient, amount_micro, expires_at, issued_at, state) VALUES (?, ?, ?, ?, ?, 'open') ON CONFLICT(id) DO NOTHING RETURNING id")
    .bind(c.id, c.recipient, c.amount_micro, c.expires_at, c.issued_at)
    .first<{ id: string }>()
  return row !== null
}

/** Only an open claim can be voided. A reserved one belongs to a decision; resolve that first. */
export async function voidClaim(db: D1Like, id: string): Promise<boolean> {
  const row = await db.prepare("UPDATE pg_claim SET state = 'void' WHERE id = ? AND state = 'open' RETURNING id").bind(id).first<{ id: string }>()
  return row !== null
}

// ── decisions ─────────────────────────────────────────────────────────────────────────────

export async function getDecision(db: D1Like, id: string): Promise<DecisionRow | null> {
  return db.prepare("SELECT * FROM pg_decision WHERE id = ?").bind(id).first<DecisionRow>()
}

/**
 * Open the decision for a tool call, or return the one that already exists for it.
 * The INSERT is the idempotency lock: whoever arrives second gets the first one's row.
 */
export async function openDecision(
  db: D1Like,
  d: { id: string; tool_call_id: string; conversation_id: string; conversation_tag: string; ts: string; day: string; args_sha256: string },
): Promise<DecisionRow> {
  await db
    .prepare(
      "INSERT INTO pg_decision (id, tool_call_id, conversation_id, conversation_tag, ts, day, state, args_sha256) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(conversation_id, tool_call_id) DO NOTHING",
    )
    .bind(d.id, d.tool_call_id, d.conversation_id, d.conversation_tag, d.ts, d.day, d.args_sha256)
    .run()
  const row = await db
    .prepare("SELECT * FROM pg_decision WHERE conversation_id = ? AND tool_call_id = ?")
    .bind(d.conversation_id, d.tool_call_id)
    .first<DecisionRow>()
  if (!row) throw new Error("decision row missing after insert")
  return row
}

/** What the gate has approved on its own today, in micro-USDC. */
export async function autoSpentToday(db: D1Like, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount_micro), 0) AS spent FROM pg_decision WHERE day = ? AND resolved_by IS NULL AND state IN ${SPENDING}`)
    .bind(day)
    .first<{ spent: number }>()
  return row?.spent ?? 0
}

/** The decided fields written onto a pending row, whatever the outcome. */
export interface DecidedFields {
  verdict: string
  disposition: string
  flags: string
  ruleset: string
  recipient: string | null
  amount_micro: number | null
  claim_id: string | null
  reference_sha256: string | null
  reason_sha256: string | null
  intent_preimage: string
  intent_sha256: string
  decision_preimage: string
  decision_sha256: string
  say: string
}

const SET_DECIDED =
  "verdict = ?, disposition = ?, flags = ?, ruleset = ?, recipient = ?, amount_micro = ?, claim_id = ?, reference_sha256 = ?, reason_sha256 = ?, " +
  "intent_preimage = ?, intent_sha256 = ?, decision_preimage = ?, decision_sha256 = ?, say = ?"

function decidedValues(f: DecidedFields): unknown[] {
  return [
    f.verdict, f.disposition, f.flags, f.ruleset, f.recipient, f.amount_micro, f.claim_id, f.reference_sha256, f.reason_sha256,
    f.intent_preimage, f.intent_sha256, f.decision_preimage, f.decision_sha256, f.say,
  ]
}

/** FAIL, or WAIT with nothing to reserve. Lands only while the row is still pending. */
export async function finalizePlain(db: D1Like, id: string, f: DecidedFields): Promise<void> {
  await db
    .prepare(`UPDATE pg_decision SET state = 'final', ${SET_DECIDED} WHERE id = ? AND state = 'pending'`)
    .bind(...decidedValues(f), id)
    .run()
}

function reserveStmt(db: D1Like, id: string, claimId: string, nowIso: string): D1Stmt {
  return db
    .prepare(
      "UPDATE pg_claim SET state = 'reserved', reserved_by = ? WHERE id = ? AND (state = 'open' OR (state = 'reserved' AND reserved_by = ?)) AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(id, claimId, id, nowIso)
}

function releaseStmt(db: D1Like, id: string, claimId: string): D1Stmt {
  return db
    .prepare(
      `UPDATE pg_claim SET state = 'open', reserved_by = NULL WHERE id = ? AND state = 'reserved' AND reserved_by = ? AND NOT EXISTS (SELECT 1 FROM pg_decision WHERE id = ? AND state IN ${HOLDING})`,
    )
    .bind(claimId, id, id)
}

/** The record conditions an approval or a hold depends on, re-checked inside the write. */
const CLAIM_IS_OURS = "EXISTS (SELECT 1 FROM pg_claim WHERE id = ? AND state = 'reserved' AND reserved_by = ? AND recipient = ? AND amount_micro = ?)"

/**
 * PASS. One transaction: reserve, approve if every condition still holds, release otherwise.
 * The caller re-reads the row afterwards: 'approved' means it landed, 'pending' means the records
 * moved between the read and the write and the request must be decided again.
 */
export async function finalizeApproved(
  db: D1Like,
  id: string,
  f: DecidedFields & { recipient: string; amount_micro: number; claim_id: string },
  ctx: { now: string; day: string; budget_micro: number; auto_limit_micro: number },
): Promise<void> {
  await db.batch([
    reserveStmt(db, id, f.claim_id, ctx.now),
    db
      .prepare(
        `UPDATE pg_decision SET state = 'approved', ${SET_DECIDED} WHERE id = ? AND state = 'pending' AND ${CLAIM_IS_OURS} ` +
          `AND ? <= ? ` +
          `AND (SELECT COALESCE(SUM(amount_micro), 0) FROM pg_decision WHERE day = ? AND resolved_by IS NULL AND state IN ${SPENDING}) + ? <= ?`,
      )
      .bind(
        ...decidedValues(f), id,
        f.claim_id, id, f.recipient, f.amount_micro,
        f.amount_micro, ctx.auto_limit_micro,
        ctx.day, f.amount_micro, ctx.budget_micro,
      ),
    releaseStmt(db, id, f.claim_id),
  ])
}

/** WAIT for a person. The claim is reserved so it cannot be spent elsewhere while they decide. */
export async function finalizeHeld(
  db: D1Like,
  id: string,
  f: DecidedFields & { recipient: string; amount_micro: number; claim_id: string },
  ctx: { now: string },
): Promise<void> {
  await db.batch([
    reserveStmt(db, id, f.claim_id, ctx.now),
    db
      .prepare(`UPDATE pg_decision SET state = 'held', ${SET_DECIDED} WHERE id = ? AND state = 'pending' AND ${CLAIM_IS_OURS}`)
      .bind(...decidedValues(f), id, f.claim_id, id, f.recipient, f.amount_micro),
    releaseStmt(db, id, f.claim_id),
  ])
}

// ── execution ─────────────────────────────────────────────────────────────────────────────

export async function approvedForConversation(db: D1Like, conversationId: string): Promise<DecisionRow[]> {
  const r = await db.prepare("SELECT * FROM pg_decision WHERE conversation_id = ? AND state = 'approved' ORDER BY ts").bind(conversationId).all<DecisionRow>()
  return r.results
}

export async function heldCountForConversation(db: D1Like, conversationId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM pg_decision WHERE conversation_id = ? AND state = 'held'").bind(conversationId).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Take a decision for execution. Exactly one caller gets `true` per decision: a post-call action
 * delivered twice, or racing an operator, cannot execute the same approval twice.
 */
export async function beginExecution(db: D1Like, id: string, from: "approved" | "held", now: string): Promise<boolean> {
  const row =
    from === "approved"
      ? await db.prepare("UPDATE pg_decision SET state = 'executing' WHERE id = ? AND state = 'approved' RETURNING id").bind(id).first<{ id: string }>()
      : await db
          .prepare("UPDATE pg_decision SET state = 'executing', resolved_by = 'operator', resolved_at = ? WHERE id = ? AND state = 'held' RETURNING id")
          .bind(now, id)
          .first<{ id: string }>()
  return row !== null
}

export async function finishExecutionDone(db: D1Like, id: string, claimId: string, executionJson: string, now: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE pg_decision SET state = 'executed', execution = ? WHERE id = ? AND state = 'executing'").bind(executionJson, id),
    db.prepare("UPDATE pg_claim SET state = 'redeemed', redeemed_at = ? WHERE id = ? AND state = 'reserved' AND reserved_by = ?").bind(now, claimId, id),
  ])
}

/** Definitely not sent: the decision goes back to where it was, still holding its claim. */
export async function finishExecutionFailed(db: D1Like, id: string, executionJson: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE pg_decision SET state = 'held', resolved_by = NULL, resolved_at = NULL, execution = ? WHERE id = ? AND state = 'executing' AND resolved_by = 'operator'").bind(executionJson, id),
    db.prepare("UPDATE pg_decision SET state = 'approved', execution = ? WHERE id = ? AND state = 'executing' AND resolved_by IS NULL").bind(executionJson, id),
  ])
}

/** May or may not have been sent. Terminal until a person reconciles it. The claim stays reserved. */
export async function finishExecutionUncertain(db: D1Like, id: string, executionJson: string): Promise<void> {
  await db.prepare("UPDATE pg_decision SET state = 'execution_uncertain', execution = ? WHERE id = ? AND state = 'executing'").bind(executionJson, id).run()
}

/**
 * A person refuses a request that has not executed: one that is held, or one the gate approved and
 * that is still waiting for the end of its call. One transaction: the decision becomes 'denied'
 * and, only if it did, its claim goes back to open. Returns true when THIS call made the denial
 * (the row is 'denied' with this call's timestamp); false when the decision was in any other
 * state, including one an executor had already taken. A denial and an execution race for the same
 * row; exactly one of the two conditional updates lands.
 */
export async function denyUnexecuted(db: D1Like, id: string, now: string): Promise<boolean> {
  await db.batch([
    db.prepare("UPDATE pg_decision SET state = 'denied', resolved_by = 'operator', resolved_at = ? WHERE id = ? AND state IN ('held','approved')").bind(now, id),
    db
      .prepare("UPDATE pg_claim SET state = 'open', reserved_by = NULL WHERE state = 'reserved' AND reserved_by = ? AND EXISTS (SELECT 1 FROM pg_decision WHERE id = ? AND state = 'denied')")
      .bind(id, id),
  ])
  const row = await getDecision(db, id)
  return row !== null && row.state === "denied" && row.resolved_at === now
}

// ── reads for the ledger and the operator ─────────────────────────────────────────────────

export async function recentDecisions(db: D1Like, limit: number): Promise<DecisionRow[]> {
  const r = await db.prepare("SELECT * FROM pg_decision WHERE state != 'pending' ORDER BY ts DESC, id DESC LIMIT ?").bind(limit).all<DecisionRow>()
  return r.results
}

export async function heldDecisions(db: D1Like): Promise<DecisionRow[]> {
  const r = await db.prepare("SELECT * FROM pg_decision WHERE state = 'held' ORDER BY ts").bind().all<DecisionRow>()
  return r.results
}

/**
 * Approved or handed to an executor, and not finished: 'approved' (the post-call action has not
 * run, or ran and the executor reported a clean failure), 'executing' (an execution that never
 * reported back) and 'execution_uncertain'. Each of these still holds its claim.
 */
export async function unsettledDecisions(db: D1Like): Promise<DecisionRow[]> {
  const r = await db
    .prepare("SELECT * FROM pg_decision WHERE state IN ('approved','executing','execution_uncertain') ORDER BY ts")
    .bind()
    .all<DecisionRow>()
  return r.results
}
