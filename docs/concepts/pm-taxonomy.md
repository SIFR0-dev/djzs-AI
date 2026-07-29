# DJZS-M — prediction-market taxonomy

`DJZS-PM-v1.0`. Four codes. Weights sum to **100**. FAIL threshold **25**. **Complete: 4/4 wired and
firing.**

Table: `shared/pm-taxonomy.ts:31-64`. Rules: `server/engine-v2/deterministic-engine.ts:124-172`.

| Code | Name | Severity | Weight | Fires when |
|---|---|---|---:|---|
| DJZS-M01 | NARRATIVE_RESOLUTION_GAP | CRITICAL | 30 | `resolution_engagement` is **absent** |
| DJZS-M02 | FALSIFICATION_ABSENT | CRITICAL | 30 | `invalidation_condition` is **absent** |
| DJZS-M03 | PROBABILITY_UNSOURCED | HIGH | 25 | `probability_basis` is **absent** |
| DJZS-M04 | CONSENSUS_NO_EDGE | MEDIUM | 15 | `edge_claim` is **absent** (advisory) |

Each rule fires only on `absent`. `unknown` never fires anything — it drains to WAIT.

The table asserts its own integrity at module load: weights summing to anything but 100 throws
`[DJZS-M FATAL]` (`shared/pm-taxonomy.ts:76-81`). Its header states the separation explicitly — DJZS-M
and DJZS-LF **never share a code namespace or a hash** (`:1-13`). Computed at the pinned SHA:

```
PM_WEIGHTS_HASH   0xb4102cd37df7f6bcfdc8d8468296a3bc1e59c41593effc8dbb1cb71922a1bb64
PM_TAXONOMY_HASH  0xf7792040e4d30a3736c5b9480fccf5814e02d6392d893da2e5103a9074b7bace
```

Both ride every audit response (`djzs-trust-mcp/src/verify-pm-trade.ts:100-102`).

---

## Which stacks block

The threshold is 25 and the comparison is `>=` (`server/engine-v2/deterministic-engine.ts:271`):

| Combination | Score | Verdict | Why |
|---|---:|---|---|
| **M01 alone** | 30 | **FAIL** | 30 ≥ 25 — *and* CRITICAL |
| **M02 alone** | 30 | **FAIL** | 30 ≥ 25 — *and* CRITICAL |
| **M03 alone** | 25 | **FAIL** | exactly at threshold; `>=` |
| M04 alone | 15 | **PASS** | advisory: under threshold, MEDIUM |
| M03 + M04 | 40 | **FAIL** | the stack the first external audit hit |
| M02 + M04 | 45 | **FAIL** | already failing on M02 alone |

**Three of the four codes condemn alone.** A single M01 or M02 fire is an instant FAIL — a reader who
misses this mis-models the engine entirely. M03 reaches the line exactly.

