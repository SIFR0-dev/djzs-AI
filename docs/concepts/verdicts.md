# Verdicts

The engine is a pure function of the extracted facts: no model, no network, no clock, no randomness
(`server/engine-v2/deterministic-engine.ts`). Every fact arrives as `present`, `absent` or `unknown`.

## The three answers

| Verdict | MCP `action` | What it means | What to do |
| --- | --- | --- | --- |
| PASS | `PROCEED` | Nothing failed and the idea is bounded. | The check does not say the trade wins, and it did not check your facts. Those stay yours. |
| WAIT | `HALT` | The check could not settle a fact the verdict depends on. It does not guess. | Treat it as a no. Over MCP, `halt_reason` names the fields; write them down and check again. |
| FAIL | `FAIL` | A rule fired on what the idea says. | Do not place it as stated. Each code maps to a fix: [Rulesets](rulesets.md). |

## The rule for prediction markets

Ruleset `DJZS-PM-v1.0`. In order, first match wins:

1. **FAIL** if any CRITICAL code fired, or if `risk_score` is 25 or more.
2. **PASS** if no code fired and all three scored facts are present: what would prove the bet wrong
   (`invalidation_condition`), engagement with the market's own terms (`resolution_engagement`), and a basis for
   the odds (`probability_basis`).
3. **WAIT** if any scored fact is `unknown`.
4. **PASS** otherwise. This is how M04 rides along: alone it weighs 15, under the line, so the verdict is PASS
   with the flag attached.

M04 is advisory and never changes a verdict. Over all 27 combinations of the three scored facts, the verdict is the
same with and without it (`tests/pm-engine-integrity.ts`, property 9). It adds 15 to `risk_score`, so it does
change `verdict_hash`.

## The rule for perp and spot

Ruleset `DJZS-LF-v1.2`. In order, first match wins:

1. **FAIL** if any CRITICAL code fired, or if `risk_score` is 50 or more.
2. **PASS** if no code fired, the position is bounded (a stop or an invalidation condition is present), and a
   reason for the trade is present (`thesis_statement`). Other unknown fields cannot change a no-flag verdict here,
   so a perp PASS can still list some.
3. **WAIT** if any scored fact is `unknown`.
4. **PASS** otherwise.

The perp scored facts: `leverage`, `position_size`, `stop_loss`, `take_profit`, `invalidation_condition`,
`data_sources`, `oracle_source`, `confidence`, `thesis_statement` (`server/engine-v2/audit-input-schema.ts`).

## Why WAIT exists

A fact becomes `unknown` when the check cannot confirm it either way: the three readings of the text disagree,
or a reading says it is missing without quoting the text that shows it ([Extraction](extraction.md)). The engine
abstains instead of guessing. The way out of a WAIT is to fix the text: the same text checked again usually gets
the same answer ([What is measured](../measured.md)).

## The verdict hash

`verdict_hash` is `0x` + sha256 of canonical JSON (keys sorted, no whitespace) over four fields: the verdict, the
score, the fired codes sorted, and the unknown fields in engine order. Nothing else is in it: not the text, not
the time, not the caller.

```python
import hashlib, json
pre = {"verdict": "FAIL", "risk_score": 40, "flags": ["DJZS-M03", "DJZS-M04"], "unknown_fields": []}
print("0x" + hashlib.sha256(json.dumps(pre, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
```

That prints `0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937`, the hash of the second
[Quickstart](../quickstart.md) example. Because the hash covers only those four fields, two different ideas with
the same outcome share a hash; the input is bound separately by `intent_sha256` and, on paid checks, by
`intent_hash` ([Receipts and certificates](receipts.md)).
