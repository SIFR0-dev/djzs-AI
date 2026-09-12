# ds-trading — increment 1 build seat checkpoint (TRANSPLANT-PENDING)

Kalshi-lane adapter for deterministic-signal.trading v1, built in the remote
build seat 2026-08-21. **Permanent home is the dst-studio repo** (Operator
ruling); this directory is a survival checkpoint against build-seat container
reclaim and moves out of djzs-AI once the canonical dst-studio push lands.

## Contents (`adapter/`)

| file | what | status |
|---|---|---|
| `kalshi-rest.ts` | read-only public-data client (markets, orderbook, trades), 2026 dollars/fp wire shape | live-verified vs demo + elections hosts |
| `fixed.ts` | exact decimal-string fixed point (price e4 = $0.0001, qty e2 = 0.01 contracts); no floats on the money path | tested |
| `orderbook-sync.ts` | pure seq-gap state machine: gap -> HALTED, refuses all deltas until fresh snapshot | tested |
| `kalshi-ws.ts` | WS subscriber: gap -> drop socket -> reconnect -> resubscribe -> re-sync; socket factory injected | **SHAPE PINNED live 2026-08-21** (authed demo socket, 20 markets, 20 deltas, 0 gaps): snapshot `yes_dollars_fp`/`no_dollars_fp`, delta `price_dollars`/`delta_fp`/`side` (+`market_id`,`ts`,`ts_ms`); seq is one global counter per sid; off-shape frames halt+resync |
| `kalshi-sign.ts` | RSA-PSS/SHA-256 request signing (`ts+METHOD+path`), WebCrypto only (Workers-native), BYO PKCS#8 key | self-verify tested |
| `adapter.test.ts` | offline battery, no network/key: `node --experimental-strip-types --test adapter.test.ts` | 10/10 |
| `probe-live.ts` | read-only smoke vs demo env: `node --experimental-strip-types probe-live.ts` | PROBE_OK 2026-08-21 |

## Live-verified API facts (2026-08-21, demo + elections hosts)

- Orderbook wire shape is `{"orderbook_fp":{"yes_dollars":[["0.6100","400.00"],...],"no_dollars":[...]}}` — dollar strings (4dp, sub-cent capable per `price_level_structure`) and fractional-contract quantities (2dp).
- Market objects carry **only** `*_dollars` / `*_fp` string fields; legacy integer-cent fields are gone from the wire.
- Trades: `count_fp`, `yes_price_dollars`, `no_price_dollars`, `taker_side`.
- Default `/markets` listing is dominated by bookless `KXMVECROSSCATEGORY` shard markets; filter by `series_ticker` for real books.

No keys, no orders, no auth anywhere in this directory.

## Domain topology (Operator-stamped ruling, 2026-08-21)

- apex/www = frontend (placeholder stands)
- `api.deterministic-signal.trading` = June app (`dst-studio-worker`) — untouched, never redeployed over
- v1 = **`ds-trading-worker` on custom domain `gate.deterministic-signal.trading`** — subdomain, never path-split
- D1 binding: `ds-trading-ledger` (`fadbdf1c-47ee-4c91-8cd1-4971c907ffad`), fork B

`worker/` holds the v1 Worker scaffold (Hono, health + read-only market routes).
Deploys are Operator-run (`wrangler deploy` from the canonical repo after
transplant); `workers_dev = true` is explicit in `wrangler.toml` because
declaring `routes` silently disables workers.dev otherwise (proven live, §12).
