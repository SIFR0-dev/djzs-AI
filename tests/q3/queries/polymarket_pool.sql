-- Q3 protocol v1.9 · polymarket_pool
-- Top-{{n}} Polymarket markets by 24h traded notional WITHIN THE SCAN'S CATEGORIES (v1.5 rule 1), excluding venue-native
-- short-dated markets (v1.9, with v1.8's recurrence tags as the fallback proxy) and condition_ids already in the book
-- (§3 coverage pool). Rule 2: the exact venue labels are committed here and in tests/q3/lib.ts (POOL_TAGS_INCLUDE /
-- POOL_TAGS_EXCLUDE_CATEGORY / POOL_TAGS_EXCLUDE_RECURRENCE), not asserted.
--
-- UNIT: SUM(shares) — $1 of notional per share, which is what Polymarket publishes as its volume. Measured 2026-09-10,
--   Gamma's volume24hr equals Sum(size) at ratio 0.996-1.023 across three markets from 0.007 to 0.46, while
--   Sum(price*size) lands at 0.027-0.494 because premium tracks the price. The output column keeps the name
--   volume_24h_usdc for contract stability; a share settles at $1, so the count IS the USD notional.
--
-- TAGS are ARRAY(VARCHAR) at source, so there is nothing to parse: no json_parse, no split, no bracket/quote
--   stripping. json_parse(tags) was not a wrong answer, it was a TYPE ERROR — json_parse takes VARCHAR — and TRY does
--   not swallow analysis-time type failures, so the query could not have compiled. Matching is ARRAY CONTAINMENT on
--   whole tags, both sides lower-cased: the set is non-positional, mixed case, 3-7 per market and contains non-ASCII,
--   and v1.8's exclusions include the bare tags Up, Down, 1H, which a substring or word-boundary regex would fire on
--   inside unrelated text. A NULL tag array is coerced to an empty array, which no INCLUDE label intersects, so an
--   untagged market is excluded by the same rule that excludes an out-of-category one rather than by an error.
--   INCLUDE (any one admits): Politics · Elections · Geopolitics · World · Economy · Fed · Finance · Crypto
--   EXCLUDE, CATEGORY (any one rejects, always):   Sports · Esports · Culture · entertainment · Weather   [v1.5]
--   EXCLUDE, RECURRENCE (fallback proxy only):     Recurring · Up · Down · 5M · 15M · 1H · 4H             [v1.8]
--   A market with NO market_details row has no tags and cannot be classified; it is NOT in the pool until the API
--   snapshot catches up, because showing it as in-category would be an assertion.
--
-- DURATION (v1.9), which supersedes the recurrence tags wherever the venue publishes a close time:
--   A candidate is excluded when the interval from THIS EXECUTION to its scheduled resolution is under 24 hours,
--   computed from market_details.market_end_time — the venue's own published number, not an inference from tags.
--   market_end_time is timestamp(3) with time zone, the SAME type now() returns, so the test is a direct comparison:
--   no parse, no cast, no TRY. There is no unparseable case to defend against, only a NULL one — a market for which
--   the venue published no close at all, which is the only thing that falls through to the v1.8 tag proxy.
--   Where close_time IS NULL the v1.8 recurrence tags decide, exactly as they did before this amendment. Where it is
--   present it GOVERNS in both directions: a market tagged 1H that closes in a week is admitted, and an untagged
--   market that closes in an hour is excluded. The v1.5 category exclusions are unaffected and apply either way.
--   GRANULARITY: a real timestamp, so a midnight value is a MIDNIGHT CLOSE, not a date that lost its clock. Roughly
--   43% of open markets close at exactly 00:00:00Z (measured on the same field via Gamma 2026-09-10: 597 of 1395),
--   which is a venue scheduling convention and nothing more. The value is used exactly as published and never rounded
--   to end-of-day. There is no rounding error and no directional bias in the duration test. See SCAN_SPEC §1.
--   close_time and close_basis are returned so a re-run shows WHICH test admitted each row; a pool whose rows all
--   come back close_basis='v1.8 tag proxy' means market_end_time is not populated, which the publish check surfaces
--   rather than letting the duration rule silently no-op.
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
-- COLUMN RECONCILIATION against the 35-column market_details schema — every reference in this file, typed, so the
-- next execution fails for a new reason or not at all:
--   condition_id      VARCHAR        details side of the join; lower()-ed. VARBINARY on market_trades, hence the
--                                    '0x' || to_hex() normalization — the two sides are genuinely different types.
--   tags              ARRAY(VARCHAR) consumed by transform/array_intersect directly. NOT a JSON string.
--   market_end_time   timestamp(3) with time zone — compared to now() directly. NOT parsed, NOT cast.
--   token_id          UINT256        CAST to VARCHAR before comparison and output (a UINT256 does not survive JSON).
--   outcome_index     INTEGER        compared to bare 0 / 1, no cast.
--   question          VARCHAR        MAX() for the collapse to one row per condition.
--   polymarket_link   VARCHAR        returned as the recurrence oracle, never filtered on.
--   last_changed_at   TIMESTAMP      max_by / ORDER BY key for picking the freshest snapshot.
-- COERCIONS THAT REMAIN, and why each is a real conversion between genuinely different types rather than a defensive
-- one on an already-correct column — the class this file no longer contains:
--   '0x' || lower(to_hex(condition_id))   trades' VARBINARY -> details' VARCHAR hex. Different types; required.
--   CAST(asset_id AS VARCHAR)             UINT256 -> decimal string (a UINT256 does not survive JSON). Required.
--   CAST(token_id AS VARCHAR)             same, on the details side.
--   CAST(date_trunc(...) AS DATE)         date_trunc returns a timestamp; block_month is a DATE. Required.
--   lower(trim(x)) on the {{exclude}} arg operates on a PARAM string, not a column, so normalizing it is the point.
--   lower(condition_id) on the details side is case NORMALIZATION for the join, not a type coercion, and is the
--     ruled-correct form of the join.
--   COALESCE(tags, ARRAY[]) guards a NULL VALUE, not a wrong type: it makes an untagged market fail the INCLUDE
--     intersect explicitly instead of relying on NULL propagation through cardinality().
-- Params (text params are substituted RAW by Dune — quote them in SQL as '{{param}}'; number params unquoted):
--   n        number  pool size, default 5
--   exclude  text    comma-separated 0x condition_ids already recorded; may be empty ("")
-- Output columns: condition_id · question · token_id_yes · token_id_no · volume_24h_usdc · last_price_yes · tags ·
--                 close_time · close_basis · polymarket_link
--   polymarket_link is returned ONLY as an ORACLE for the publish check: a venue-native recurrence market names
--   itself in its own URL (updown-<n>m / updown-<n>h), so the check can assert the duration rule excluded it WITHOUT
--   the query ever matching on a slug. The slug is never a criterion here — nothing in this file filters on it.
--   tags is returned so a re-run shows WHY each row qualified (the publish check asserts on it).
--   close_time is returned as the timestamp it is; a NULL there means the venue published no close for that market.
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
  SELECT cid_hex,
         max_by(tags, last_changed_at)             AS tags,
         max_by(market_end_time, last_changed_at)  AS market_end_time
  FROM (
    SELECT lower(condition_id) AS cid_hex, tags, market_end_time, last_changed_at
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
    transform(COALESCE(tags, CAST(ARRAY[] AS ARRAY(VARCHAR))), x -> lower(trim(x))) AS tags_norm,
    -- v1.9: market_end_time IS the close time. It is timestamp(3) with time zone on the table, and now() is the same
    -- type, so it is compared as-is in `classified` with no parse, no cast and no TRY. NULL means the venue published
    -- no close for this market, which is the ONLY case that falls through to the v1.8 tag proxy.
    market_end_time AS close_time
  FROM meta
),
classified AS (
  SELECT v.cid_hex, v.volume_24h_usdc, v.question_from_trades, t.tags, t.close_time,
         CASE WHEN t.close_time IS NOT NULL THEN 'close time' ELSE 'v1.8 tag proxy' END AS close_basis
  FROM vol v
  JOIN tagged t ON t.cid_hex = v.cid_hex
  -- v1.5 rule 1: a scan category, and none of the category exclusions. Applies whatever the close time says.
  WHERE cardinality(array_intersect(t.tags_norm, ARRAY['politics','elections','geopolitics','world','economy','fed','finance','crypto'])) > 0
    AND cardinality(array_intersect(t.tags_norm, ARRAY['sports','esports','culture','entertainment','weather'])) = 0
    -- v1.9: under 24h to the published close is out; with no published close, v1.8's tags stand in for it.
    AND CASE
          WHEN t.close_time IS NOT NULL THEN t.close_time >= now() + INTERVAL '24' HOUR
          ELSE cardinality(array_intersect(t.tags_norm, ARRAY['recurring','up','down','5m','15m','1h','4h'])) = 0
        END
),
top AS (
  SELECT cid_hex, volume_24h_usdc, question_from_trades, tags, close_time, close_basis
  FROM classified
  ORDER BY volume_24h_usdc DESC
  LIMIT {{n}}
),
details AS (
  SELECT
    lower(condition_id)         AS cid_hex,
    CAST(token_id AS VARCHAR)   AS token_id,
    outcome_index, question, polymarket_link,
    row_number() OVER (PARTITION BY token_id ORDER BY last_changed_at DESC) AS rn
  FROM polymarket_polygon.market_details
  WHERE lower(condition_id) IN (SELECT cid_hex FROM top)
),
from_details AS (
  SELECT cid_hex,
    MAX(CASE WHEN outcome_index = 0 THEN token_id END) AS token_id_yes,
    MAX(CASE WHEN outcome_index = 1 THEN token_id END) AS token_id_no,
    MAX(question)                                       AS question,
    MAX(polymarket_link)                                AS polymarket_link
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
    t.cid_hex, t.volume_24h_usdc, t.tags, t.close_time, t.close_basis,
    COALESCE(fd.question,     t.question_from_trades) AS question,
    fd.polymarket_link,
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
  s.tags,
  s.close_time,
  s.close_basis,
  s.polymarket_link
FROM sides s
LEFT JOIN last_yes ly ON ly.cid_hex = s.cid_hex AND ly.rn = 1
ORDER BY s.volume_24h_usdc DESC
