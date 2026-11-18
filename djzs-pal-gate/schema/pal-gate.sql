-- pal-gate.sql
-- D1 schema for the djzs-pal-gate database (wrangler binding: DB).
--
-- Apply with:
--   npx wrangler d1 execute djzs-pal-gate --remote --file schema/pal-gate.sql
-- Operator-side. Idempotent: every statement is IF NOT EXISTS, so re-applying is safe.
-- The Worker creates the same tables if they are absent (src/store.ts SCHEMA_SQL). Keep the two in step.
--
-- PRIVACY
-- No IP address is recorded here, and none may be added: there is no column for one.
-- The caller's stated reason is stored as a sha256 (reason_sha256), never as text.
-- The claim code sits on the decision row (claim_id) for the reservation only. No public route
-- returns it; the public ledger carries reference_sha256.

-- pg_claim: a payout the operator issued in advance. One address, one exact amount, single use.
-- This is the RECORD a caller's stated basis is checked against.
CREATE TABLE IF NOT EXISTS pg_claim (
  id           TEXT    PRIMARY KEY,           -- canonical code: uppercase A-Z 0-9, no separators
  recipient    TEXT    NOT NULL,              -- lowercase 0x address; the only address this claim pays
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),  -- exactly what it pays, in micro-USDC
  expires_at   TEXT,                          -- ISO8601 UTC (Date.toISOString), or NULL for no expiry
  issued_at    TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','reserved','redeemed','void')),
  reserved_by  TEXT,                          -- pg_decision.id holding the reservation
  redeemed_at  TEXT
);

-- pg_decision: one row per tool call. (conversation_id, tool_call_id) is UNIQUE: a retry or a
-- replay lands on the same row. See src/store.ts for what each state means and which writes are
-- transactional.
CREATE TABLE IF NOT EXISTS pg_decision (
  id                TEXT PRIMARY KEY,
  tool_call_id      TEXT NOT NULL,            -- Tavus invocation id, stable across retries
  conversation_id   TEXT NOT NULL,            -- Tavus conversation id (never returned by a public route)
  conversation_tag  TEXT NOT NULL,            -- first 12 hex of sha256(conversation_id), for the public ledger
  ts                TEXT NOT NULL,            -- ISO8601 UTC, when the call first arrived
  day               TEXT NOT NULL,            -- UTC day of ts: the budget bucket
  state             TEXT NOT NULL CHECK (state IN ('pending','final','approved','held','executing','executed','denied','execution_uncertain')),
  verdict           TEXT,                     -- PASS | WAIT | FAIL
  disposition       TEXT,
  flags             TEXT,                     -- comma-joined, canonical order
  ruleset           TEXT,
  recipient         TEXT,
  amount_micro      INTEGER,
  claim_id          TEXT,                     -- set only when the cited code resolved to a record
  reference_sha256  TEXT,
  reason_sha256     TEXT,
  args_sha256       TEXT NOT NULL,            -- sha256 of the model's raw arguments string
  intent_preimage   TEXT,
  intent_sha256     TEXT,
  decision_preimage TEXT,
  decision_sha256   TEXT,
  say               TEXT,                     -- the sentence spoken for this decision
  resolved_by       TEXT,                     -- 'operator' when a person approved or denied it
  resolved_at       TEXT,
  execution         TEXT,                     -- JSON: the executor's result
  UNIQUE (conversation_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_pg_decision_conv ON pg_decision (conversation_id, state);
CREATE INDEX IF NOT EXISTS idx_pg_decision_ts ON pg_decision (ts);
CREATE INDEX IF NOT EXISTS idx_pg_decision_day ON pg_decision (day, state);
