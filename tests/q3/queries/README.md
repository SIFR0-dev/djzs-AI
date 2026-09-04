# Q3 Dune queries — output contracts (protocol v1.2)

Both queries are **saved, public** Dune queries over `polymarket_polygon.market_trades`. Their IDs go in `tests/q3/dune.json`; their SQL is committed here verbatim (`polymarket_price.sql`, `polymarket_pool.sql`). Column names inside the SQL are the scan instance's concern (it can see the schema); the **output** columns below are fixed and the tooling depends on them exactly.

## `polymarket_price` — `price_at_audit` for a Polymarket record

Parameters (Dune `{{param}}` syntax — **text params are substituted raw; the SQL quotes them as `'{{param}}'`**):
- `token_id` (text) — the outcome token of the audited side (`market.token_id` on the record)
- `captured_at` (text, ISO-8601 UTC) — the record's `posted_at`: the window ENDS at the audit moment. `market_trades` indexes ~60 min behind chain, so run Phase B ≥2h after Phase A.
- `window_min` (integer) — lookback, default 60

Must return **exactly one row** with columns:
| column | type | meaning |
|---|---|---|
| `vwap` | double | Σ(price × shares) / Σ(shares) over trades on `token_id` in `[captured_at − window_min, captured_at)` |
| `trade_count` | bigint | trades in the window |
| `volume_usdc` | double | Σ(price × shares) in the window |
| `window_start` | timestamp | inclusive |
| `window_end` | timestamp | exclusive |

If `trade_count = 0` the row is still returned with `vwap = NULL`; the tooling refuses to price the record and says so.

## `polymarket_pool` — the §3 coverage pool

Parameters: `n` (integer, default 5) · `exclude` (text, comma-separated `condition_id`s already in the book, may be empty)

Returns `n` rows ordered by `volume_24h_usdc` desc, columns: `condition_id`, `question`, `token_id_yes`, `token_id_no`, `volume_24h_usdc`, `last_price_yes`.

## Reproducibility

Anyone with a Dune account re-runs the public query with a record's `price_source.query_params` and gets `price_source.vwap` to the tolerance in `dune.json`. Trades are immutable on-chain, so the number does not drift.

## Publication and semantics (recorded by the scan instance, 2026-09-03)

- Column mapping (from Dune's `polymarket_polygon` table docs): `token_id` matches `market_trades.asset_id` (UINT256, compared as a decimal string); prices and shares are `price` / `shares`; `condition_id` is VARBINARY in trades and a `0x…` VARCHAR in `market_details`; outcome tokens come from `market_details.token_id` by `outcome_index` (0 = YES, 1 = NO, positional as Dune advises), with the trades' `Yes`/`No` labels as a fallback for markets the API snapshot has not caught up with.
- Trades are counted on the taker leg only (`is_taker_side`), so a CLOB match is one trade and `trade_count` is not doubled; VWAP is unaffected since both legs carry the same price. `volume_24h_usdc` is `SUM(amount)` over taker legs, Dune's documented single-counted volume.
- `exclude` accepts `0x`-prefixed or bare hex condition ids in any case; whitespace is trimmed; `""` excludes nothing.
- Token ids in the pool output are decimal strings on purpose: a 256-bit id does not survive a JSON number.
- Publishing: `npx tsx tests/q3/dune-publish.ts` reads the two `.sql` files verbatim, creates both saved queries **public** through the Dune REST API, runs the contract checks (one row with five columns and `trade_count > 0` on a live token; one row with `vwap = NULL` and `trade_count = 0` on an empty window; five pool rows; the exclude path), and writes the IDs into `dune.json`. `--test` re-runs the checks against the IDs already there; `--update` pushes the committed SQL to the existing IDs. The Dune query endpoints need an Analyst plan or higher; without one, paste the SQL into the Dune UI, set the parameters and defaults by hand, make the queries public, type the IDs into `dune.json`, and run `--test`.
