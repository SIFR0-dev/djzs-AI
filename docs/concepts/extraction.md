# Extraction

A model reads the idea and reports facts. It never scores and never returns a verdict. Source:
`server/engine-v2/extraction-layer.ts`; model `claude-sonnet-4-6` at temperature 0
(`djzs-trust-mcp/src/verify-pm-trade.ts`).

## Three readings, one answer per fact

The text is read three times (N=3). Each reading reports every scored fact as `present`, `absent` or `unknown`.
The three are merged per fact:

* All three agree: that state stands.
* Any disagreement: the fact becomes `unknown`.

A fact that is `unknown` cannot fire a rule, so disagreement can only push a verdict toward WAIT, never toward a
false FAIL. Over MCP, the `disagreements` field lists which facts split.

## Quote gates

`absent` is a strong claim, so it needs evidence:

* **Every absent needs a verbatim quote** from the idea. A reading that says a fact is missing without quoting the
  text that shows it is demoted to `unknown`.
* **Critical absents need identical quotes.** A fact whose absence would fire a CRITICAL code merges to `absent`
  only if all three readings carry the same quote. Otherwise it becomes `unknown`, and `disagreements` lists it as
  `<field>(evidence)`.
* **Engagement is checked against falsification.** A quote offered as engagement with the market's terms that is
  really the falsification clause is demoted to `unknown`.
* **The basis quote is one span.** For the odds-basis fact, an absent quote must be one contiguous span of the text.

There is no keyword shortcut. Since contract `DJZS-X-v1.1` (2026-09-01), an unsourced probability does not need a
`%` or the word "odds" to be caught; "everyone knows" is an unsourced certainty claim like any other. The verbatim
quote is the whole evidence requirement.

## Contracts

| Contract | Used by | What it extracts |
| --- | --- | --- |
| `DJZS-X-v1.1` | prediction markets (`verify_pm_trade`, free `pm`) | `invalidation_condition`, `resolution_engagement`, `probability_basis`, plus the context and consensus facts M04 reads |
| `DJZS-X-LF-v1.2` | perp and spot (`verify_perp_trade`, free `perp`) | The perp facts in [Verdicts](verdicts.md), including `thesis_statement` with a quote-gated absent |

Every response names its contract under `taxonomy.extraction`. A contract change is versioned and measured before
it ships ([What is measured](../measured.md)).

## When extraction fails

If every reading fails, the result carries `extraction_failsafe: true` and the facts are `unknown`, which makes a
WAIT. On the free route a run that cannot complete returns `503 audit_unavailable` and gives the day's slot back.
