# Quickstart

## In a browser

Go to [djzs.ai](https://djzs.ai/), pick **Prediction market** or **Perp or spot trade**, paste the idea and press
**Check it**. Three free checks a day per browser, no wallet. Edit the idea and press **Check again**: the page
shows what changed since the last check and which reasons cleared.

## One POST, free, no wallet

Make one id and keep it: it is your daily quota key (3 checks per id per UTC day).

```bash
ID=$(openssl rand -hex 16)
```

```bash
curl -s https://mcp.djzs.ai/try/verdict -H 'content-type: application/json' --data-binary @- <<EOF
{"kind":"pm","anon":"$ID","intent":{"thesis":"Kalshi, Fed decision at the December meeting: I'm buying YES on a hold. Everyone knows this resolves YES, it's free money."}}
EOF
```

This exact text was checked in production on 2026-11-19. The answer, trimmed:

```json
{
  "ok": true,
  "kind": "pm",
  "verdict": "FAIL",
  "risk_score": 100,
  "flags_detail": [
    { "code": "DJZS-M02", "name": "FALSIFICATION_ABSENT",     "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M01", "name": "NARRATIVE_RESOLUTION_GAP", "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED",    "severity": "HIGH",     "weight": 25 },
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE",        "severity": "MEDIUM",   "weight": 15 }
  ],
  "unknown_fields": [],
  "verdict_hash": "0xe3b9d790a5ed8375da25961867660e7af1036c14139d790aad1131e99eb923e8",
  "intent_sha256": "0xe50e392dd4a23029b35ff596d6262e9fbf889cccb4583e943b5b3cd466a7e6c4",
  "ruleset": "DJZS-PM-v1.0",
  "quota": { "limit": 3, "used": 1, "remaining": 2 },
  "attested": false
}
```

FAIL, twice over: two CRITICAL codes fired, and either one alone is a FAIL. The score (100) is also past the
prediction-market failing line (25). Each code maps to a fix: [Rulesets](concepts/rulesets.md).

**Fix and check again.** With the market's settlement terms and a way to be wrong added, the same id got:

> Kalshi, Fed decision at the December meeting: I'm buying YES on a hold. The market settles on the FOMC
> statement after the December meeting: YES if the target range is unchanged. A hold looks very likely: futures
> pricing has leaned that way for weeks. I am wrong if a voting FOMC member calls for a December cut before the
> meeting.

`FAIL`, `risk_score` 40, flags M03 and M04, `verdict_hash`
`0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937`. Both CRITICAL codes cleared. M03 (odds with
no checkable source) weighs 25, which reaches the failing line on its own. M04 is advice and never changes a
verdict. To clear M03, name the source of the odds, the figure, and the date you read it.

**A WAIT.** The same day:

> Kalshi, Fed decision at the December meeting: I'm buying YES on a hold at the current price, about 2% of my
> account.

`WAIT`, `risk_score` 0, `unknown_fields` `["invalidation_condition", "resolution_engagement"]`. Nothing fired, but
the check could not settle what would prove the bet wrong or whether it argues the market's own terms. Treat
WAIT as a no until those are written down.

Full request and response reference: [Free check](agents/free-check.md).

## MCP

```bash
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

Or, for clients that read a server map:

```json
{ "mcpServers": { "djzs-trust": { "type": "http", "url": "https://mcp.djzs.ai/mcp" } } }
```

Then call `verify_pm_trade` (prediction markets) or `verify_perp_trade` (perp and spot) with the idea as
`intent`. Each call costs 2.00 USDC over x402 on Base, so the client must be able to pay:
[MCP server](agents/mcp.md). The two read tools, `query_agent_trust` and `query_pol_certificates`, are free.

## Reading any verdict

| Field | Meaning |
| --- | --- |
| `verdict` | `PASS`, `WAIT` or `FAIL`. Over MCP, `action` adds `PROCEED`, `HALT` or `FAIL`. |
| `risk_score` | Sum of the weights that fired. Prediction markets fail at 25, perp and spot at 50. |
| `flags` / `flags_detail` | What fired, with code, name, severity and weight. |
| `unknown_fields` | What the check could not settle from the text. Usually this makes a WAIT; the exact rule is in [Verdicts](concepts/verdicts.md). |
| `verdict_hash` | `0x` + sha256 of the verdict, score, sorted codes and unknown fields. Recompute it: [Verdicts](concepts/verdicts.md#the-verdict-hash). |

---

*The three examples are production responses of 2026-11-19. Each response's `intent_sha256` equals `0x` + sha256 of `thesis: ` followed by the text shown, so each answer is tied to its exact input.*
