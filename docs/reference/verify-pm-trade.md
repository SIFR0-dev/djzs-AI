# verify\_pm\_trade

Checks a prediction-market bet before it is placed. MCP tool on `https://mcp.djzs.ai/mcp`, 2.00 USDC per call
over x402 on Base. Source: `djzs-trust-mcp/src/verify-pm-trade.ts`, registered in `djzs-trust-mcp/src/index.ts`.

The same check is available over HTTP as `POST /x402/verify_pm_trade` ([Paid check over HTTP](../agents/paid-http.md))
and free as `POST /try/verdict` with `kind: "pm"` ([Free check](../agents/free-check.md)).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `intent` | string, at least 10 characters | The bet in the user's own words: the market, the side, the reason, the odds and where they come from, the size, and what would prove it wrong. Only what is written is judged. |
| `agent_address` | `0x` address, optional | Adds this check to that agent's on-chain trust score. Permanent and public. |
| `target_system` | string, 1 to 128 characters, optional | A label for the certificate. Stored only with the next two fields and a valid signature; otherwise discarded. |
| `target_system_subject` | `0x` address, optional | The address that signed the label claim. |
| `target_system_signature` | 65-byte hex signature, optional | EIP-191 signature by the subject over the claim text given in the tool's schema. |

## Output, in scope

| Field | Notes |
| --- | --- |
| `schema_version` | `"DJZS-ENGINE-V2"` |
| `tool`, `in_scope` | `"verify_pm_trade"`, `true` |
| `taxonomy` | `pm` (`DJZS-PM-v1.0`), `perp`, their weight and taxonomy hashes, `extraction` (`DJZS-X-v1.1`) |
| `verdict`, `action` | `PASS`/`PROCEED`, `WAIT`/`HALT`, or `FAIL`/`FAIL` |
| `risk_score` | Sum of the weights that fired, out of 100. FAIL at 25. |
| `flags` | Full objects: `code`, `name`, `severity`, `weight`, `evidence`. A solo M04 can ride a PASS. |
| `unknown_fields` | Scored facts the check could not settle. |
| `disagreements` | Facts the three readings split on, including `<field>(evidence)` entries ([Extraction](../concepts/extraction.md)). |
| `verdict_hash` | [Verdicts](../concepts/verdicts.md#the-verdict-hash) |
| `tally` | The inputs to the verdict rule: `ruleset`, `codes`, `unknown_count`, `bounded`, `thesis_present`. |
| `extraction_failsafe` | `true` only when every reading failed. |
| `halt_reason` | On WAIT: how many fields were unresolvable, and which. |
| `pol_certificate` | `anchored` (with the Irys id), `disabled` or `error`. |
| `trust_score` | Only with `agent_address`: the status of the on-chain write. |

## Output, out of scope

An idea that does not read as a prediction-market bet is refused and **not charged**:

```json
{
  "schema_version": "DJZS-ENGINE-V2",
  "tool": "verify_pm_trade",
  "in_scope": false,
  "reason": "PM-only tool: the intent did not extract as a prediction-market thesis. Perp auditing ships separately.",
  "verdict": null
}
```

Perp and spot trades go to [verify\_perp\_trade](verify-perp-trade.md).

## Example

The second [Quickstart](../quickstart.md) idea, checked on the free route on 2026-11-19, came back `FAIL`,
`risk_score` 40, flags M03 (HIGH, 25) and M04 (MEDIUM, 15), `verdict_hash`
`0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937`. The hash covers only the outcome, so any
check that ends FAIL 40 with M03 and M04 and nothing unsettled carries this hash; through this tool it reads
`action: "FAIL"`.
