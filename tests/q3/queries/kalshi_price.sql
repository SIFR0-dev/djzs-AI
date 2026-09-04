-- Q3 protocol v1.3 · kalshi_price
-- VWAP of Kalshi fills on ONE market, for the audited side, in [captured_at - window_min minutes, captured_at).
-- Source: kalshi.market_trades (Dune curated, partner data from Kalshi's public feed; docs.dune.com/data-catalog/curated/prediction-markets/kalshi/market_trades)
-- Params (text params are substituted RAW by Dune — quoted in SQL as '{{param}}'; number params unquoted):
--   ticker      text    Kalshi market ticker, e.g. KXFEDDECISION-26SEP-H25
--   side        text    yes | no — the audited side; picks yes_price_dollars or no_price_dollars
--   captured_at text    ISO-8601 UTC — the record's posted_at (window ENDS at the audit moment)
--   window_min  number  lookback in minutes, default 60
-- Output: EXACTLY ONE ROW — vwap · trade_count · volume_usdc · window_start · window_end (same contract as polymarket_price;
--   volume_usdc is USD notional of the audited side). vwap is NULL when trade_count = 0; the row is still returned.
-- Counting: one row per Kalshi fill already (no maker/taker duplication), so no side filter is needed.
WITH bounds AS (
  SELECT
    date_add('minute', -1 * CAST({{window_min}} AS BIGINT),
             CAST(from_iso8601_timestamp('{{captured_at}}') AT TIME ZONE 'UTC' AS TIMESTAMP)) AS window_start,
    CAST(from_iso8601_timestamp('{{captured_at}}') AT TIME ZONE 'UTC' AS TIMESTAMP)            AS window_end
),
fills AS (
  SELECT
    CASE WHEN lower(trim('{{side}}')) = 'no' THEN t.no_price_dollars ELSE t.yes_price_dollars END AS price,
    t.count_fp AS shares
  FROM kalshi.market_trades t
  CROSS JOIN bounds b
  WHERE t.block_month  >= CAST(date_trunc('month', b.window_start) AS DATE)
    AND t.block_month  <= CAST(date_trunc('month', b.window_end)   AS DATE)
    AND t.created_time >= b.window_start
    AND t.created_time <  b.window_end
    AND t.ticker = trim('{{ticker}}')
    AND t.count_fp > 0
)
SELECT
  SUM(price * shares) / NULLIF(SUM(shares), 0)  AS vwap,
  COUNT(*)                                       AS trade_count,
  COALESCE(SUM(price * shares), 0e0)             AS volume_usdc,
  (SELECT window_start FROM bounds)              AS window_start,
  (SELECT window_end   FROM bounds)              AS window_end
FROM fills
