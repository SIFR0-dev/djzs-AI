# Quickstart

Two transports, three ways to connect. They all reach the same Worker at
`https://mcp.djzs.ai/mcp` — pick one.

## Connect

**1 — Streamable HTTP (native).** For clients that speak MCP over HTTP directly:

```
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

**2 — stdio bridge (published shim).** For stdio-only frameworks. The `@sifr0-dev/djzs-ai`
package spawns `npx mcp-remote https://mcp.djzs.ai/mcp` and pipes stdio straight through;
on a spawn failure it prints the transport-1 one-liner and exits
(`packages/djzs-ai-shim/bin.js:21-33`). It resolves `mcp-remote ^0.1.38` from npm at
invocation time (`packages/djzs-ai-shim/package.json`):

```
npx -y @sifr0-dev/djzs-ai
```

**3 — raw bridge (same transport as 2, unpinned).** The shim's underlying call, without the
wrapper:

```
npx mcp-remote https://mcp.djzs.ai/mcp
```

## Payment — read this first

`verify_pm_trade` is **paid: 2.00 USDC per audit, x402 on Base mainnet**
(`djzs-trust-mcp/src/index.ts:58`). The buyer's wallet must hold **at least the price
before the call** — the facilitator's verify simulates the transfer, so an underfunded
wallet fails with `INVALID_PAYMENT` (`CLAUDE.md:124`).

The two registry tools — `query_pol_certificates` and `query_agent_trust` — are **free**;
`withX402` gates only the paid tool (`index.ts:94-95`). And a **refused** audit is free: an
out-of-scope intent returns before settlement and is never charged (see the reference).

## Your first audit

Call `verify_pm_trade` with a single `intent` — a free-text prediction-market thesis, at
least 10 characters (`verify-pm-trade.ts:27-32`). Read the response by these fields:

- **`verdict`** — `PASS` / `WAIT` / `FAIL`.
- **`action`** — `PROCEED` / `HALT` / `FAIL`, the operator instruction (`verify-pm-trade.ts:89-90`).
- **`risk_score`** — summed weight of the flags that fired (PM budget 100, FAIL at 25).
- **`flags`** — the DJZS-M defects that fired, as full objects.
- **`disagreements`** — where the N=3 extraction did not agree.
- **`verdict_hash`** — the reproducible fingerprint of the verdict-bearing content.

**Illustrative FAIL** — constructed from the taxonomy to show the shape; not a live call.

Intent: *"YES on this market — everyone on Crypto Twitter says it resolves yes, so it's
basically free money."* No resolution criteria engaged, no falsification condition, and the
only cited basis is social sentiment. Three PM defects fire (flag objects abbreviated to
`code`/`name`/`severity`/`weight`):

```json
{
  "tool": "verify_pm_trade",
  "in_scope": true,
  "verdict": "FAIL",
  "action": "FAIL",
  "risk_score": 85,
  "flags": [
    { "code": "DJZS-M01", "name": "NARRATIVE_RESOLUTION_GAP", "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M02", "name": "FALSIFICATION_ABSENT",     "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED",    "severity": "HIGH",     "weight": 25 }
  ],
  "unknown_fields": [],
  "verdict_hash": "0x…"
}
```

`risk_score` 85 is far past the FAIL line (25), and two CRITICAL flags fired either way —
**FAIL → do not send the trade.** A single M01 *or* M02 (weight 30) is already an instant
FAIL on its own.

## Out of scope

A non-PM intent is not audited: the tool returns `{ "in_scope": false, "verdict": null }`
with a `reason`, and that refusal **is not charged**. See the
[reference](reference/verify-pm-trade.md) for the exact contract and the payment consequence.
