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
