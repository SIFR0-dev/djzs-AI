-- Q3 protocol v1.2 · polymarket_price
-- VWAP of on-chain trades on ONE Polymarket outcome token in [captured_at - window_min minutes, captured_at).
-- Source: polymarket_polygon.market_trades (Dune curated; columns per docs.dune.com/data-catalog/curated/prediction-markets/polymarket/market_trades)
-- Params (Dune wraps text params in quotes itself):
--   token_id    text    ERC-1155 outcome token id as a decimal string (market_trades.asset_id, UINT256)
--   captured_at text    ISO-8601 UTC, e.g. 2026-09-03T14:37:00.000Z (the Phase B timestamp)
--   window_min  number  lookback in minutes, default 60
-- Output: EXACTLY ONE ROW — vwap · trade_count · volume_usdc · window_start · window_end.
--   vwap is NULL when trade_count = 0 (the row is still returned).
-- Counting rule: taker legs only (is_taker_side), so each CLOB match is one trade — Polymarket's published
--   single-counted volume methodology. Both legs of a match carry the same price, so VWAP is unaffected; trade_count is not doubled.
WITH bounds AS (
  SELECT
    date_add('minute', -1 * CAST({{window_min}} AS BIGINT),
             CAST(from_iso8601_timestamp({{captured_at}}) AT TIME ZONE 'UTC' AS TIMESTAMP)) AS window_start,
    CAST(from_iso8601_timestamp({{captured_at}}) AT TIME ZONE 'UTC' AS TIMESTAMP)            AS window_end
),
trades AS (
  SELECT t.price, t.shares
  FROM polymarket_polygon.market_trades t
  CROSS JOIN bounds b
  WHERE t.block_month >= CAST(date_trunc('month', b.window_start) AS DATE)
    AND t.block_month <= CAST(date_trunc('month', b.window_end)   AS DATE)
    AND t.block_time  >= b.window_start
    AND t.block_time  <  b.window_end
    AND CAST(t.asset_id AS VARCHAR) = trim({{token_id}})
    AND t.is_taker_side
    AND t.shares > 0
)
SELECT
  SUM(price * shares) / NULLIF(SUM(shares), 0)  AS vwap,
  COUNT(*)                                       AS trade_count,
  COALESCE(SUM(price * shares), 0e0)             AS volume_usdc,
  (SELECT window_start FROM bounds)              AS window_start,
  (SELECT window_end   FROM bounds)              AS window_end
FROM trades
