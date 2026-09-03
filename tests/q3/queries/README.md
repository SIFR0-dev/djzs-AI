# Q3 Dune queries — output contracts (protocol v1.2)

Both queries are **saved, public** Dune queries over `polymarket_polygon.market_trades`. Their IDs go in `tests/q3/dune.json`; their SQL is committed here verbatim (`polymarket_price.sql`, `polymarket_pool.sql`). Column names inside the SQL are the scan instance's concern (it can see the schema); the **output** columns below are fixed and the tooling depends on them exactly.

## `polymarket_price` — `price_at_audit` for a Polymarket record

Parameters (Dune `{{param}}` syntax):
- `token_id` (text) — the outcome token of the audited side (`market.token_id` on the record)
- `captured_at` (text, ISO-8601 UTC) — the Phase B timestamp
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
