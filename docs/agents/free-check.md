# Free check: one POST

The same engine and rulesets as the paid check, with nothing written anywhere. Source:
`djzs-trust-mcp/src/try-route.ts`.

```
POST https://mcp.djzs.ai/try/verdict
content-type: application/json
```

CORS is open (`access-control-allow-origin: *`), so a browser agent can call it directly.

## Request

Two ways to identify the caller. Each check counts against that identity's daily quota, which resets at 00:00
UTC.

**With an id (no wallet), 3 checks per id per UTC day**

```json
{
  "kind": "pm",
  "anon": "<32 lowercase hex characters, kept by the caller>",
  "intent": { "thesis": "<the idea in plain words>" }
}
```

**With a wallet signature, 5 checks per wallet per UTC day**

```json
{
  "kind": "pm",
  "intent": { "thesis": "<the idea in plain words>" },
  "address": "0x...",
  "day": "YYYY-MM-DD",
  "signature": "0x..."
}
```

The signature is EIP-191 `personal_sign` over this text, with `{address}` checksummed, `{day}` the server's UTC
day, and `{intent_sha256}` as defined below. `GET /try/quota` returns the template as `message_format` and the
current `day`.

```
djzs.ai try verdict
address: {address}
day: {day}
intent_sha256: {intent_sha256}

Free audit, 5 per wallet per UTC day. No funds move. Nothing is attested.
```

| Field | Rule |
| --- | --- |
| `kind` | `"pm"` for a prediction-market bet, `"perp"` for a perp or spot trade. Anything else: `400 bad_kind`. |
| `intent` | A JSON object, at most 4096 bytes serialized. `{ "thesis": "..." }` is enough. Other keys are allowed and are read too. |
| `anon` | Exactly 32 lowercase hex characters (`openssl rand -hex 16`). Keep one per agent. Fresh ids do not get around the global daily cap (default 200 free checks across all callers); once it is reached, every caller gets `429` until 00:00 UTC. |

**What the check reads.** The intent is rendered to text before extraction: a string as is; an object as one
`key: value` line per key, keys sorted. `intent_sha256` is `0x` + sha256 of that text
(`djzs-trust-mcp/src/engine-adapter.ts`, `renderIntentText`).

**What a complete idea includes.** For `pm`: the venue and the market question, your side and price, your odds
with a checkable source and the date you read it, and the specific event that would prove you wrong. For `perp`:
instrument, long or short, entry, stop, size, leverage, and the reason the price should move, with the data and
the date. What fails and why: [Rulesets](../concepts/rulesets.md).

## Response

`200` with `ok: true`:

| Field | Meaning |
| --- | --- |
| `verdict` | `PASS`, `WAIT` or `FAIL`; or `REFUSED_SCOPE` (below). |
| `risk_score` | Sum of the weights that fired. |
| `flags` | Codes that fired, then `unknown:<field>` for each unsettled field. |
| `flags_detail` | One object per code: `code`, `name`, `description`, `severity`, `weight`, `evidence`. `evidence` is the rule's own sentence, not a quote of your text. |
| `unknown_fields` | Fields the check could not settle from the text. |
| `verdict_hash` | Recomputable fingerprint: [Verdicts](../concepts/verdicts.md#the-verdict-hash). |
| `intent_sha256` | Binding key for the exact text checked. |
| `intent_hash` | The EIP-712 key the paid route would attest, or `null` when the intent lacks the fields it needs (a bare `thesis` gives `null`). |
| `tally`, `taxonomy`, `ruleset` | The inputs to the verdict rule, the ruleset and extraction versions with their hashes. |
| `quota` | `day`, `limit`, `used`, `remaining`, `resets_at`. |
| `attested` | Always `false`. |
| `receipt` | How to buy the attested version: [Paid check over HTTP](paid-http.md). |

**Wrong kind.** If the idea does not read as the `kind` named, the answer is `200` with
`verdict: "REFUSED_SCOPE"`, a `reason`, and no score. It still uses one of the day's checks.

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_json`, `bad_kind`, `missing_intent`, `bad_anon_id`, `bad_address`, `bad_signature_format`, `day_mismatch` | The request is malformed. `day_mismatch` returns the server's `day`. |
| 401 | `bad_signature` | The signature does not recover to `address`; the answer includes `signed_text_expected`. |
| 413 | `intent_too_large` | The intent is over 4096 bytes. |
| 429 | `wallet_quota_exhausted` | This id or wallet used today's checks. |
| 429 | `free_tier_exhausted_today` | The global daily cap is reached. |
| 503 | `audit_unavailable`, `quota_store_unavailable`, `try_unavailable` | The check could not run. A failed run gives the slot back (`slot_released: true`). |

## Two helper reads

* `GET https://mcp.djzs.ai/try/quota?anon=<id>`: checks left for that id today. Without `anon`, the signing
  template, the current `day`, and the receipt offer.
* `GET https://mcp.djzs.ai/try/example`: curated real markets with live prices. Only markets that are still open
  are served, so the list can be empty.
