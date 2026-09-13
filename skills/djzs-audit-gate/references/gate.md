# The gate call

Everything here is checked against the deployed Worker. Where this file and the
live endpoint disagree, the endpoint is right and this file is a bug — the whole
reason this file exists is that v1.0.0 of the skill described a route that did
not exist.

## Endpoints

| Path | Auth | What it does |
| --- | --- | --- |
| `https://mcp.djzs.ai/mcp` | x402, 2.00 USDC | MCP streamable-HTTP. `verify_pm_trade` is the paid tool. |
| `https://mcp.djzs.ai/x402/verify` | x402, 2.00 USDC | Same gate for plain HTTP x402 clients. |
| `https://mcp.djzs.ai/health/x402` | free | Payment config: network, facilitator, advertised chain. |
| `https://mcp.djzs.ai/health/writer` | free | Trust-writer authorization state. |
| `https://mcp.djzs.ai/openapi.json` | free | Machine-readable contract. |

**There is no unpaid audit route.** Not a dry-run, not a preview, not a sandbox.
If you need one, the honest answer to the user is that it does not exist.

The free tools — `query_pol_certificates`, `query_agent_trust` — retrieve
history. They never audit and never return a verdict.

## Price

2.00 USDC per in-scope audit, on Base mainnet (`eip155:8453`). Repriced from
0.25 on 2026-07-16. The live 402 challenge is authoritative: it quotes the amount
before any payment, so read it rather than trusting this line.

Payers sign an exact amount, so a silent overcharge is impossible — a client
pinned to a lower cap refuses loudly instead of paying more.

## Free refusal

An out-of-scope submission runs the full engine and settles **nothing**.
`verify_pm_trade` is prediction-markets only; a spot, perp or equities thesis is
refused without charge, proven on chain by balance deltas
(`djzs-trust-mcp/test/x402-roundtrip.mjs`, 25/25).

A refusal returns no verdict. It is not a probe and must never be used as one.

## What comes back

`verdict` ∈ `PASS | WAIT | FAIL`, and `action` ∈ `PROCEED | HALT`. **These are
two vocabularies and they are not interchangeable** — keying a decision table on
`PROCEED` while the engine hands you `PASS` is a real bug that has happened here,
and it silently logged a clean PASS as blocked. Branch on one and derive the
other in exactly one place.

`EXECUTE` requires `verdict === "PASS"` **and** zero CRITICAL flags. Anything
else is `HALT`.

A `WAIT` is the engine declining to rule, not a soft fail. It is still `HALT`
for execution purposes: you do not have a verdict, so you do not proceed.

## What the verdict does not tell you

**M03 checks that a probability basis is *stated*, not that it is *true*.** A
well-formed invented basis passes both the field gate and the engine. An audit
has returned `PASS / PROCEED / risk 0` on entirely fabricated market data.
Provenance is the operator's duty and no verdict discharges it.

Prediction markets run the complete live taxonomy (DJZS-M, 4/4). Other verticals
run a partially-activated one — fewer codes fire, so a PASS carries less
discrimination. Say so; never present a thin PASS as a thorough one.

## The certificate is permanent

Every paid in-scope audit anchors an immutable ProofOfLogic certificate to Irys.
It cannot be edited, withdrawn, or reissued.

### Correction Record 001 — what a careless field costs

Certificate `7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br` (audit
`a3a5ad8f-0418-4d63-ae7b-85b39973a25b`, 2026-08-18) carries
`target_system: "Coinbase"`. It was typed into a free-text field during testing.
**Coinbase had no involvement in that audit.** The certificate is permanent, so
the only remedy was a separate anchored Correction Record and a rule change.

Since 2026-09-13, `target_system` is written **only** from a claim signed by the
subject address, and is otherwise null:

```
target_system            the value
target_system_subject    0x… address that signed it
target_system_signature  EIP-191 personal_sign over:
                         DJZS-TSC-1 target-system claim
                         subject: <lowercased subject>
                         target_system: <value>
```

Send all three or none. An unsigned value is **discarded, not stored**. Values
written before the rule render as `unverified:<value>` everywhere.

A signature proves who authored a claim. It never proves the signer is who the
name says — that judgement stays with the reader.

## Reading history

`query_agent_trust` returns evidence, not a decision. It applies no threshold and
emits no HALT.

- WAIT verdicts are abstentions, excluded from both sides of the fail rate and
  reported as `wait_count`.
- Below 10 scored audits it returns `INSUFFICIENT_HISTORY` and **no rate at
  all** — a 0-of-0 record is not evidence of reliability and must not compare as
  better than a 3-of-50.
- It returns the raw rate and a Wilson 95% lower bound. Judge against your own
  exposure; do not treat any number here as a rule the tool enforced.
