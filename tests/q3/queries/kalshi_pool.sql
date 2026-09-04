-- Q3 protocol v1.3 · kalshi_pool
-- Top-{{n}} Kalshi markets by USD volume in the 24h ending at the table's freshest fill (NOT now() — the Kalshi feed is
-- partner data and can lag; anchoring to max(created_time) makes the pool well-defined on any day). Excludes tickers in the book.
-- Source: kalshi.market_trades. Params (text RAW, quoted in SQL):
--   n        number  pool size, default 5
--   exclude  text    comma-separated tickers already recorded; may be empty ("")
-- Output columns: ticker · title · volume_24h_usdc · last_price_yes · status · as_of
--   as_of = max(created_time) in the table when the query ran (the window is [as_of - 24h, as_of]); reported so a re-run can be reasoned about.
WITH as_of AS (
  SELECT max(created_time) AS t FROM kalshi.market_trades WHERE block_month >= CAST(date_trunc('month', now() - INTERVAL '35' DAY) AS DATE)
),
parts AS (
  SELECT split('{{exclude}}', ',') AS arr
),
excluded AS (
  SELECT upper(trim(x)) AS ticker FROM parts CROSS JOIN UNNEST(arr) AS u(x) WHERE trim(x) <> ''
),
recent AS (
  SELECT t.ticker, t.title, t.status, t.amount_usd, t.yes_price_dollars, t.created_time, t.trade_id
  FROM kalshi.market_trades t
  CROSS JOIN as_of a
  WHERE t.block_month  >= CAST(date_trunc('month', a.t - INTERVAL '24' HOUR) AS DATE)
    AND t.created_time >= a.t - INTERVAL '24' HOUR
    AND t.created_time <= a.t
    AND t.count_fp > 0
),
top AS (
  SELECT ticker, MAX(title) AS title, MAX(status) AS status, SUM(amount_usd) AS volume_24h_usdc
  FROM recent
  WHERE upper(ticker) NOT IN (SELECT ticker FROM excluded)
  GROUP BY ticker
  ORDER BY volume_24h_usdc DESC
  LIMIT {{n}}
),
last_fill AS (
  SELECT r.ticker, r.yes_price_dollars,
         row_number() OVER (PARTITION BY r.ticker ORDER BY r.created_time DESC, r.trade_id DESC) AS rn
  FROM recent r JOIN top ON top.ticker = r.ticker
)
SELECT
  top.ticker, top.title, top.volume_24h_usdc,
  lf.yes_price_dollars AS last_price_yes,
  top.status,
  (SELECT t FROM as_of) AS as_of
FROM top
LEFT JOIN last_fill lf ON lf.ticker = top.ticker AND lf.rn = 1
ORDER BY top.volume_24h_usdc DESC
