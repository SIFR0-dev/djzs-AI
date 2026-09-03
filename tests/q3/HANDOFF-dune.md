// HANDOFF → scan instance · protocol v1.2 · Dune half
// repo ~/djzs-om · main · protocol tests/q3/PROTOCOL.md (append-only; do not edit the body)

TASK
Publish two PUBLIC saved Dune queries over polymarket_polygon.market_trades and commit their SQL + IDs.
The seat's tooling is already on main and depends only on the OUTPUT columns below — not on the table's schema.
You can see the schema; write the SQL to fit it. Do not guess column names: inspect first.

1. CONNECT
   claude mcp add --scope user --transport http dune https://api.dune.com/mcp/v1
   (OAuth in browser.) Then: searchTables "polymarket_polygon market_trades" → note the real column names
   for: timestamp, outcome token id, price, shares, USDC amount, condition id, question text.

2. QUERY A — polymarket_price   (params: token_id text · captured_at text ISO-8601 · window_min integer, default 60)
   Trades on {{token_id}} in [captured_at − window_min min, captured_at). Return EXACTLY ONE ROW:
     vwap          double   Σ(price·shares)/Σ(shares)   (NULL if no trades — still return the row)
     trade_count   bigint
     volume_usdc   double   Σ(price·shares)
     window_start  timestamp (inclusive)
     window_end    timestamp (exclusive)

3. QUERY B — polymarket_pool   (params: n integer default 5 · exclude text, comma-separated condition_ids, may be empty)
   Top-{{n}} markets by 24h volume, excluding {{exclude}}. Return columns:
     condition_id · question · token_id_yes · token_id_no · volume_24h_usdc · last_price_yes

4. TEST via MCP before saving as final
   Run A with a real token_id and captured_at = now → one row, five columns, trade_count > 0.
   Run A with window_min=1 on an illiquid token → one row, vwap NULL, trade_count 0 (the NULL path must work).
   Run B with n=5, exclude="" → five rows.

5. PUBLISH + COMMIT
   Both queries PUBLIC (a third party must be able to re-run them).
   Commit SQL verbatim to tests/q3/queries/polymarket_price.sql and polymarket_pool.sql.
   Set price_query_id and pool_query_id in tests/q3/dune.json. Leave window_min / price_tolerance alone.
   cd ~/djzs-om && npx tsx tests/q3/q3-verify.ts   → must PASS
   git add tests/q3 && git commit -m "q3 v1.2: public Dune queries — price (VWAP) + pool; IDs in dune.json" && git push

6. FROM THEN ON, for every venue=polymarket record
   market.token_id = the audited outcome's token id (required)
   Phase B: npx tsx tests/q3/q3-log.ts --phase-b <id> --price-from-dune   (no --price)
   Pool selection per §3: run B, exclude condition_ids already in tests/q3/records/**.

DO NOT
   edit PROTOCOL.md above ## Amendments · rename dune.json · change output column names · save the queries private
   · look up any price before Phase A is hashed and committed

CONTRACT DOC  tests/q3/queries/README.md   ·   KEY  DUNE_API_KEY is in .dev.vars and CI (not needed for MCP)

---
EXECUTION RECORD — 2026-09-03, remote scan instance (no MCP session available)
- Schema inspected from Dune's published table docs, not via MCP: market_trades = block_time · condition_id (VARBINARY) ·
  question · asset_id (UINT256, the outcome token id) · price · shares · amount (USD) · is_taker_side; market_details =
  condition_id (VARCHAR 0x…) · token_id (UINT256) · outcome_index (0 = YES side, 1 = NO side, positional) · question.
- SQL written against those columns and committed (steps 2–3). Steps 1, 4, 5-publish could not run here: the container has
  no Dune MCP, no browser for OAuth, and no DUNE_API_KEY (.dev.vars is untracked). Both endpoints answer 401 unauthenticated.
- Substitute path, needs only the key: `npx tsx tests/q3/dune-publish.ts` creates both queries PUBLIC via the REST API
  (Analyst plan or higher; Read/Write key scope), runs the step-4 checks, and writes the IDs into dune.json. IDs stay null
  until that runs. If the plan lacks query endpoints, paste each .sql into a new query in the Dune UI, set the parameters
  (token_id text · captured_at text · window_min number=60 / n number=5 · exclude text=""), make it public, and run
  `npx tsx tests/q3/dune-publish.ts --test` after typing the IDs into dune.json.
