# DEPLOY_RUNBOOK — Bazaar Listing Push

Status: DRAFT-UNVERIFIED until each step's evidence is logged. Wrangler deploys are DJ-run, always. Every artifact is content-verified by grep before it ships. Package pins verified live against npm on 2026-08-19: `@x402/core@2.23.0`, `@x402/evm@2.23.0`, `@x402/extensions@2.23.0`; the route module typechecks clean against these exact versions.

Sequencing is binding per the PASS ruling: terms before listing, probe before claiming, secondaries in the same push.

## STEP 0 — Terms gate (blocks everything downstream)

Review `terms.html`, fill both `[[SET_` placeholders (effective date, contact), and get the counsel pass you consider proportionate — the draft is protective but unreviewed. Place at `site/terms.html` in the djzs-site source.

Grep gate before deploy, from `site/`:

    grep -c '\[\[SET_' terms.html        # must print 0
    grep -c 'DJZS AI, LLC' terms.html    # must print >= 2
    grep -c 'refused without charge' terms.html   # must print >= 1

Deploy djzs-site (DJ runs `npx wrangler deploy` from `site/`), then probe:

    curl -s https://djzs.ai/terms | grep -c 'DJZS AI, LLC'   # must print >= 1

## STEP 1 — Route integration (djzs-trust-mcp)

Copy `http-x402-bazaar.v2.ts` into `djzs-trust-mcp/src/`. Verify pwd against the canonical repo before touching anything — six stale clones exist on the machine.

Wire the engine adapter. `scopeCheck` must be the same scope function the MCP transport uses — one scope truth, two transports. Mount in the worker router:

    import { handleX402VerifyPmTrade } from "./http-x402-bazaar.v2";
    import { engineAdapter } from "./engine-adapter";  // DJ wires this
    // POST /x402/verify_pm_trade -> handleX402VerifyPmTrade(request, env, engineAdapter)

Pin dependencies exactly (no ranges):

    npm i @x402/core@2.23.0 @x402/evm@2.23.0 @x402/extensions@2.23.0 --save-exact

Facilitator config, via wrangler secrets only (private-key incident rule: nothing sensitive in source or Downloads):

    FACILITATOR_URL = https://api.cdp.coinbase.com/platform/v2/x402

CDP mainnet facilitator calls require request auth. Wire the `FACILITATOR_AUTH` seam to CDP's auth-header generator (the `@coinbase/x402` helper or equivalent) with CDP API credentials held as worker secrets. This seam is DRAFT-UNVERIFIED — confirm the header shape against current CDP docs at integration time.

Open variable to record before probing, not after: is treasury `0xc1923748669dFC3a79497d0403A90a275161eCCA` linked to a CDP developer account? The unconfirmed issue-2112 hypothesis says discovery may gate on CDP-registered payees while settlement works regardless. Whatever the answer, write it down now so the probe result is interpretable.

## STEP 2 — Content-verify gates (route)

From `djzs-trust-mcp/src/`:

    grep -c 'DJZS_SENTINEL: http-x402-bazaar.v2' http-x402-bazaar.v2.ts   # 1
    grep -c '0xc1923748669dFC3a79497d0403A90a275161eCCA' http-x402-bazaar.v2.ts   # >= 2
    grep -c 'eip155:8453' http-x402-bazaar.v2.ts   # >= 1
    grep -c '"2000000"' http-x402-bazaar.v2.ts     # >= 1
    grep -c 'buildPaymentRequirements' http-x402-bazaar.v2.ts   # >= 1

GATE AMENDED 2026-08-19 (integration, A2). The `"2000000"` gate is unchanged as a
command and still prints >= 1, but it no longer anchors the same thing, so it is
recorded here rather than quietly satisfied:

  OLD MEANING: the literal was the wire value — `amount: PRICE_ATOMIC` inside a
    hand-built PaymentRequirements object.
  NEW MEANING: the wire value is COMPUTED by `buildPaymentRequirements` (§14: the
    field name and the network-dependent `extra.name` are the library's to set, and
    a hardcoded EIP-712 domain silently breaks every payer on the other network).
    The literal survives as `EXPECTED_ATOMIC_AMOUNT`, a POST-CONDITION asserted
    against the computed amount before any challenge is issued.
  REASON TO KEEP IT: the compliance grep must still see the money amount in source,
    and the assertion is now load-bearing — a decimals or asset drift in the price
    path fails closed instead of quoting a caller the wrong number.
  COMPANION GATE ADDED: `grep -c 'buildPaymentRequirements'` — proves the value is
    computed. The pair is what the old single gate used to imply on its own.

And at the mount site: confirm the third argument is the wired adapter, not the default —

    grep -c 'NOT_WIRED' <router file>   # must print 0

