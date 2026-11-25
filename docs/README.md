# Deterministic Journaling Zone System

**DJZS checks the reasoning behind a trade before the order goes out.**

Send a prediction-market bet or a perp or spot trade in plain words. DJZS returns **PASS**, **WAIT** or
**FAIL**, the reasons it fired, the parts it could not settle, and a `verdict_hash` anyone can recompute.
It grades whether the idea is stated, falsifiable and bounded. It does not check that your facts are true,
and it never says the trade will win.

> **Audit before act.**
> **Verdict is computed, not improvised.**
> **Abstain over guess.**

## How a check works

```
your idea, as text
       |
       v
extraction    a model reads the text 3 times and reports facts, never a verdict
       |      (if the 3 readings disagree on a fact, that fact is "unknown")
       v
engine        fixed TypeScript rules: no model, no network, no randomness
       |
       v
PASS / WAIT / FAIL  +  flags  +  unknown fields  +  verdict_hash
```

Same extracted facts, same verdict, same hash (`server/engine-v2/deterministic-engine.ts`). The extraction step
reads the text three times, and when those readings disagree a fact becomes `unknown`, so the same text replayed
gets the same verdict 95 to 100% of the time in measurement: see [What is measured](measured.md).
How each part works: [Verdicts](concepts/verdicts.md), [Extraction](concepts/extraction.md).

## Three ways in

| Who | Where | Cost |
| --- | --- | --- |
| A person | Paste the idea at [djzs.ai](https://djzs.ai/) | Free, 3 a day per browser |
| An agent, free | `POST https://mcp.djzs.ai/try/verdict`: [Free check](agents/free-check.md) | Free, 3 a day per id |
| An agent, paid | MCP at `https://mcp.djzs.ai/mcp`, or HTTP: [MCP server](agents/mcp.md), [Paid check over HTTP](agents/paid-http.md) | 2.00 USDC per check on Base, with a permanent record |

The free check and the paid check run the same engine on the same rulesets. The paid check adds the record:
an EAS attestation on Base over HTTP, or a Proof-of-Logic certificate on Irys over MCP
([Receipts and certificates](concepts/receipts.md)).

## Status, 2026-11-20

Live:

* The free check, in the browser and over HTTP (`djzs-trust-mcp/src/try-route.ts`).
* `verify_pm_trade` and `verify_perp_trade` over MCP (x402) and over HTTP (x402 or MPP), 2.00 USDC per check
  on Base mainnet (`djzs-trust-mcp/src/index.ts`, `djzs-trust-mcp/src/http-x402-bazaar.v2.ts`).
* Prediction-market ruleset `DJZS-PM-v1.0`: 4 of 4 codes live. Perp and spot ruleset `DJZS-LF-v1.2`: 4 of its
  11 codes live (S01, E01, I01, X01). See [Rulesets](concepts/rulesets.md).
* Receipts: a paid HTTP check attests on EAS under schema v2. A paid MCP check anchors a certificate on Irys
  mainnet and, given `agent_address`, writes the agent's on-chain trust score. Both writes fail open: a failed
  write is reported in the response and never changes the verdict.

Not yet:

* Schema v3, where a resolver contract re-derives the verdict on chain, is built and tested but not deployed.
  Every DJZS attestation on Base so far uses the v2 schema
  `0x5ef67e2b8c617635431401d2872b2a6f79eeba54a8e19fd5ecd45aceda2a2030`.
* Whether verdicts predict outcomes is not known. The pre-registered study has 9 of the 100 graded records it
  needs for a first read. See [What is measured](measured.md).
* The check reads reasoning only. It does not check that a price is live, that a market is still open, or
  that a source says what you quote.

---

*Verified 2026-11-20 against commit `1cc11f9` (worker version `c6a886c1`), by probing the live endpoints and by
reading attestations on Base. Where these pages and the code disagree, the code wins.*
