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
| `unsettled` | On a `WAIT` only: for each unknown field, what the three readings did and which of your sentences they pointed at. [Below](#which-sentence-a-wait-is-about). |
| `verdict_hash` | Recomputable fingerprint: [Verdicts](../concepts/verdicts.md#the-verdict-hash). |
| `intent_sha256` | Binding key for the exact text checked. |
| `intent_hash` | The EIP-712 key the paid route would attest, or `null` when the intent lacks the fields it needs (a bare `thesis` gives `null`). |
| `tally`, `taxonomy`, `ruleset` | The inputs to the verdict rule, the ruleset and extraction versions with their hashes. |
| `quota` | `day`, `limit`, `used`, `remaining`, `resets_at`. |
| `attested` | Always `false`. |
| `receipt` | How to buy the attested version: [Paid check over HTTP](paid-http.md). |

**Wrong kind.** If the idea does not read as the `kind` named, the answer is `200` with
`verdict: "REFUSED_SCOPE"`, a `reason`, and no score. It still uses one of the day's checks.

### Which sentence a WAIT is about

A `WAIT` carries one `unsettled` entry per field in `unknown_fields`, in the same order. Source:
`djzs-trust-mcp/src/unsettled.ts`.

```json
"unsettled": [
  {
    "field": "invalidation_condition",
    "why": "split",
    "states": { "present": 2, "absent": 0, "unknown": 1 },
    "sentences": [
      {
        "text": "I am wrong if a voting FOMC member publicly calls for a rate change before December 8, 2026.",
        "present": 2,
        "absent": 0
      }
    ]
  }
]
```

| Field | Meaning |
| --- | --- |
| `why` | `split`: the three readings disagreed. `evidence`: all three found the fact missing but quoted different text, so the check does not rely on any of them. `silent`: none of them could settle it. |
| `states` | How many readings ended `present`, `absent` or `unknown` after the extraction's own checks ([Extraction](../concepts/extraction.md)). |
| `sentences` | Sentences from your intent, verbatim (whitespace collapsed, the rendered `key: ` prefix removed, at most 400 characters), in text order. `present`: readings that found the fact there. `absent`: readings that quoted it as showing the fact is missing. Can be empty. |

The sentences are located, never written: one appears only when a reading's quote or value matches it, exactly
or, for a paraphrase, by most of its words. The field comes from the readings the check already ran. It is not
part of the verdict or `verdict_hash`, and the paid routes do not return it.

## From an MCP client

The MCP server has the same check as a tool, `check_thesis`, for clients that cannot sign a payment (a chat app,
or a hosted agent runtime). Source: `djzs-trust-mcp/src/free-check-tool.ts`.

| Argument | |
| --- | --- |
| `kind` | `prediction_market` or `perp_or_spot` |
| `thesis` | The thesis in the user's own words, 20 to 3500 characters |

It runs this route in-process, so the verdict, score and `verdict_hash` are what `POST /try/verdict` returns for
the same text. The result adds `status` (`OK`, `LIMIT_REACHED` or `UNAVAILABLE`), `free: true` and
`attested: false`. Nothing is written on-chain and no payment is asked for.

All MCP callers share one daily allowance (60 checks per UTC day by default, the Worker var
`TRY_MCP_DAILY_LIMIT`), inside the global daily cap. When either is used up the tool returns `LIMIT_REACHED`
with `resets_at`, and the paid tools still work.

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