M04 is the sole exception, and because every other code already fails on its own, M04 stacking onto one
of them raises `risk_score` without ever flipping the verdict. See
[the verdict ladder](verdict-ladder.md#m04-is-advisory--a-pass-can-carry-a-flag).

**M04 is scored, not excluded from scoring.** Its 15 points sit inside the frozen 100-point budget and
count toward `risk_score`. Advisory means sub-threshold, not unscored.

---

## DJZS-M01 — NARRATIVE_RESOLUTION_GAP

*Thesis reasons about a narrative adjacent to the actual resolution question.*

The most common way a prediction-market bet is wrong while feeling right: the trader argues something
true that the market does not pay out on. Four adjacency shapes, all classified absent by the
extraction prompt (`server/engine-v2/extraction-layer.ts:92-96`):

| Shape | Adjacency |
|---|---|
| **a** | title/direction only — argues the headline, not the resolved question |
| **b** | wrong source — relies on an authority other than the market's resolution source |
| **c** | wrong threshold/definition — argues an adjacent cutoff |
| **d** | wrong window — the event happens, but not inside the market's window |

Engagement means arguing about **the market's own criterion**. A different date, threshold, or
authority is adjacency. "This year" does not engage a market resolving on a specific meeting
(`extraction-layer.ts:88-90`).

Three things are explicitly **never** adjacency (`:99-108`): a personal invalidation or exit level
(trade construction); the mere absence of a source citation; and a thesis that argues *nothing at all*
— the bet plus an exit level with no argued claim is `unknown`, never absent. Absent requires an
**identifiable argued adjacent claim**. Judge the reasoning, not the bet statement.

## DJZS-M02 — FALSIFICATION_ABSENT

*No stated condition that would prove the thesis wrong before resolution.*

The prediction-market analog of a missing stop-loss. A stated falsification is a *pre-resolution*
observable that would make the trader wrong (`extraction-layer.ts:70-77`).

- A thesis asserting the outcome with **no** falsifiable condition — pure narrative, "everyone knows
  this resolves YES" — is an affirmative absence → **absent**.
- A thesis merely **silent** on what would make it wrong → **unknown**.

## DJZS-M03 — PROBABILITY_UNSOURCED

*Market or model probability asserted without verifiable basis.*

An **assertion** is a claimed likelihood or edge. A **verifiable basis** is checkable data or
derivation *named in the reasoning* — a dataset or filing, an official source or schedule, the market's
own pricing history, or an explicit derivation with stated inputs, including the thesis's own shown
work (`extraction-layer.ts:111-130`).

`present` is satisfied two ways, and the second is easy to miss: either every assertion carries a
basis, **or the reasoning asserts no probability at all** — nothing claimed means nothing unsourced,
vacuously present.

`absent` requires an assertion whose only support is rumor-grade: an unnamed insider, a tweet, "people
are saying", a **forecasting track record**, bare conviction, or nothing. Three carve-outs:

- **Attribution is not verification.** Naming *who* said it does not make it checkable.
- A documented pattern **in the resolution source itself** is not a forecasting track record — it is
  checkable evidence.
- A conclusion the reasoning **derives** from stated facts or the market's own criteria is not
  unsourced; the shown derivation is its basis.

### The definitional precondition

M03 requires an *asserted probability* to exist. If `probability_basis` survives as absent but the
intent contains **no explicit probability token anywhere**, the field is demoted to `unknown`
(`server/engine-v2/extraction-layer.ts:323-328`). Tokens (`:250`):

```
%   percent   odds   chance   likel   probabl
```

Certainty prose without a number — "approval is already done" — is not a probability claim. Absence of
an assertion drains to abstention, never to a finding.

## DJZS-M04 — CONSENSUS_NO_EDGE

*Thesis restates consensus at an extreme price with no differentiated edge.*

`present`: the reasoning articulates why the market is **wrong** or has not priced something
(`extraction-layer.ts:146-158`).

`absent`: the stated case for the bet **is** the consensus or the price itself — "it's at 92c and
everyone knows", "the crowd has this right, easy money".

The distinction that keeps false positives down: **merely citing the price as data is not absent.**
Absent requires the consensus or price to *be* the argued case.

`edge_claim` sits in neither `PM_AUDIT_FIELDS` nor `isBounded`
(`server/engine-v2/audit-input-schema.ts:53-59`) — the rung-membership principle. The rule guards on
the field's existence so legacy inputs omitting the key hash identically
(`deterministic-engine.ts:161-165`).

---

## Every PM absent must carry a quote

No PM finding is trusted on the model's word alone. Three gates run per sample, before consensus:

| Field | Gate | Requires |
|---|---|---|
| `resolution_engagement` | `gateResolutionEngagement` (`extraction-layer.ts:370`) | a shape tag `a`–`d` **and** a verbatim intent quote |
| `probability_basis` | `gateProbabilityBasis` (`:397`) | a verbatim intent quote |
| `edge_claim` | `gateEdgeClaim` (`:422`) | a verbatim intent quote |

"Verbatim" is checked by whitespace-collapsed, lowercased containment against the original intent
(`:359`, `:381`). A quote the model invented is not in the intent, fails the check, and the field
demotes to `unknown` — which can only *suppress* a flag, never fire one.

`resolution_engagement` runs two further demotions, because a falsification clause is never the argued
thesis:

1. **Value overlap** with the same sample's `invalidation_condition` value (`:295-304`).
2. **Falsification markers** — `wrong if`, `invalid if`, `invalidation` (`:243`, `:311-316`). This
   exists because the model paraphrases its own invalidation value, defeating lexical containment.

Then [consensus extraction](consensus-extraction.md) adds evidence-unanimity across the three samples.
A surviving absent is stripped to a bare `{state:"absent"}`; shape and quote persist only in the
retained raw output, never on the field — so they can never reach the hash preimage.
