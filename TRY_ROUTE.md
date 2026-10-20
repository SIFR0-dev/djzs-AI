# TRY_ROUTE: free verdicts, paid receipts (2026-09-28)

Ruling 2026-09-27: **sell the receipt**. The verdict is free and capped per wallet; 2.00 USDC buys
the attested EAS receipt on any outcome. This runbook ships that: one Worker route, one page.

## What ships

| Piece | Where | Behaviour |
|---|---|---|
| `GET /try/quota?address=0x…` | `djzs-trust-mcp/src/try-route.ts` | day, remaining, the exact text to sign, both paid offers |
| `POST /try/verdict` | same | `{kind, intent, address, day, signature}` -> same pipeline as the paid routes, verdict + flags in plain language, `attested:false`, receipt offer. 5 per wallet per UTC day; global ceiling `TRY_GLOBAL_DAILY_LIMIT` (default 200) |
| `/try` | `site/try.html` | connect wallet, state intent (PM or perp form), sign one message, read the verdict, then **Get the receipt · 2.00 USDC** pays the existing x402 route from the browser (EIP-3009 signed in the wallet) and shows the EAS link, the settlement tx, and a one-click hand-off to `/verify` |
| `/verify#r=…` | `site/verify.html` | preloads a receipt from the URL fragment and recomputes it |
| nav + hero CTA | index, guide, verify, ruleset, builders, build | "try" everywhere; homepage hero: "Try it free, in the browser" |
| `llms.txt`, `sitemap.xml`, Worker `/llms.txt` | site + `discovery-surfaces.ts` | the free endpoint is documented for agents |

Quota store is D1 (`TELEMETRY`, tables `try_verdict`, `try_day`). The Worker creates the tables itself on
first use; `schema/gate-telemetry.sql` carries the same DDL for the record. No IP is stored. Without the
binding the route answers 503 (fail closed).

## Faults fixed in the same push (all latent, all now under test)

1. **Perp `intent_hash` threw after settlement.** `toDJZSIntent` read `market`; perp intents carry
   `instrument`. A paying perp caller would have been charged, then answered `503 charged:false`. Now
   `action "perp_trade"`: `market = instrument`, `exit_condition = invalidation` else `stop_loss <n>`,
   levels bound through `params_hash = keccak256(utf8("leverage=..|entry=..|stop_loss=..|take_profit=.."))`.
   PM hashes unchanged (golden receipt pinned). Mirrored in `site/verify.html`. Test: `test/djzs-intent.test.mjs`.
2. **Tally never left the pipeline.** `verify-pm-trade.ts` / `verify-perp-trade.ts` omitted `tally`
   from the response, so with `EAS_RESOLVER_ADDRESS` set every attestation would have failed. Fixed;
   `harness/adapter-offline.ts` asserts the tally reaches the adapter.
3. **Module-init TDZ** in `http-x402-bazaar.v2.ts` (`OUTPUT_MIME_TYPE` declared below its first use).
   Hidden by the wrangler bundle, fatal under tsx, which is why the offline adapter harness was never in
   CI. Moved; the harness runs in CI now.
4. **Browser payers**: preflight now allows `PAYMENT-SIGNATURE`; every JSON refusal on the paid route
   carries CORS, so a browser can read `payment_verification_failed` instead of a network error.

## Deploy order (DJ's terminal, canonical repo only)

```sh
cd ~/djzs-om/djzs-trust-mcp
npx tsx test/djzs-intent.test.mjs && npx tsx test/try-route.test.mjs && npx tsx harness/adapter-offline.ts && npx tsx test/attest-v3.test.mjs
npx wrangler deploy
cd ../site
npx wrangler deploy
```

Optional var, only if the free tier needs a different ceiling (default 200 per UTC day, all wallets):
add `TRY_GLOBAL_DAILY_LIMIT = "200"` under `[vars]` in `djzs-trust-mcp/wrangler.toml` and redeploy.

## Probes after deploy

```sh
curl -s https://mcp.djzs.ai/try/quota | head -c 600; echo
# expect ok:true, limit:5, day = today UTC, message_format, receipt.pm.url + receipt.perp.url
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS https://mcp.djzs.ai/x402/verify_pm_trade -H "Origin: https://djzs.ai" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,payment-signature"
# expect 204
```

Then the page, once, with a wallet holding 2 USDC on Base: https://djzs.ai/try -> connect -> Load example
-> Run free audit (one personal_sign) -> Get the receipt (chain switch to Base, one typed-data signature)
-> attestation link resolves on base.easscan.org -> "Recompute at /verify" lands with the receipt preloaded
and reports PASS on all three reads.

If you run the receipt step on the **perp** kind, that settlement is the one that lists
`verify_perp_trade` in the Bazaar (never settled before 2026-09-28). The page or the probe both do it:

```sh
read -rs 'BUYER_PRIVATE_KEY?buyer key (hidden, then Return): ' && export BUYER_PRIVATE_KEY && echo
node djzs-trust-mcp/harness/buyer-probe.mjs --mode settle --intent perp
unset BUYER_PRIVATE_KEY
```

The first line shows a prompt and waits; nothing you type is echoed. A bare `read -s` shows no
prompt, so pasted together with the lines under it, it looks like a hang.

The free tier's kill switch is `TRY_GLOBAL_DAILY_LIMIT = "0"` (refuses every free verdict, the day's first included).

## Reading the instrument (scoreboard: 3 non-DJ paying wallets by 2026-10-27, checkpoint 2026-10-11)

```sh
cd ~/djzs-om/djzs-trust-mcp
npx wrangler d1 execute djzs-gate-telemetry --remote --command "SELECT day, COUNT(*) AS wallets, SUM(n) AS verdicts FROM try_verdict GROUP BY day ORDER BY day DESC LIMIT 14"
npx wrangler d1 execute djzs-gate-telemetry --remote --command "SELECT address, SUM(n) AS verdicts, MIN(first_ts) AS first_seen FROM try_verdict GROUP BY address ORDER BY verdicts DESC LIMIT 25"
```

Paying wallets are on chain: USDC transfers to the treasury `0xc1923748669dFC3a79497d0403A90a275161eCCA`
on Base (basescan token transfers tab), and EAS attestations by `0xfB0e…7824` with the payer as recipient.
Conversion = distinct payers that also appear in `try_verdict`.

## Abuse controls, in order of cost

1. Per-wallet cap (5/day) and the signature: a wallet is only a cap if the caller proves control of it.
2. `TRY_GLOBAL_DAILY_LIMIT`: the day's total free extractions, whatever the wallet count.
3. Cloudflare WAF rate rule (dashboard, no code): `/try/verdict`, 10 requests per minute per IP, block 10 minutes.
   Do this the day a scan shows one wallet per request.
4. Lower the global var. The paid route is unaffected by all four.
