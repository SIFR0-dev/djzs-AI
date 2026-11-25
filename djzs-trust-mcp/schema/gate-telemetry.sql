-- gate-telemetry.sql
-- D1 schema for the djzs-gate-telemetry database (wrangler binding: TELEMETRY).
--
-- Apply with:
--   wrangler d1 execute djzs-gate-telemetry --remote --file schema/gate-telemetry.sql
-- Operator-side. Idempotent: every statement is IF NOT EXISTS, so re-applying is safe.
--
-- ── PRIVACY ───────────────────────────────────────────────────────────────
-- NO IP ADDRESS IS RECORDED HERE, and none may be added. There is deliberately
-- no column for one — not the raw address, not a hash of it, not CF-Connecting-IP.
-- What is stored is the request SHAPE (User-Agent, Accept, method, path) plus two
-- coarse Cloudflare fields (country, ASN) that describe a network, not a person.
-- That is exactly what the E3 question needs: "did any non-browser fetch of / announce
-- text/html?" is answered by Accept and User-Agent alone. Widening this table to
-- per-caller identity would collect more than the question requires, so it does not.

-- ── surface_fetch ─────────────────────────────────────────────────────────
-- One row per request to one of the six enrichment paths. Written from the
-- discovery middleware in src/index.ts, always via waitUntil and never on the
-- response path.
--
-- EVERY caller is recorded, browser or not. The browser/non-browser split is a
-- QUERY-TIME classification, and a heuristic one — see DEPLOY_RUNBOOK Step 10.
-- Filtering at write time would destroy the evidence the E3 branches are keyed on.
CREATE TABLE IF NOT EXISTS surface_fetch (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,          -- ISO8601 UTC, e.g. 2026-08-26T01:56:46.123Z
  path       TEXT    NOT NULL,          -- one of the six enrichment paths, verbatim
  branch     TEXT    NOT NULL CHECK (branch IN ('landing','status','surface')),
  method     TEXT    NOT NULL,
  user_agent TEXT,                      -- nullable: header may be absent
  accept     TEXT,                      -- nullable: ABSENT IS THE SIGNAL (Go net/http sends none)
  cf_country TEXT,                      -- coarse: request.cf.country
  cf_asn     TEXT,                      -- coarse: request.cf.asn, stored as text
  ray        TEXT                       -- cf-ray, for correlating with Cloudflare logs
);

-- ts is the only access pattern: every E3 query is a window ("since deploy",
-- "T+48h", "T+7d") optionally grouped by shape.
CREATE INDEX IF NOT EXISTS idx_surface_fetch_ts ON surface_fetch (ts);

-- ── bazaar_scan ───────────────────────────────────────────────────────────
-- One row per scheduled full-catalog scan of the CDP x402 discovery index.
-- A failed scan writes a row WITH `error` set rather than writing nothing —
-- a missing row must mean "the cron did not run", never "the scan failed".
CREATE TABLE IF NOT EXISTS bazaar_scan (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT    NOT NULL,             -- ISO8601 UTC
  total   INTEGER,                      -- pagination.total as last reported; null if never read
  pages   INTEGER,                      -- pages actually fetched
  found   INTEGER NOT NULL CHECK (found IN (0,1)),
  detail  TEXT,                         -- JSON array of matching items, or null when none
  error   TEXT                          -- null on success; message on failure
);

CREATE INDEX IF NOT EXISTS idx_bazaar_scan_ts ON bazaar_scan (ts);

-- ── try_verdict / try_day ─────────────────────────────────────────────────
-- Quota for the FREE audit route (POST /try/verdict, src/try-route.ts; ruling 2026-09-27,
-- "sell the receipt"). One row per (UTC day, wallet) holding how many free verdicts that
-- wallet has taken; one row per day holding the total, so the free tier has a ceiling.
--
-- PRIVACY. Still no IP address, and none may be added here either. The wallet address is
-- the caller's own quota key: they sign an EIP-191 text naming it to claim a free verdict,
-- so storing it records what they asked for, not where they came from. No intent text, no
-- verdict, no user agent is stored in these tables. Rows for past days can be dropped freely.
--
-- The Worker creates these itself (CREATE TABLE IF NOT EXISTS, once per isolate), so a deploy
-- needs no migration; this copy is the operator's reference and is idempotent to re-apply.
CREATE TABLE IF NOT EXISTS try_verdict (
  day      TEXT    NOT NULL,             -- UTC calendar day, YYYY-MM-DD
  address  TEXT    NOT NULL,             -- checksummed wallet address (the signer)
  n        INTEGER NOT NULL DEFAULT 0,   -- free verdicts taken today; capped at 5 in code
  first_ts TEXT    NOT NULL,             -- ISO8601 UTC of the first reservation
  last_ts  TEXT    NOT NULL,             -- ISO8601 UTC of the latest reservation
  PRIMARY KEY (day, address)
);

CREATE TABLE IF NOT EXISTS try_day (
  day TEXT PRIMARY KEY,                  -- UTC calendar day
  n   INTEGER NOT NULL DEFAULT 0         -- free verdicts served today, all wallets; capped by TRY_GLOBAL_DAILY_LIMIT
);

-- ── pay_session (pay link, 2026-11-24) ────────────────────────────────────
-- One row per browser pay link (src/pay-link.ts). Minted when a paid MCP tool is called with no
-- payment; the page at https://mcp.djzs.ai/pay/<id> pays it; get_paid_audit reads it.
--
-- PRIVACY. No IP address, no user agent, no user identity. `args` holds the tool arguments the
-- caller sent (the thesis text and, if they passed one, the agent wallet), because the paid call is
-- replayed from them; `result` holds the paid tool's answer, which is anchored publicly anyway.
-- Rows are deleted by the daily cron a week after the link expires.
--
-- The Worker creates this itself on first use; this copy is the operator's reference.
CREATE TABLE IF NOT EXISTS pay_session (
  id          TEXT PRIMARY KEY,          -- ps_ + 22 base64url characters (128 random bits)
  tool        TEXT NOT NULL,             -- verify_pm_trade | verify_perp_trade
  args        TEXT NOT NULL,             -- JSON: the validated tool arguments, replayed on payment
  accepts     TEXT NOT NULL,             -- JSON: the x402 requirements quoted on the unpaid call
  resource    TEXT NOT NULL,             -- JSON: the x402 resource info from the same answer
  status      TEXT NOT NULL,             -- pending | paying | paid | refused | uncertain
  created_at  TEXT NOT NULL,             -- ISO8601 UTC
  expires_at  TEXT NOT NULL,             -- created_at + 30 minutes
  updated_at  TEXT NOT NULL,
  result      TEXT,                      -- JSON: the paid tool's structuredContent (paid) or refusal (refused)
  payment     TEXT,                      -- JSON: x402/payment-response (transaction, network, payer)
  detail      TEXT                       -- fixed code of the last failure, never raw error text
);
CREATE INDEX IF NOT EXISTS idx_pay_session_created ON pay_session (created_at);
