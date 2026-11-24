# Worked example: a perp trade, FAIL to PASS

One BTC perp thesis, checked three times on the free check: as first written, fixed, and with part of the fix
taken back out. Ruleset `DJZS-LF-v1.2`. All three are production responses of 2026-11-24 from
`POST https://mcp.djzs.ai/try/verdict` with `"kind": "perp"` ([Free check](../agents/free-check.md)).

The same text checked again usually gets the same answer, not always ([What is measured](../measured.md)). If
your run differs from this page, your run is the one that counts.

## 1. As first written: FAIL

```
Long BTC-PERP, 10x leverage, $5,000 size. BTC is going up. Entry now.
```

| | |
| --- | --- |
| Verdict | FAIL |
| `risk_score` | 15 |
| Code fired | `DJZS-X01` EXECUTION\_UNBOUND, "No stop or size limit", CRITICAL, weight 15 |
| Unknown | `take_profit`, `data_sources`, `oracle_source`, `confidence` |
| `verdict_hash` | `0xbd7850834ee26c46fb4b788581cc7a540155f1f527e8d2c0e44ca4c138e7244a` |
| `intent_sha256` | `0xa2f807d8763c7d798c675a578c2051caa9606bf8d56114709580e438b63f8e9a` |

Why it fails: a position is stated (10x, $5,000) with no stop and no condition that ends the trade. X01 is
CRITICAL, and any CRITICAL code is a FAIL whatever the score ([Verdicts](../concepts/verdicts.md)). The score of
15 is far under the perp failing line of 50; the severity decides here, not the score.

What did not fire: `DJZS-S01`, "No reason for the trade". The readings took "BTC is going up" as a stated
reason. S01 fires only when a reading quotes text showing that no reason is given
([Rulesets](../concepts/rulesets.md)). A thin reason is still a reason to this rule. The check does not grade how
good the reason is.

## 2. Fixed: PASS

```
Long BTC-PERP, 3x leverage, $2,000 size. Entry $58,900. Stop $57,400. Take profit $63,000. I am wrong if BTC
closes below $57,400 or if ETF inflows turn negative for two straight days. The reason: spot ETF inflows were
$420M yesterday, the largest in three weeks, and BTC held above $58,000 through the session; source: exchange
daily flow data published by the ETF issuers, read Nov 23, 2026. Funding is 0.01% per 8 hours.
```

(Sent as one line; wrapped here to fit the page.)

| | |
| --- | --- |
| Verdict | PASS |
| `risk_score` | 0 |
| Code fired | none |
| Unknown | `oracle_source`, `confidence` |
| `verdict_hash` | `0x8a510eb6bc54376325e5898097efc9abc4a93d5642a0dca8b391102ac2109922` |
| `intent_sha256` | `0x87f97b9db1bccdc0b86832ca19ee34300c548aa7f4b7a25c9ad410abe5eddc44` |

What changed the verdict: the stop. With a stop stated the position is bounded, so X01 has nothing to fire on.
No code fired, the position is bounded and a reason is present, which is the perp PASS rule.

Two facts are still `unknown` and the verdict is PASS anyway. On the perp ruleset, other unknown fields cannot
change a no-flag verdict once the trade is bounded and has a reason, so a perp PASS can list some. They are in
the response so you can see what the check could not settle.

What PASS does not say: that $420M is the real inflow figure, that the stop will fill at $57,400, or that the
trade wins. The rulesets check that a basis is stated, not that it is true.

## 3. Part of the fix removed: still PASS

The fixed text with the "I am wrong if..." sentence and the "read Nov 23, 2026" date taken out. The stop stays.

```
Long BTC-PERP, 3x leverage, $2,000 size. Entry $58,900. Stop $57,400. Take profit $63,000. The reason: spot ETF
inflows were $420M yesterday, the largest in three weeks, and BTC held above $58,000 through the session;
source: exchange daily flow data published by the ETF issuers. Funding is 0.01% per 8 hours.
```

| | |
| --- | --- |
| Verdict | PASS |
| `risk_score` | 0 |
| Code fired | none |
| Unknown | `oracle_source`, `confidence` |
| `verdict_hash` | `0x8a510eb6bc54376325e5898097efc9abc4a93d5642a0dca8b391102ac2109922` (the same as example 2) |
| `intent_sha256` | `0x4ee6ec5231e1ab907b5b5cbaade0467de4ecfee4ba91a4f3bbdc21a2ff092078` |

This is not a WAIT. The perp rule asks for a stop **or** an invalidation condition, and the stop alone bounds
the trade. Removing the invalidation sentence and the read date changed nothing the verdict depends on.

The two hashes show what each one binds. `verdict_hash` covers only the verdict, the score, the codes and the
unknown fields, so examples 2 and 3 share it. `intent_sha256` covers the text, so it differs.

## What moves a perp verdict, and what does not

| Change to the text | Effect here |
| --- | --- |
| Add a stop, or a condition that ends the trade | Clears X01. This took the example from FAIL to PASS. |
| Lower the leverage or the size (10x to 3x, $5,000 to $2,000) | None by itself. The rule asks whether the position is bounded, not how large it is. |
| Add a take-profit level | None. `take_profit` went from unknown to known and the verdict did not depend on it. |
| Add an invalidation sentence when a stop is already stated | None. One of the two is enough. |
| Add the date a source was read | None on this text. |
| Give a better reason | None, as long as some reason is stated. The check does not rank reasons. |

Rows one, three, four and five are what the three runs above show. Rows two and six follow from the rule text
and were not run as separate checks.

Only four of the eleven perp codes have rules today (S01, E01, I01, X01); the other seven cannot fire
([Rulesets](../concepts/rulesets.md)). A PASS means none of those four fired on this text. It is not a review of
the trade.
