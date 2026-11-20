# verify\_perp\_trade

Checks a perpetual or spot trade before it is placed. MCP tool on `https://mcp.djzs.ai/mcp`, 2.00 USDC per call
over x402 on Base. Source: `djzs-trust-mcp/src/verify-perp-trade.ts`, registered in `djzs-trust-mcp/src/index.ts`.

The same check is available over HTTP as `POST /x402/verify_perp_trade` ([Paid check over HTTP](../agents/paid-http.md))
and free as `POST /try/verdict` with `kind: "perp"` ([Free check](../agents/free-check.md)).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `intent` | string, at least 10 characters | The trade in plain text: instrument, direction, size, leverage, entry, stop, target, venue, and the reason the price should move. A position sent with no reason fails. |
| `bracket` | object, optional | Exact levels for a break-even calculation: `side` (`long` or `short`), `entry`, `stop`, `target`, `taker_fee_bps`, and optionally `hit_rate_pct`, `funding_rate_8h`, `sigma_annual`. Never enters the verdict or its hash. |
| `agent_address` | `0x` address, optional | Adds this check to that agent's on-chain trust score. Permanent and public. |
| `target_system`, `target_system_subject`, `target_system_signature` | optional | As on [verify\_pm\_trade](verify-pm-trade.md): a certificate label, stored only with a valid signature. |

## Output, in scope

The same fields as [verify\_pm\_trade](verify-pm-trade.md#output-in-scope), with these differences:

| Field | Notes |
| --- | --- |
| `tool` | `"verify_perp_trade"` |
| `taxonomy.extraction` | `DJZS-X-LF-v1.2` |
| `risk_score` | Sum of the weights that fired. FAIL at 50. The live codes are S01, E01, I01 and X01 ([Rulesets](../concepts/rulesets.md)). |
| `halt_reason` | On WAIT, the unresolvable fields, plus what to state when the reason or the exit is missing. |
| `fail_reason` | When S01 fired: the position was stated with no reason. |
| `mechanics` | `status: "not_scored"`, and with `bracket`, a `breakeven` block. Execution mechanics are reported beside the verdict, never inside it. |

How the verdict is decided, including why a bounded trade with a stated reason can PASS with some fields still
unknown: [Verdicts](../concepts/verdicts.md#the-rule-for-perp-and-spot).

## Output, out of scope

A prediction-market bet is refused here and **not charged**:

```json
{
  "schema_version": "DJZS-ENGINE-V2",
  "tool": "verify_perp_trade",
  "in_scope": false,
  "reason": "Perp-only tool: the intent extracted as a prediction-market thesis. Use verify_pm_trade.",
  "verdict": null
}
```

## What it does not read

The check reads the stated reasoning. It does not read the venue's live price, funding, open interest or
liquidation levels.
