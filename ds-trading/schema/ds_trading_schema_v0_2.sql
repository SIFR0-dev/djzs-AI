-- ============================================================
-- // DJZS :: deterministic-signal.trading — ATTRIBUTION LEDGER
-- // SCHEMA v0.2 — Kalshi event-contract lane (DJZS-M)
-- // SUPERSEDES v0.1 (1d6a829a…f49ab3) — never applied; superseded
-- //   pre-execution on the 2026-08-21 fixed-point ruling.
-- // CHANGE: no floats on the money path. All price/probability
-- //   columns are INTEGER e4 units ($0.0001 / prob 0.0001 —
-- //   matches Kalshi's *_dollars 4-decimal wire format and the
-- //   adapter's fixed.ts). Quantities are INTEGER e2 units
-- //   (0.01 contracts — matches count_fp). Brier terms are
-- //   INTEGER e8 (product of two e4 quantities). REAL appears
-- //   nowhere in this schema.
-- ============================================================

-- 1. VERDICTS — one row per audit. Stamped PRE-outcome. The spine.
CREATE TABLE IF NOT EXISTS verdicts (
  verdict_id      TEXT PRIMARY KEY,                -- uuid
  created_at      TEXT NOT NULL,                   -- ISO8601, stamp time
  source          TEXT NOT NULL CHECK (source IN ('user','signal_box')),
  signal_spec     TEXT,                            -- SC-xx when source=signal_box
  subject         TEXT NOT NULL,
  thesis          TEXT NOT NULL,
  market_ticker   TEXT,
  side            TEXT CHECK (side IN ('yes','no')),
  p_claim_e4      INTEGER CHECK (p_claim_e4 BETWEEN 0 AND 10000),
  market_price_e4 INTEGER CHECK (market_price_e4 BETWEEN 0 AND 10000),
  fee_est_e4      INTEGER CHECK (fee_est_e4 >= 0), -- $ e4 per contract
  taxonomy        TEXT NOT NULL DEFAULT 'DJZS-M v1',
  flags           TEXT NOT NULL DEFAULT '[]',      -- JSON array of fired codes
  risk_score      INTEGER NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('PASS','WAIT','FAIL')),
  verdict_hash    TEXT NOT NULL,                   -- sha256, computed never improvised
  x402_receipt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_verdicts_market ON verdicts (market_ticker);
CREATE INDEX IF NOT EXISTS idx_verdicts_source ON verdicts (source, created_at);

-- 2. EXECUTIONS — the gate, structurally. FK = no order without a verdict.
CREATE TABLE IF NOT EXISTS executions (
  execution_id    TEXT PRIMARY KEY,
  verdict_id      TEXT NOT NULL REFERENCES verdicts (verdict_id),
  created_at      TEXT NOT NULL,
  market_ticker   TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('yes','no')),
  count_e2        INTEGER NOT NULL CHECK (count_e2 > 0),      -- 0.01-contract units
  entry_price_e4  INTEGER NOT NULL CHECK (entry_price_e4 BETWEEN 0 AND 10000),
  venue_order_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','filled','partial','canceled','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_exec_verdict ON executions (verdict_id);

-- 3. RESOLUTIONS — ground truth per market.
CREATE TABLE IF NOT EXISTS resolutions (
  market_ticker TEXT PRIMARY KEY,
  resolved_at   TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('yes','no','void'))
);

-- 4. OUTCOMES — the attribution join, graded post-resolution.
--    filter alpha = PASS-cohort expectancy vs FAIL-cohort counterfactual.
CREATE TABLE IF NOT EXISTS outcomes (
  verdict_id       TEXT PRIMARY KEY REFERENCES verdicts (verdict_id),
  graded_at        TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('yes','no','void')),
  win              INTEGER CHECK (win IN (0,1)),   -- NULL on void
  pnl_e4_per_ct    INTEGER,                        -- gross $ e4 per contract
  brier_thesis_e8  INTEGER CHECK (brier_thesis_e8 BETWEEN 0 AND 100000000),
  brier_market_e8  INTEGER CHECK (brier_market_e8 BETWEEN 0 AND 100000000)
);

-- 5. SIGNAL_SPECS — registered classes. Hash BEFORE first shadow signal.
CREATE TABLE IF NOT EXISTS signal_specs (
  spec_id       TEXT PRIMARY KEY,                  -- 'SC-03'
  version       TEXT NOT NULL,
  spec_hash     TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','shadow','live','retired')),
  params        TEXT NOT NULL DEFAULT '{}',        -- JSON, frozen
  kill_criteria TEXT NOT NULL DEFAULT '{}'         -- JSON, pre-registered
);

-- 6. META — versioning. Weights and schemas never drift silently.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