Ordering and money-path invariants are not greppable. They are pinned by the offline
harness, which runs with no key and no egress (its facilitator is a loopback stub):

    npx tsx djzs-trust-mcp/harness/adapter-offline.ts   # exit 0, "ADAPTER OFFLINE HARNESS: PASS"

It asserts, among others: an unpaid probe gets 402 on an empty AND a non-JSON body
(never 400); the computed amount/asset/payTo/network/extra.name match this route's
constants; /verify and /settle are never reached by an unpaid probe; and each request
initialises its own resource server (no module-scope singleton holding request-scoped
secrets).

## STEP 3 — Deploy

DJ runs the wrangler deploy for djzs-trust-mcp from the canonical repo. No deploy artifacts routed through Downloads.

## STEP 4 — Probe A: challenge shape

    curl -si -X POST https://mcp.djzs.ai/x402/verify_pm_trade \
      -H 'content-type: application/json' \
      -d '{"intent":{"market":"KXBTC-TEST","side":"YES","thesis":"probe"}}'

Assert: status `402`; body has `x402Version: 2`; `accepts[0]` carries `scheme: "exact"`, `network: "eip155:8453"`, `payTo: 0xc192…eCCA`, `amount: "2000000"`; response includes a `PAYMENT-REQUIRED` header; `extensions` carries the bazaar discovery block. Any miss is a stop-and-fix, not a note.

Assert the empty-body case too — this is the regression HEAD 7634b42 fixed on `/x402/verify`, and the same ordering now applies here:

    curl -si -X POST https://mcp.djzs.ai/x402/verify_pm_trade -H 'content-type: application/json' -d ''

Expect `402`, not `400`. A prober that gets 400 classifies the endpoint UNPAID.

COUPLING INTRODUCED BY A2, record it before probing: because `amount` and `extra.name`
are now computed, the challenge requires a reachable, authenticated facilitator —
`initialize()` then `buildPaymentRequirements()`. A facilitator outage or bad CDP
credentials turns the 402 into a `503 FACILITATOR_UNAVAILABLE` for every caller,
which is the 2026-07-13 `PRICE_COMPUTE_FAILED` failure class (spec A9). The
mitigation is unchanged and is not code: probe `/health/x402` first, name the
rollback version before deploying, and probe the deployed version immediately after.

## STEP 5 — Probe B: the uncharged-refusal invariant

Send a deliberately out-of-scope intent with a valid payment authorization attached. Expect status `200`, body `verdict: "REFUSED_SCOPE"`, `charged: false`, and — the part that matters — no inbound transfer to the treasury for that authorization. This reproduces the evidenced scope-refusal-uncharged behavior on the new transport before any public claim references it.

## STEP 6 — Settle one in-scope self-payment

From DJ's wallet, one clean in-scope call (an `@x402/fetch` client or any v2-exact-capable buyer). Expect `200`, a full verdict body, and a `PAYMENT-RESPONSE` header. Record the settlement transaction hash. Net cost is gas plus facilitator fee — the 2.00 USDC lands in the treasury.

## STEP 7 — Probe C: Bazaar discovery by payTo

The discovery API is public, no CDP key required. Query the facilitator's discovery listing and filter for the treasury (exact path per current CDP docs at run time; the SDK call is `listX402DiscoveryResources` / `searchX402Resources`):

    curl -s "$FACILITATOR_URL/discovery/resources?limit=1000" \
      | jq '.items[] | select((.resource // .resourceUrl // "") | contains("mcp.djzs.ai"))'

Branch on outcome:

Present — log the evidence entry, surface-area item closed, quality ranking begins accruing from real calls.

Absent after settlement (allow an indexing lag, re-probe at 24h) — you now hold a receipted reproduction of issue 2112 with an external-EOA payee: capture the raw settle response headers (note whether `EXTENSION-RESPONSES` ever appeared), the payload, and the pinned package versions. Filing it upstream is your call; the reproduction has standalone value either way.

## STEP 8 — Secondaries, same push

Manifest: fill `[[SET_ON_PUBLISH]]` in `x402.json`, place at `site/.well-known/x402.json`, grep-gate (`grep -c '\[\[SET_' x402.json` must print 0), deploy with djzs-site, then probe:

    curl -s https://djzs.ai/.well-known/x402.json | jq '.resources[0].accepts[0].payTo'

x402scan: wallet-signature listing signed by the treasury key — the strongest ownership proof available, on-brand for a receipts operation. Follow their live flow at listing time.

402 Index: single unauthenticated POST per their current instructions; it re-ingests the Bazaar, so a successful Step 7 propagates here regardless. Verify their endpoint on their site at run time — do not trust stale third-party writeups.

## STEP 9 — Evidence log

One ledger entry per step with: artifact sha256, command run, output captured, tx hashes where applicable. Everything stays DRAFT-UNVERIFIED until its evidence line exists. The listing claim ("djzs.ai is in the Bazaar") is not made anywhere public until Probe C returns present.

END_TRANSMISSION. //
