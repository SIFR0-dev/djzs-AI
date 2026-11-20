# Rulesets

Two frozen rulesets. Weights, severities and thresholds are code, hashed, and reported in every response under
`taxonomy`. The plain names are the ones djzs.ai shows people.

## Prediction markets: `DJZS-PM-v1.0`

Four codes, weights sum to 100, FAIL at 25 (`shared/pm-taxonomy.ts`). All four are live.

| Code | Name | Plain name | Severity | Weight | Fires when | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| DJZS-M01 | NARRATIVE\_RESOLUTION\_GAP | Off the market's terms | CRITICAL | 30 | The reasoning argues something next to the market's question, not its own date, threshold, definition or settlement source. | Argue the market's own terms: the date it resolves, its threshold or definition, and the source that settles it. |
| DJZS-M02 | FALSIFICATION\_ABSENT | No way to be wrong | CRITICAL | 30 | Nothing stated would prove the bet wrong before it resolves. | Write the specific event that would prove you wrong before the market settles. |
| DJZS-M03 | PROBABILITY\_UNSOURCED | Odds with no source | HIGH | 25 | A probability, stated or implied, has no checkable basis. | Name the source, the figure, and the date you read it. A dataset, an official source or your own math counts; a rumor or a feeling does not. |
| DJZS-M04 | CONSENSUS\_NO\_EDGE | Agreement is not an edge | MEDIUM | 15 | The stated edge is the consensus or the price itself. | Say why the market is wrong. Advisory: it never changes a verdict. |

Either CRITICAL code alone is a FAIL. M03 alone weighs 25, which meets the line, so it is a FAIL by itself too.
M04 can only change the score and the hash ([Verdicts](verdicts.md)).

Hashes reported as `taxonomy.pm_weights_hash` and `taxonomy.pm_taxonomy_hash`:
`0xb4102cd37df7f6bcfdc8d8468296a3bc1e59c41593effc8dbb1cb71922a1bb64` and
`0xf7792040e4d30a3736c5b9480fccf5814e02d6392d893da2e5103a9074b7bace`.

## Perp and spot: `DJZS-LF-v1.2`

Eleven codes, weights sum to 200, FAIL at 50 (`shared/audit-schema.ts`, `server/engine-v2/verdict-rule.ts`).
Four have engine rules today (`server/engine-v2/deterministic-engine.ts`):

| Code | Name | Plain name | Severity | Weight | Fires when | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| DJZS-S01 | CIRCULAR\_LOGIC | No reason for the trade | CRITICAL | 30 | A position (leverage or size) is stated and the text shows there is no reason for it. | Say in one sentence why the price should move. |
| DJZS-E01 | ORACLE\_UNVERIFIED | Data source not vouched for | HIGH | 25 | Data is cited but no price source gives it provenance. | Name each source, who publishes it, and when you read it. |
| DJZS-I01 | FOMO\_LOOP | Chasing the crowd | MEDIUM | 16 | The data behind the trade is a social signal. | Replace it with a number you can check, or say why the crowd is wrong. |
| DJZS-X01 | EXECUTION\_UNBOUND | No stop or size limit | CRITICAL | 15 | A position is stated with no stop and no invalidation condition. | Write the stop level and the largest size you will allow. |

S01 fires only when a reading quotes the text showing no reason is given. An unclear reason is `unknown` and
gives a WAIT, never this flag.

Defined, with no rule wired yet: S02 LAYER\_INVERSION (25), S03 DEPENDENCY\_GHOST (18), E02
CONFIDENCE\_INFLATION (18), I02 MISALIGNED\_REWARD (16), I03 DATA\_UNVERIFIED (16), X02 RACE\_CONDITION (9),
T01 STALE\_REFERENCE (12). They cannot fire today.

Hashes reported as `taxonomy.weights_hash` and `taxonomy.taxonomy_hash`:
`0x083b9ce901ec3defe5da6ef1d83381ff329bf8beddcfa02ebe4e5f75855067b0` and
`0x9a7d3e9df2f2bc8855b05bdf604e3354d1d99e8212644f01326ccbb577f69ab7`.

## What the rulesets do not check

Whether your facts are true, whether a quoted price is live, whether the market has already settled, or whether
the trade will win. A well-formed but invented source passes the source rule: the rule checks that a basis is
stated, not that it is real.
