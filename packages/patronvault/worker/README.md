# patronvault worker

One Cloudflare Worker for the pilot's surface at `scan.djzs.ai/patron*`: the member page, the terms served byte for byte, a status API, a health probe, and the cron keeper. Hono for routes, viem for the chain, static assets for the page. The Worker holds one secret, the keeper's gas-only key; it never holds a member key and never signs anything but `settleMany` and `forwardSink`.

| Path | What |
| --- | --- |
| `GET /patron/` | the member page (`assets/patron/index.html` + `app.js` built from `site/app.ts`); every write is the member's own wallet transaction, simulated first so a call that would revert is refused with the contract's error in plain language |
| `GET /patron/terms` | `terms/member-terms-v1.md`, byte for byte, with `x-terms-keccak256` |
| `GET /patron/health` | liveness; `termsMatch` (served text against the vault's `termsHash`), the keeper's last run, its balance against the floor, `sinkShares` |
| `GET /patron/api/status` | the vault's configuration and the source's figures, before any wallet connects |
| `GET /patron/api/member/:address` | one member's position, routes, preview of the next settle, patron status at the pilot's floor, USDC balance and allowance |
| cron `17 */6 * * *` | the keeper: scan `Joined` logs into a KV registry, settle every member whose period has elapsed (`settleMany`, 10 per call, fixed gas), forward parked exit buffers to the sink |

Configuration is `wrangler.toml` `[vars]` (chain, RPC, vault, deploy block, payee and its floor, dry run, scan chunk, balance floor) and one secret, `KEEPER_KEY`. The terms text is generated into `src/terms.generated.ts` by every build from `../terms/member-terms-v1.md`, so it cannot drift from the file; the health probe compares it with the chain on every call anyway.

```
npm install
npm run check      # typecheck the Worker and the page
npm test           # keeper decisions (pure) and the hand-written ABI against the compiled artifact (needs `forge build` in ..)
npm run dev        # wrangler dev --local, with .dev.vars for the key; --var overrides for a fork (see docs/pilot-runbook.md)
npm run dry        # bundle without uploading (DJZS_BUILD_ONLY=1 stands the predeploy guard down)
npm run deploy     # from a clean tree at origin/main only; the guard refuses anything else
```

Why the keeper never uses the node's gas estimate: the contract catches a failing source withdraw to hold the payment rather than trap the member, so `eth_estimateGas` finds the cheapest "success", the source call starved of gas and the creator unpaid. Since v1.2 the contract reverts that case (`InsufficientGas`, `SourceOutOfGas`), and the keeper budgets 2M plus 600k per member regardless. A paid settle on the Aave wrapper costs about 333k.

Why once per period: a third party may settle a member only once per `settleInterval` (a day), and each settle costs the member up to one source share of rounding per route. The keeper settles on each member's own anniversary; the patron status creators read is computed live by the contract and does not depend on it.
