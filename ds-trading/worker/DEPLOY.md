# ds-trading-worker — first deploy runbook (Operator-run)

Increment 1 close-out. Deploy doctrine applies: a deploy is done when the
DEPLOYED VERSION is probed live and answers correctly, not when wrangler
prints "Deployed". Content-verify BEFORE deploying. Paste blocks follow
terminal doctrine: bare commands, one per line, each block opens with cd.

## 0. Facts

- Branch/tip: `claude/build-audit-seat-split-r4onyu` @ `aba9aef` (PR #129), tree clean.
- Creates a NEW worker `ds-trading-worker` on `gate.deterministic-signal.trading`
  (custom domain; zone already in the account). `dst-studio-worker` / `api.` is a
  different worker and is not touched.
- The bundle closure reaches outside `worker/`: `src/index.ts` imports
  `../../adapter/kalshi-rest.ts` and `../../adapter/fixed.ts`, so deploy from a
  checkout with the full `ds-trading/` tree intact. `kalshi-ws.ts`,
  `orderbook-sync.ts`, `kalshi-sign.ts` are NOT in the worker bundle.
- Rollback for a FIRST deploy = removal: `npx wrangler delete` (run inside
  `ds-trading/worker/`). The D1 ledger is a separate resource and survives
  worker deletion untouched.

## 1. Content-verify (expected sha256, at aba9aef)

```
41b740b937a99cc6a2b79b5d0c763d351dd9bb21cc16221a91e3ee804a2d0195  ds-trading/worker/wrangler.toml
2143a87c2cbdd8d2b63a8c6fadfd1fb9c96e73a03e19de0afaa6cb84f96dcf7d  ds-trading/worker/package.json
220cf525ef23b65abe5f57f22196fdcb4d8d5807e17cc6732e064116de0655f5  ds-trading/worker/package-lock.json
ae32fcd22d10f8aa4d2f831916b928f0ed4c6f44df213e2a8516560597e94f95  ds-trading/worker/src/index.ts
e2c4c6060592fa7145f0c1e4611a0583474527b1d1576f4b9a7036618940960b  ds-trading/worker/src/verdict-core.ts
7b8c33ef1d7b237426c5e6acb102bd82b366962383c84aeb9ec77a49d0566de9  ds-trading/adapter/kalshi-rest.ts
fb38057b8500d03643831e46efab5ed3ea40130dc6061a25cfdf837e06260d78  ds-trading/adapter/fixed.ts
```

Checkout + verify (expect HEAD `aba9aef…`, hashes byte-identical to the list):

```
cd /path/to/djzs-AI
git fetch origin claude/build-audit-seat-split-r4onyu
git checkout claude/build-audit-seat-split-r4onyu
git rev-parse HEAD
git --no-pager status --short
sha256sum ds-trading/worker/wrangler.toml ds-trading/worker/package.json ds-trading/worker/package-lock.json ds-trading/worker/src/index.ts ds-trading/worker/src/verdict-core.ts ds-trading/adapter/kalshi-rest.ts ds-trading/adapter/fixed.ts
```

Any mismatch or dirty tree = stop. `wrangler deploy` ships the working tree.

## 2. Test, then deploy

Expect 18/18 pass, then wrangler prints the version id — record it.

```
cd /path/to/djzs-AI/ds-trading/worker
npm ci
node --experimental-strip-types --test test/worker.test.ts test/gate.test.ts
npx wrangler deploy
```

## 3. Probe immediately (the deploy is not done until these answer)

```
cd /path/to/djzs-AI
curl -sS https://gate.deterministic-signal.trading/
curl -sS https://gate.deterministic-signal.trading/health
curl -sS -X POST -H "content-type: application/json" -d "{}" https://gate.deterministic-signal.trading/v1/orders
```

Expected, in order:

1. `{"name":"ds-trading-worker","version":"0.1.0"}`
2. HTTP 200, `{"status":"healthy","ledger":"connected",...}` — `ledger:"connected"`
   is the increment-1 close condition the audit seat verifies.
3. HTTP 400, `{"error":"gate","reason":"verdict_id required — no order without a verdict"}`.

Edge-cache lag rule (§13/§10 lineage): a 404 on the custom domain immediately
after a deploy is NOT a rollback condition — probe the workers.dev alias
(printed by wrangler at deploy) to separate "deploy broken" from "canonical
hostname stale". Close-out requires the CANONICAL url answering.

`/health` returning 503 `ledger:"unreachable"` = binding problem (worker is
up, D1 binding wrong) — check `wrangler.toml` database_id
`fadbdf1c-47ee-4c91-8cd1-4971c907ffad` and redeploy; no data is at risk.

## 4. Standing constants (for the record)

- `VERDICT_TTL_MS` = 15 min — Operator ratification pending; active either way
  (reject-by-default).
- Ledger meta stamps: `schema_version=v0.2`,
  `schema_sha256=1aa8b959fec55ec900273e7d4d40e33f6e3e7eadc8ca0bc1e8c44406cd45da6c`.
- Verdict row present pre-deploy: `e2e-0001-2026-08-21` (FAIL/60,
  `0x10d61c27…baee38`) — `/health` and the probes above write nothing.
