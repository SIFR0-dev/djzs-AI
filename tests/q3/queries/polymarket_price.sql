-- Q3 protocol v1.7 · polymarket_price
-- VWAP of on-chain trades on ONE Polymarket outcome token in [captured_at - window_min minutes, captured_at),
-- PLUS the bound market's traded volume at audit (v1.7a) — both from THIS ONE EXECUTION, which is why v1.7(a)
-- adds no additional Dune executions.
-- Source: polymarket_polygon.market_trades · polymarket_polygon.market_details (Dune curated).
-- COLUMN RECONCILIATION against the 35-column market_details schema. This query touches THREE of its columns and all
-- three already agree with it, so nothing here changed in the v1.9 pass — recorded so that is a checked fact rather
-- than an untested assumption:
--   condition_id     VARCHAR    selected and lower()-ed in `market`, then joined to market_trades.condition_id, which
--                               is VARBINARY — hence '0x' || lower(to_hex(...)) on the trades side. The two columns
--                               share a name and not a type; comparing them directly is the silent-failure mode.
--   token_id         UINT256    CAST(token_id AS VARCHAR) before comparing to the {{token_id}} param, which arrives
--                               as a decimal string. Never compared as a number.
--   last_changed_at  TIMESTAMP  ORDER BY key selecting the freshest snapshot for the token.
-- It reads NEITHER tags NOR market_end_time, so the v1.9 corrections to polymarket_pool.sql have no counterpart here
-- and this file's output contract is unchanged.
-- COERCION SWEEP (the class: a defensive parse or cast on a column that is already the right type). This file
-- contains NO member of that class. Every coercion in it converts between genuinely different types, or acts on a
-- PARAM rather than a column:
--   from_iso8601_timestamp('{{captured_at}}')  parses a PARAM STRING. Dune substitutes text params raw, so this
--                                              really is a string and really must be parsed. Not a column.
--   ... AT TIME ZONE 'UTC' AS TIMESTAMP        drops the zone to match market_trades.block_time. A conversion
--                                              between differing types, not a redundant one.
--   CAST({{window_min}} AS BIGINT)             number param -> the type date_add expects.
--   CAST(t.asset_id AS VARCHAR)                UINT256 -> decimal string, to compare with the token_id param.
--   CAST(token_id AS VARCHAR)                  same, on the market_details side.
--   CAST(date_trunc(...) AS DATE)              date_trunc yields a timestamp; block_month is a DATE.
--   '0x' || lower(to_hex(t.condition_id))      trades' VARBINARY -> details' VARCHAR hex.
--   COALESCE(SUM(...), 0e0)                    SUM over no rows is NULL and the contract says 0. Semantics, not a cast.
-- Worth stating plainly: unlike the pool query, THIS query has executed live many times and its VWAP has been
-- verified against sealed records, so these coercions are empirically correct rather than merely argued.
-- Params (text params are substituted RAW by Dune — quote them in SQL as '{{param}}'; number params unquoted):
--   token_id    text    ERC-1155 outcome token id as a decimal string (market_trades.asset_id, UINT256)
--   captured_at text    ISO-8601 UTC, e.g. 2026-09-03T14:37:00.000Z (equals the record's posted_at, v1.2.1)
--   window_min  number  VWAP lookback in minutes, default 60
-- Output: EXACTLY ONE ROW — vwap · trade_count · volume_usdc · window_start · window_end · volume_24h · volume_total
--   vwap is NULL when trade_count = 0 (the row is still returned).
-- Counting rule: taker legs only (is_taker_side), so each CLOB match is one trade — Polymarket's published
--   single-counted volume methodology. Both legs of a match carry the same price, so VWAP is unaffected; trade_count is not doubled.
-- v1.7(a) volume columns:
--   SCOPE is the whole MARKET (both outcome tokens), not just the audited token — v1.7 says "the bound market's
--     traded volume". token_id resolves to its condition_id through market_details (latest snapshot), and the sums
--     run over taker legs on that condition. Two records on opposite sides of one market get the same volume.
--   UNIT is SUM(shares): $1 of notional per share, single-counted over taker legs. A Polymarket share and a Kalshi
--     contract both settle at $1, so shares traded IS the traded USD notional, and it is what BOTH venues publish as
--     their volume. Measured 2026-09-10 against Gamma's own volume24hr on three markets spanning the price range:
--     Sum(size) matched at ratio 0.996-1.023, while Sum(price*size) came in at 0.027-0.494 — it tracks the price,
--     as a premium measure does. Premium weighting would also make the number monotone in price level, so v1.7(b)'s
--     thin stratum would be partly a restatement of the quote it exists to control for.
--     volume_usdc above keeps its v1.2 definition (SUM(price*shares) over the VWAP window, i.e. premium) and is unchanged;
--     it answers a different question and is not comparable to these two columns.
--   volume_24h   = taker-leg amount over [captured_at - 24h, captured_at)   — the 24 hours ending at posted_at.
--   volume_total = taker-leg amount over every trade before captured_at     — cumulative to the audit moment.
--   A market that resolves but has not traded yields 0; a token_id that resolves to NO market yields NULL for both,
--     never 0, because "unknown" and "none" are different answers and a fabricated 0 would enter a sealed record.
--   Both windows end at captured_at over immutable on-chain trades, so re-execution reproduces them exactly, as the price is.
--   Cost note: volume_total is cumulative by definition and so cannot prune block_month from below; the condition_id
--     filter carries the scan. The upper bound is pruned.
WITH bounds AS (
  SELECT
    date_add('minute', -1 * CAST({{window_min}} AS BIGINT),
             CAST(from_iso8601_timestamp('{{captured_at}}') AT TIME ZONE 'UTC' AS TIMESTAMP)) AS window_start,
    CAST(from_iso8601_timestamp('{{captured_at}}') AT TIME ZONE 'UTC' AS TIMESTAMP)            AS window_end,
    date_add('hour', -24,
             CAST(from_iso8601_timestamp('{{captured_at}}') AT TIME ZONE 'UTC' AS TIMESTAMP)) AS vol24_start
),
trades AS (
  SELECT t.price, t.shares
  FROM polymarket_polygon.market_trades t
  CROSS JOIN bounds b
  WHERE t.block_month >= CAST(date_trunc('month', b.window_start) AS DATE)
    AND t.block_month <= CAST(date_trunc('month', b.window_end)   AS DATE)
    AND t.block_time  >= b.window_start
    AND t.block_time  <  b.window_end
    AND CAST(t.asset_id AS VARCHAR) = trim('{{token_id}}')
    AND t.is_taker_side
    AND t.shares > 0
),
market AS (
  SELECT lower(condition_id) AS cid_hex
  FROM polymarket_polygon.market_details
  WHERE CAST(token_id AS VARCHAR) = trim('{{token_id}}')
    AND condition_id IS NOT NULL
  ORDER BY last_changed_at DESC
  LIMIT 1
),
resolved AS (
  SELECT count(*) AS n FROM market
),
mkt_trades AS (
  SELECT t.shares, t.block_time
  FROM polymarket_polygon.market_trades t
  CROSS JOIN bounds b
  JOIN market m ON '0x' || lower(to_hex(t.condition_id)) = m.cid_hex
  WHERE t.block_month <= CAST(date_trunc('month', b.window_end) AS DATE)
    AND t.block_time  <  b.window_end
    AND t.is_taker_side
    AND t.shares > 0
),
vols AS (
  SELECT
    COALESCE(SUM(CASE WHEN mt.block_time >= b.vol24_start THEN mt.shares END), 0e0) AS v24,
    COALESCE(SUM(mt.shares), 0e0)                                                   AS vtot
  FROM mkt_trades mt
  CROSS JOIN bounds b
)
SELECT
  SUM(price * shares) / NULLIF(SUM(shares), 0)  AS vwap,
  COUNT(*)                                       AS trade_count,
  COALESCE(SUM(price * shares), 0e0)             AS volume_usdc,
  (SELECT window_start FROM bounds)              AS window_start,
  (SELECT window_end   FROM bounds)              AS window_end,
  CASE WHEN (SELECT n FROM resolved) = 0 THEN NULL ELSE (SELECT v24  FROM vols) END AS volume_24h,
  CASE WHEN (SELECT n FROM resolved) = 0 THEN NULL ELSE (SELECT vtot FROM vols) END AS volume_total
FROM trades
