-- Q3 protocol v1.8 · polymarket_pool
-- Top-{{n}} Polymarket markets by 24h traded notional WITHIN THE SCAN'S CATEGORIES (v1.5 rule 1), excluding venue-native
-- recurrence markets (v1.8) and condition_ids already in the book (§3 coverage pool). Rule 2: the exact venue labels are
-- committed here and in tests/q3/lib.ts (POOL_TAGS_INCLUDE / POOL_TAGS_EXCLUDE), not asserted.
--
-- UNIT: SUM(shares) — $1 of notional per share, which is what Polymarket publishes as its volume. Measured 2026-09-10,
--   Gamma's volume24hr equals Sum(size) at ratio 0.996-1.023 across three markets from 0.007 to 0.46, while
--   Sum(price*size) lands at 0.027-0.494 because premium tracks the price. The output column keeps the name
--   volume_24h_usdc for contract stability; a share settles at $1, so the count IS the USD notional.
--
-- TAGS are matched by ARRAY CONTAINMENT on whole tags, both sides lower-cased — never by regex over a flattened string.
--   The tag set is non-positional, mixed case, 3-7 per market, and contains non-ASCII, so a substring or word-boundary
--   regex is both fragile and wrong at the edges: v1.8's exclusions include the bare tags Up, Down, 1H, which a
--   boundary regex would fire on inside unrelated text. `tags` is read as a JSON array where it parses and as a
--   comma-delimited list otherwise, so the match holds under either stored form.
--   INCLUDE (any one admits): Politics · Elections · Geopolitics · World · Economy · Fed · Finance · Crypto
--   EXCLUDE (any one rejects, and exclusion wins): Sports · Esports · Culture · entertainment · Weather   [v1.5]
--                                                  Recurring · Up · Down · 5M · 15M · 1H · 4H             [v1.8]
--   A market with NO market_details row has no tags and cannot be classified; it is NOT in the pool until the API
--   snapshot catches up, because showing it as in-category would be an assertion.
--
-- THE JOIN between the two tables, stated because getting it wrong is silent:
--   market_trades.condition_id is VARBINARY; market_details.condition_id is a 0x-prefixed lowercase hex VARCHAR.
--   The only correct comparison is  lower(md.condition_id) = '0x' || lower(to_hex(t.condition_id)).
--   market_details is ONE ROW PER OUTCOME TOKEN, so joining trades to it directly fans every trade x2 on a binary and
--   xN on a multi-outcome market — which would inflate pool volume non-uniformly BY OUTCOME COUNT, a selection bias
--   rather than a rounding error. Trades are therefore pre-aggregated to one row per condition (`vol`) BEFORE any join,
--   and market_details is collapsed to one row per condition (`meta`, max_by on last_changed_at) before being joined.
--   Both sides of `classified` are one row per market by construction, so the join cannot fan.
--
-- Sources: polymarket_polygon.market_trades (volume, last price) · polymarket_polygon.market_details (tags, question, outcome tokens)
-- Params (text params are substituted RAW by Dune — quote them in SQL as '{{param}}'; number params unquoted):
--   n        number  pool size, default 5
--   exclude  text    comma-separated 0x condition_ids already recorded; may be empty ("")
-- Output columns: condition_id · question · token_id_yes · token_id_no · volume_24h_usdc · last_price_yes · tags
--   tags is returned so a re-run shows WHY each row qualified (the publish check asserts on it).
--   token ids are returned as decimal STRINGS (UINT256 does not survive a JSON number).
--   YES/NO are POSITIONAL (market_details.outcome_index 0 / 1), per Dune's note that labels are not reliable.
--   last_price_yes = price of the latest taker trade on token_id_yes in the window (NULL if the YES token did not trade).
WITH parts AS (
  SELECT split('{{exclude}}', ',') AS arr
),
excluded AS (
  SELECT CASE WHEN substr(lower(trim(x)), 1, 2) = '0x' THEN lower(trim(x)) ELSE '0x' || lower(trim(x)) END AS cid_hex
  FROM parts
  CROSS JOIN UNNEST(arr) AS u(x)
  WHERE trim(x) <> ''
),
recent AS (
  SELECT
    '0x' || lower(to_hex(condition_id)) AS cid_hex,
    question,
    CAST(asset_id AS VARCHAR)           AS token_id,
    token_outcome, price, shares, block_time, evt_index
  FROM polymarket_polygon.market_trades
  WHERE block_month >= CAST(date_trunc('month', now() - INTERVAL '24' HOUR) AS DATE)
    AND block_time  >= now() - INTERVAL '24' HOUR
    AND is_taker_side
    AND condition_id IS NOT NULL
    AND shares > 0
),
vol AS (
  -- ONE ROW PER MARKET, computed before any contact with market_details so no join can fan the trades.
  SELECT cid_hex, SUM(shares) AS volume_24h_usdc, MAX(question) AS question_from_trades
  FROM recent
  WHERE cid_hex NOT IN (SELECT cid_hex FROM excluded)
  GROUP BY cid_hex
),
meta AS (
  -- ONE ROW PER MARKET: market_details carries a row per outcome token per snapshot; take the freshest snapshot's tags.
  SELECT cid_hex, max_by(tags, last_changed_at) AS tags
  FROM (
    SELECT lower(condition_id) AS cid_hex, tags, last_changed_at
    FROM polymarket_polygon.market_details
    WHERE condition_id IS NOT NULL
      AND lower(condition_id) IN (SELECT cid_hex FROM vol)
  )
  GROUP BY cid_hex
),
tagged AS (
  SELECT
    cid_hex,
    tags,
    transform(
      COALESCE(TRY(CAST(json_parse(tags) AS ARRAY(VARCHAR))), split(COALESCE(tags, ''), ',')),
      x -> lower(trim(regexp_replace(x, '[\[\]"]', '')))
    ) AS tags_norm
  FROM meta
),
classified AS (
  SELECT v.cid_hex, v.volume_24h_usdc, v.question_from_trades, t.tags
  FROM vol v
  JOIN tagged t ON t.cid_hex = v.cid_hex
  WHERE cardinality(array_intersect(t.tags_norm, ARRAY['politics','elections','geopolitics','world','economy','fed','finance','crypto'])) > 0
    AND cardinality(array_intersect(t.tags_norm, ARRAY['sports','esports','culture','entertainment','weather','recurring','up','down','5m','15m','1h','4h'])) = 0
),
top AS (
  SELECT cid_hex, volume_24h_usdc, question_from_trades, tags
  FROM classified
  ORDER BY volume_24h_usdc DESC
  LIMIT {{n}}
),
details AS (
  SELECT
    lower(condition_id)         AS cid_hex,
    CAST(token_id AS VARCHAR)   AS token_id,
    outcome_index, question,
    row_number() OVER (PARTITION BY token_id ORDER BY last_changed_at DESC) AS rn
  FROM polymarket_polygon.market_details
  WHERE lower(condition_id) IN (SELECT cid_hex FROM top)
),
from_details AS (
  SELECT cid_hex,
    MAX(CASE WHEN outcome_index = 0 THEN token_id END) AS token_id_yes,
    MAX(CASE WHEN outcome_index = 1 THEN token_id END) AS token_id_no,
    MAX(question)                                       AS question
  FROM details
  WHERE rn = 1
  GROUP BY cid_hex
),
from_trades AS (
  SELECT cid_hex,
    MAX(CASE WHEN lower(token_outcome) = 'yes' THEN token_id END) AS token_id_yes,
    MAX(CASE WHEN lower(token_outcome) = 'no'  THEN token_id END) AS token_id_no
  FROM recent
  WHERE cid_hex IN (SELECT cid_hex FROM top)
  GROUP BY cid_hex
),
sides AS (
  SELECT
    t.cid_hex, t.volume_24h_usdc, t.tags,
    COALESCE(fd.question,     t.question_from_trades) AS question,
    COALESCE(fd.token_id_yes, ft.token_id_yes)        AS token_id_yes,
    COALESCE(fd.token_id_no,  ft.token_id_no)         AS token_id_no
  FROM top t
  LEFT JOIN from_details fd ON fd.cid_hex = t.cid_hex
  LEFT JOIN from_trades  ft ON ft.cid_hex = t.cid_hex
),
last_yes AS (
  SELECT r.cid_hex, r.price,
    row_number() OVER (PARTITION BY r.cid_hex ORDER BY r.block_time DESC, r.evt_index DESC) AS rn
  FROM recent r
  JOIN sides s ON s.cid_hex = r.cid_hex AND r.token_id = s.token_id_yes
)
SELECT
  s.cid_hex          AS condition_id,
  s.question,
  s.token_id_yes,
  s.token_id_no,
  s.volume_24h_usdc,
  ly.price           AS last_price_yes,
  s.tags
FROM sides s
LEFT JOIN last_yes ly ON ly.cid_hex = s.cid_hex AND ly.rn = 1
ORDER BY s.volume_24h_usdc DESC
