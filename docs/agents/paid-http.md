# Paid check over HTTP

One route per ruleset, same price, same payment rules. Source: `djzs-trust-mcp/src/http-x402-bazaar.v2.ts`.

```
POST https://mcp.djzs.ai/x402/verify_pm_trade
POST https://mcp.djzs.ai/x402/verify_perp_trade
```

Any x402 v2 client pays it, and so does any MPP client. The result is the same verdict the free check gives,
plus an EAS attestation on Base with the payer as recipient: [Receipts and certificates](../concepts/receipts.md).

## 1. Ask for the price

Any `POST` without a payment gets `402`, whatever its body. The `402` carries two challenges for the same charge:

| Header | Protocol | Contents |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | x402 v2 | base64 JSON: scheme `exact`, network `eip155:8453`, amount `2000000` (2.00 USDC), asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `payTo` `0xc1923748669dFC3a79497d0403A90a275161eCCA`, `extra.name` `"USD Coin"`, `extra.version` `"2"`, `maxTimeoutSeconds` 120 |
| `WWW-Authenticate: Payment` | MPP | `method="evm"`, `intent="charge"`, the same amount, asset and recipient |

Take the recipient from this challenge, never from a transaction history: lookalike addresses are sent to payer
wallets to be copied by mistake. The `402` body also carries an example intent under
`extensions.bazaar.info.input.body`.

## 2. Send the intent with the payment

`intent` must be a JSON object. The binding key needs these fields, or the route refuses with `400
intent_unbindable` before any money moves:

| Route | Required in `intent` | Optional |
| --- | --- | --- |
| `verify_pm_trade` | `market` (venue market id), `side`, `thesis` | `venue`, `probability_basis`, `size_usd`, `bounds.max_loss_usd`, `bounds.exit_condition` |
| `verify_perp_trade` | `instrument`, `side` (`LONG` or `SHORT`), `thesis` | `venue`, `leverage`, `entry`, `stop_loss`, `take_profit`, `invalidation`, `size_usd` |

The example the prediction-market route publishes in its own challenge:

```json
{
  "intent": {
    "market": "KXBTC-26AUG29-T70000",
    "side": "YES",
    "thesis": "BTC closes above 70k by Aug 29 on ETF inflow continuation",
    "probability_basis": "implied 0.41 vs model 0.55; basis: Kalshi mid, 2026-08-19T14:00Z",
    "size_usd": 250,
    "bounds": { "max_loss_usd": 250, "exit_condition": "daily close below 66000" }
  }
}
```

The engine reads every key: the object is rendered as one `key: value` line per key, keys sorted, and that text
is what gets checked.

**x402:** sign an EIP-3009 `TransferWithAuthorization` for the quoted amount (domain from `extra.name`,
`extra.version`, chain 8453, the USDC contract) and send it base64-encoded in `PAYMENT-SIGNATURE` (`X-PAYMENT` is
also read). **MPP:** send the credential in `Authorization: Payment`. A no-code MPP client:

```bash
npx mppx https://mcp.djzs.ai/x402/verify_perp_trade --protocol mpp -J '{"intent":{"instrument":"BTC-PERP","side":"LONG","thesis":"..."}}'
```

## 3. What happens, in order

1. The payment is verified. Nothing moves yet.
2. The body is validated. A bad body is refused `400`, uncharged.
3. Scope: an idea of the other kind is refused with `200` and `verdict: "REFUSED_SCOPE"`, uncharged.
4. The intent is bound (`intent_hash`). An intent that cannot be bound is refused `400`, uncharged.
5. The payment settles. Only now does money move.
6. The engine runs and the verdict is attested on EAS.

## Response

`200`, with the settlement in the `PAYMENT-RESPONSE` header (base64 JSON: `success`, `transaction`, `network`,
`payer`). An MPP payment also gets a `Payment-Receipt` header.

| Field | Meaning |
| --- | --- |
| `verdict`, `risk_score`, `flags`, `verdict_hash`, `tally` | As in [Verdicts](../concepts/verdicts.md). `flags` here is the list of codes. |
| `intent_sha256` | sha256 of the rendered text that was checked. |
| `intent_hash` | The EIP-712 binding key written into the attestation. |
| `eas_uid`, `eas_tx`, `eas_schema` | The attestation on Base, its transaction, and its schema UID. |
| `eas_error` | Present only if the attestation write failed (`attester_not_configured` or `attestation_failed`). The verdict still stands and the payment is still recorded. |
| `charged`, `settlement_tx` | `true` and the USDC transfer. |

## Errors

| Status | `error` or `verdict` | Charged |
| --- | --- | --- |
| 400 | `invalid_json`, `missing_intent`, `intent_unbindable`, `malformed_payment_header` | No |
| 402 | `payment_verification_failed` (bad or expired signature, underfunded wallet), `settlement_failed` | No |
| 405 | `method_not_allowed` | No |
| 500 | `verdict: "AUDIT_ERROR"`: the payment settled but the check failed after it | Yes. The body carries `settlement_tx`; contact the operator with it and `intent_sha256`. |
| 502 | `SETTLEMENT_UNCERTAIN`: the facilitator did not confirm, and the transfer may have gone out | Unknown (`charged: null`). Do not sign a second payment until you have looked up `settlement_tx` or your wallet. |
| 503 | `AUDIT_UNAVAILABLE`, `FACILITATOR_UNAVAILABLE` | No |

Every `error` value is a fixed code, never raw error text (`djzs-trust-mcp/src/safe-error.ts`).

## Contract file

`https://mcp.djzs.ai/openapi.json` lists both routes and the payment offers (`x-payment-info`). Each route's
`intent` is the object shown above, with the same required fields and the same example as that route's 402
challenge. The prediction-market `intent` was typed as a string until 2026-11-24; a client built from the older
file sent a string and got `400 missing_intent`, uncharged.

`POST /x402/verify` is an older x402-only alias for the prediction-market check.
