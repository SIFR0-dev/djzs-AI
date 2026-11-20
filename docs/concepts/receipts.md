# Receipts and certificates

A free check writes nothing. A paid check writes a public, permanent record. Which record depends on how you
paid.

| Paid over | Record | Where | Read it back |
| --- | --- | --- | --- |
| HTTP (x402 or MPP) | EAS attestation, payer as recipient | Base mainnet | [djzs.ai/verify](https://djzs.ai/verify), or any EAS reader |
| MCP | Proof-of-Logic certificate | Irys mainnet | `query_pol_certificates` |
| MCP, with `agent_address` | The agent's trust score | Base mainnet, indexed by the DJZS subgraph | `query_agent_trust` |

All of these are written after the verdict exists and cannot change it. A failed write is reported in the
response (`eas_error`, `pol_certificate.status`, `trust_score`) and the verdict stands.

## EAS attestation (paid HTTP)

| | |
| --- | --- |
| EAS contract | `0x4200000000000000000000000000000000000021` (Base predeploy) |
| Attester | `0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824` |
| Schema in use | v2, UID `0x5ef67e2b8c617635431401d2872b2a6f79eeba54a8e19fd5ecd45aceda2a2030` |
| Schema fields | `bytes32 intentHash, string verdict, uint8 riskScore, string[] flags, string rulesetVersion` |
| Recipient | The paying wallet (the zero address if the settlement does not name one) |
| Revocable | No. No expiry. |

Source: `djzs-trust-mcp/src/attest-worker.ts`, `djzs-trust-mcp/src/djzs-intent.ts`. On 2026-11-20 every
attestation this attester has made on Base used the v2 schema.

**Schema v3 is built, not deployed.** Under v3 a resolver contract (`DJZSVerdictResolver`, rule `DJZS-VR-v1.0`)
re-derives the verdict from the attested tally and refuses an attestation it contradicts. The contracts and their
tests are in the repo and run in CI, but production has no resolver address configured
(`EAS_RESOLVER_ADDRESS` is unset in `djzs-trust-mcp/wrangler.toml`), so receipts attest under v2.

## The two binding keys

**`intent_hash`** is what the attestation binds. It is an EIP-712 typed-data hash anyone can recompute:

* Domain: `name` `"DJZS"`, `version` `"2"`, `chainId` 8453.
* Type `DJZSIntent`: `action`, `venue`, `market`, `side`, `thesis`, `probability_basis` (strings),
  `size_usd_cents`, `max_loss_usd_cents` (uint256), `exit_condition` (string), `params_hash` (bytes32).
* Mapping from your request: `toDJZSIntent` in `djzs-trust-mcp/src/djzs-intent.ts`. The route decides the
  `action` (`pm_trade` or `perp_trade`), never the body.

**`intent_sha256`** is `0x` + sha256 of the exact text the engine read: your intent rendered as one `key: value`
line per key, keys sorted (`renderIntentText`, `djzs-trust-mcp/src/engine-adapter.ts`).

`verdict_hash` is not a binding key: it covers only the outcome ([Verdicts](verdicts.md#the-verdict-hash)).

## Checking a receipt without trusting DJZS

[djzs.ai/verify](https://djzs.ai/verify) takes the receipt JSON, reads the USDC transfer from Base, recomputes
`intent_hash` from your text in the browser, and reads the attestation from EAS. It compares, in your browser,
what was paid, what was asked, and what was attested.

## Proof-of-Logic certificate (paid MCP)

Every in-scope paid MCP check anchors a certificate on Irys mainnet: permanent and public. The result's
`pol_certificate.status` is `anchored` (with the Irys id), `disabled` (anchoring not configured) or `error`.
`query_pol_certificates` reads certificates by outcome, tag or time window
([Reference](../reference/registry-tools.md)).

## Trust score (paid MCP, opt-in)

Pass `agent_address` to `verify_pm_trade` or `verify_perp_trade` and the verdict is added to that agent's record
on Base, after its certificate anchors. Leave it out and nothing is written for any wallet. The record cannot be
deleted.
