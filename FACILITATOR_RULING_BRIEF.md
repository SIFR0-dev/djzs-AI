# Facilitator ruling brief — mainnet payment for verify_pm_trade

Status: EVIDENCE ONLY. DJ rules. No code written against any of this.
Date: 2026-07-14. Tree grounded at 6c08b5f (clean, local == remote).
Blocking: spec A9. Production runs 5f021c66 (free build, devnet anchoring, up).

## 1. The constraint, restated from committed truth

PHASE2_SPEC's acceptance criterion (Model A, Scenario 1):

    { network, recipient: TREASURY, facilitator: { url: "https://x402.org/facilitator" } }
    plus a price. Nothing else. No createAuthHeaders. No intermediary or
    settlement address. Funds move payer -> treasury directly via the payer's
    EIP-3009 signature; the facilitator submits transferWithAuthorization and
    pays gas.

Grep gates: `createAuthHeaders` -> 0; `x402.org/facilitator` -> >= 1.

## 2. What each facilitator actually advertises (instrument: its own /supported)

| Facilitator | Endpoint | Base mainnet (eip155:8453)? | Auth | Instrument |
|---|---|---|---|---|
| x402.org | https://x402.org/facilitator | **NO** — testnet only | none | GET /supported: every EVM kind is eip155:84532; 8453 absent. CDP docs concur: "For testnet use only." |
| xpay | https://facilitator.xpay.sh | **YES** | **none** | GET /supported: `{"kinds":[{v2,exact,eip155:8453},{v2,exact,eip155:84532},{v1,exact,base},{v1,exact,base-sepolia}]}`, signer 0x2772F7F7…8C17 |
| 0xArchive | https://facilitator.0xarchive.io | **YES** | **none** | GET /supported: `{"kinds":[{v2,exact,eip155:999},{v2,exact,eip155:8453}]}`, signer 0x0ea9c5a6…09dd. v2 only, no v1. |
| CDP (Coinbase) | https://api.cdp.coinbase.com/platform/v2/x402 | **YES** | **API key id + secret** | CDP docs, Network Support: Base, Base Sepolia, Polygon, Arbitrum, World, Solana; exact/upto/batch-settlement; 1,000 tx/month free then $0.001/tx |

The outage is fully explained: 33e6433 asked a testnet-only facilitator for
eip155:8453, so it could not even build payment requirements
(PRICE_COMPUTE_FAILED to every caller).

## 3. The finding that reframes the ruling

**A mainnet path exists that requires no API key, no account, and no
`createAuthHeaders`.** Instrument, installed SDK, not memory:

    // @x402/core dist/cjs/x402Client-CdmxbRFj.d.ts:60
    interface FacilitatorConfig { url?: string; createAuthHeaders?: () => Promise<...> }

`createAuthHeaders` is optional and is exactly the CDP mechanism. Pointing at
xpay or 0xArchive is a **one-constant change** — `X402_FACILITATOR_URL` — and
the first grep gate (`createAuthHeaders` -> 0) stays green untouched. The
second gate needs a one-line amendment, because it pins a specific URL rather
than the property it was meant to enforce.

## 4. What a facilitator can and cannot do to you

The payer signs an EIP-3009 authorization binding `from`, `to`, `value`,
`validAfter`, `validBefore`, `nonce`. The facilitator submits it.

CANNOT: redirect funds (the `to` is inside the signature), take a cut, replay
(the nonce is consumed), or custody anything at any point.

CAN: refuse to settle (denial of service); verify-then-not-settle (you serve an
audit and are not paid — bounded at 0.25 USDC per call); go dark (tool unusable
until you change the constant and redeploy); observe payment metadata.

**Therefore: facilitator choice is a liveness and revenue-assurance question,
not a custody question. The Model A flow-of-funds diagram is IDENTICAL under
all four options.** That is the single most important fact for this ruling.

## 5. The honest reading of the `createAuthHeaders` ban

Auth headers do not create custody. They authenticate you to the facilitator.
So the ban is not, on its face, a custody control. It is a proxy for something
real but different: using CDP means opening a **Coinbase account relationship**,
which brings you inside their KYB/AML program and makes them a named service
provider in your flow. Avoiding that is a legitimate and defensible position —
but it should be stated as what it is, not conflated with custody.

If the ban's purpose was custody, it is over-broad and CDP would be admissible.
If its purpose was account-relationship avoidance, it is exactly right, and the
permissionless mainnet facilitators satisfy it perfectly and cheaply.

## 6. The consideration that cuts the other way, and I am not a lawyer

xpay publishes, in its own comparison table, that it does **not** do OFAC or KYT
screening; it lists this as a disadvantage versus CDP, which does. You are a US
entity receiving payments. Your sanctions obligations exist regardless of which
facilitator you pick, but a screening facilitator produces a compliance artifact
and a permissionless one does not. This is a real tradeoff, it is a legal
question rather than an engineering one, and it belongs with whoever advises you
on the KYB posture.

## 7. Options

**A. Permissionless mainnet facilitator (xpay or 0xArchive).**
One constant change. No keys, no account, no secrets, gate 1 green, flow-of-funds
unchanged. Cost: you depend on a small, young operator for liveness and honest
settlement; no sanctions screening; if they verify-but-don't-settle you leak
audits at 0.25 each until you notice.
Between the two: xpay speaks v1 and v2 and is Base-focused; 0xArchive is v2-only
and runs it as a side service to a market-data business. Neither has a track
record worth calling one.

**B. CDP facilitator.**
Battle-tested, screened, multi-network, 1k free tx/month then $0.001 each.
Cost: two Worker secrets, `createAuthHeaders` in the config, a spec amendment to
both gates, and the Coinbase account relationship the current criterion was
written to avoid.

**C. Stay on base-sepolia.**
Ship the paid pilot on testnet, publicly and honestly. Zero risk, zero revenue,
and the site already says "no payment gate" so it would need one honest line.

**D. Self-host a facilitator.** Spec says out of scope. It remains a different
product with heavier compliance weight. Not recommended.

## 8. Gates any mainnet option must pass, stated before the work

1. Boot assertion: the configured facilitator's `/supported` must advertise the
   configured network, checked at deploy time. This one probe would have caught
   the outage in one call.
2. Settlement assurance: instrument whether a failed `settle` actually blocks the
   tool result in `withX402`, or whether a verify-only facilitator could get free
   audits out of us. Not yet proven either way; do not assume.
3. Irys mainnet anchoring is a SEPARATE blocker: `uploader.irys.xyz` requires a
   FUNDED upload key. Free-at-zero-balance was a devnet property, live-observed.
   Without funding, paying callers get `pol_certificate: {status:"error"}` —
   the weak offer the spec rejects on page one.
4. Treasury address confirmed by you, in source as a committed constant.
5. Post-deploy live probe (`pol-paid-call --url ... --network base`) with a named
   rollback target before the deploy, per the ratified deploy doctrine.

## 9. Sources

- https://x402.org/facilitator/supported (live, 2026-07-14)
- https://facilitator.xpay.sh/supported and /health (live, 2026-07-14)
- https://facilitator.0xarchive.io/supported (live, 2026-07-14)
- https://docs.cdp.coinbase.com/x402/network-support (live, 2026-07-14)
- https://www.xpay.sh/x402-facilitators/xpay/ (operator claims, self-reported)
- @x402/core 2.18.0, installed: FacilitatorConfig type
