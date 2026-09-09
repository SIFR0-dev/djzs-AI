-- Q3 protocol v1.5 · polymarket_pool
-- Top-{{n}} Polymarket markets by single-counted 24h on-chain volume WITHIN THE SCAN'S CATEGORIES (v1.5 rule 1), excluding
-- condition_ids already in the book (§3 coverage pool). Rule 2: the exact venue labels are committed here, not asserted.
--
-- CATEGORY FIELD: polymarket_polygon.market_details.tags (VARCHAR, "Market category tags from the API" — the Polymarket
--   Gamma event tags, several labels per market). Matched as whole words (case-insensitive) on the tags string, so the
--   match is the same whether Dune stores the list as a JSON array or as a delimited string. Labels are Polymarket's own
--   (verified against gamma-api.polymarket.com/tags/slug/<slug> on 2026-09-09):
--   INCLUDE (scan categories — economics, rates/central banks, crypto, domestic politics, geopolitics; financials per
--     tape/config.json):  Politics · Elections · Geopolitics · World · Economy · Fed · Finance · Crypto
--   EXCLUDE (wins over any include on the same market): Sports · Esports · Culture · entertainment · Weather
--     ("Culture" is the label of slug pop-culture; "entertainment" is lowercase at the venue.)
--   A market with NO market_details row yet (API snapshot behind chain) has no tags and cannot be classified; it is NOT
--   in the pool until the snapshot catches up — an unclassifiable market must not be shown as in-category.
--   Word-boundary matching keeps "Esports" from matching "Sports" and "Fed Rates" matching "Fed"; "World Series"/"World Cup"
--   markets carry "Sports" and are excluded by the exclude-wins rule.
--
-- Sources: polymarket_polygon.market_trades (volume, last price) · polymarket_polygon.market_details (tags, question, outcome tokens)
-- Params (text params are substituted RAW by Dune — quote them in SQL as '{{param}}'; number params unquoted):
--   n        number  pool size, default 5
--   exclude  text    comma-separated 0x condition_ids already recorded; may be empty ("")
-- Output columns: condition_id · question · token_id_yes · token_id_no · volume_24h_usdc · last_price_yes · tags
--   tags is returned so a re-run shows WHY each row is in-category (the publish check asserts on it).
--   token ids are returned as decimal STRINGS (UINT256 does not survive a JSON number).
--   YES/NO are POSITIONAL (market_details.outcome_index 0 / 1), per Dune's note that labels (Yes/No, Up/Down, team names) are not
--   reliable; the trades' Yes/No labels remain a fallback for token ids only (every pool row has a market_details row by construction).
--   volume_24h_usdc = SUM(amount) over taker legs (is_taker_side) in the trailing 24h — the documented single-counted volume.
--   last_price_yes  = price of the latest taker trade on token_id_yes in that window (NULL if the YES token did not trade).
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
    token_outcome, price, amount, block_time, evt_index
  FROM polymarket_polygon.market_trades
  WHERE block_month >= CAST(date_trunc('month', now() - INTERVAL '24' HOUR) AS DATE)
    AND block_time  >= now() - INTERVAL '24' HOUR
    AND is_taker_side
    AND condition_id IS NOT NULL
),
vol AS (
  SELECT cid_hex, SUM(amount) AS volume_24h_usdc, MAX(question) AS question_from_trades
  FROM recent
  WHERE cid_hex NOT IN (SELECT cid_hex FROM excluded)
  GROUP BY cid_hex
),
meta AS (
  SELECT
    lower(condition_id) AS cid_hex,
    tags,
    row_number() OVER (PARTITION BY lower(condition_id) ORDER BY last_changed_at DESC) AS rn
  FROM polymarket_polygon.market_details
  WHERE lower(condition_id) IN (SELECT cid_hex FROM vol)
),
classified AS (
  SELECT v.cid_hex, v.volume_24h_usdc, v.question_from_trades, m.tags
  FROM vol v
  JOIN meta m ON m.cid_hex = v.cid_hex AND m.rn = 1
  WHERE regexp_like(lower(m.tags), '(^|[^a-z0-9])(politics|elections|geopolitics|world|economy|fed|finance|crypto)([^a-z0-9]|$)')
    AND NOT regexp_like(lower(m.tags), '(^|[^a-z0-9])(sports|esports|culture|entertainment|weather)([^a-z0-9]|$)')
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
