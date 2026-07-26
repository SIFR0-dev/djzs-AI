# The verdict ladder

Three rungs, not two. The third rung is the point.

This ladder is the **tri-state action map** and nothing else
(`djzs-trust-mcp/src/verify-pm-trade.ts:89-90`):

```
PASS -> PROCEED
WAIT -> HALT
FAIL -> FAIL
```

Verdict rungs are declared at `server/engine-v2/deterministic-engine.ts:9-13`:

```
FAIL   a rule fired on facts we KNOW
WAIT   we lack a fact we'd need to clear or condemn
PASS   every scored fact is known, no blocking rule fired
```

**Abstain over guess.** A two-valued auditor forced to choose on missing information has to invent
one. It either fabricates a PASS and waves through an unreadable thesis, or fabricates a FAIL and
blocks a legitimate trade for a defect it never observed. WAIT is the refusal to do either.

---

## The rule that makes it work: absent ≠ unknown

Every scored fact is tri-state (`server/engine-v2/audit-input-schema.ts:21-26`):

| State | Meaning | Effect |
|---|---|---|
| `present` | the model extracted a concrete value | can satisfy a boundedness check |
| `absent` | the model affirmatively asserts the fact does **not** exist | **can fire a rule** |
| `unknown` | the model could not determine it, or refused to guess | can only cause WAIT |

Every rule fires on affirmative knowledge only. A rule whose predicate depends on an `unknown` field
does not fire (`server/engine-v2/deterministic-engine.ts:62-64`). A stated "no stop loss" is a
finding. Silence about stops is a question.

The consequence is a hard bound on model misbehaviour: the extraction model can be wrong, lazy, or
garbled, and the worst it can do is make the engine **WAIT**. It can never make the engine PASS or
FAIL on a guess (`server/engine-v2/extraction-layer.ts:17-19`). Asserted directly in
`server/engine-v2/extraction.test.ts:38` (a vague stop drains to UNKNOWN → WAIT, "not a guess") and
`:72` (non-JSON model output → all-UNKNOWN fail-safe → WAIT, "never a verdict").

---

## The PM ladder, exactly as coded

`server/engine-v2/deterministic-engine.ts:244-288`. Reached only when
`audit_context === "prediction_market"` (`:180`).

**Step 1 — run the four PM rules** (`:174`). Each fires on an `absent` scored field.

**Step 2 — collect unknowns** over `PM_AUDIT_FIELDS` only — `invalidation_condition`,
`resolution_engagement`, `probability_basis` (`server/engine-v2/audit-input-schema.ts:88`).

**Step 3 — `isBounded`.** All three scored PM fields must be `present` (`:266-269`):

```
isBounded(PM) = invalidation_condition.present
            AND resolution_engagement.present
            AND probability_basis.present
```

A bet the engine could not audit on every scored field is not certified.

**Step 4 — decide, in this order** (`:271-279`):

```
1. any CRITICAL flag, OR risk_score >= 25   ->  FAIL
2. zero flags AND isBounded                 ->  PASS
3. any unknown scored field                 ->  WAIT
4. otherwise                                ->  PASS
```

Read rung 1 carefully: a real finding on known facts condemns **even amid open questions**. A CRITICAL
never waits for an unrelated unknown to resolve.

Rung 4 is the M04 advisory door: flags exist (rung 2 skipped) and nothing is unknown (rung 3 skipped),
so the thesis lands on PASS carrying its flag.

### `hasCritical` is redundant on the PM path and load-bearing on the perp path

Rung 1 has two independent triggers, and which one does the work differs by taxonomy:

| Path | Threshold | CRITICAL codes | Severity clause load-bearing? |
|---|---:|---|---|
| **PM** | 25 | M01 (30), M02 (30) | **No.** Both clear 25 on weight alone. |
| **Perp** | 50 | S01 (30), X01 (15) | **Yes.** Neither reaches 50; both condemn *only* via severity. |

**DJZS-X01 EXECUTION_UNBOUND is weight 15 against a threshold of 50**, so the severity override is the
entire mechanism by which an unbounded position condemns. Score it and it looks trivial; it is not.

Do not infer severity from weight in either direction. On the PM path M03 (HIGH, 25) blocks alone
while M04 (MEDIUM, 15) cannot; on the perp path X01 (CRITICAL, 15) blocks alone while E01 + I01 (41
combined, neither CRITICAL) do not.

---

## The perpetuals ladder

Same shape, different constants (`server/engine-v2/deterministic-engine.ts:184-224`).

| | Perp | PM |
|---|---|---|
| Rules | X01, E01, I01 (`:117`) | M01–M04 (`:174`) |
| Weight sum | 200 | 100 |
| FAIL threshold | **50** (`:43`) | **25** (`shared/pm-taxonomy.ts:74`) |
| Unknown set | `AUDIT_FIELDS`, 8 fields | `PM_AUDIT_FIELDS`, 3 fields |
| `isBounded` | `stop_loss.present` **OR** `invalidation_condition.present` (`:198-200`) | all three, **AND** |

The perp `isBounded` is a disjunction: one halt condition is enough for a perpetual. The PM
conjunction is stricter because a prediction market has no stop-loss to fall back on.

**The perp engine path computes a WAIT, but the perp certificate type cannot carry one.**
`AuditVerdict` is `"PASS" | "FAIL"` (`shared/audit-schema.ts:14`). See
[DJZS-LF](perp-taxonomy.md).

---

## M04 is advisory — a PASS can carry a flag

DJZS-M04 CONSENSUS_NO_EDGE weighs 15 (`shared/pm-taxonomy.ts:56`) against a FAIL threshold of 25, and
its severity is MEDIUM. So a solo M04 cannot reach rung 1; with all three scored fields present it
cannot reach rung 3 either. It lands on rung 4:

```
verdict: PASS   action: PROCEED   risk_score: 15   flags: [DJZS-M04]
```

Deliberate, and said so in the code — "a solo M04 advisory rides a PASS here by design"
(`djzs-trust-mcp/src/verify-pm-trade.ts:107`).

**M04 is scored, not excluded.** Its 15 points sit inside the frozen 100-point budget and count toward
`risk_score`. What it cannot do is cross the line by itself.

It also never changes an outcome by stacking: every other PM code already fails on its own (M01 30,
M02 30, M03 25 — all ≥ 25). So M04's whole contribution to a blocking verdict is arithmetic and a flag
on the certificate — 40 rather than 25; 45 rather than 30. **M04 is the only PM code that cannot block
alone, and also the only one whose presence never flips a verdict.** A disclosure, not a gate.

**A PASS with a non-empty `flags` array is a real outcome.** If your gate treats `flags.length > 0` as
a block, you will halt on advisories the engine deliberately let through. Gate on `action`.

---

## The rung-membership principle

A field joins the scored sets — `PM_AUDIT_FIELDS` and `isBounded` — **iff a solo block depends on it.**
`edge_claim` is in neither (`server/engine-v2/audit-input-schema.ts:53-59`), because a solo M04 cannot
block by frozen weight. Two consequences:

- Advisory uncertainty creates no WAIT pressure. An unknown `edge_claim` does not halt a thesis that is
  otherwise fully specified.
- `unknown_fields` feeds the hash preimage, so keeping `edge_claim` out keeps existing PM
  `verdict_hash` values frozen. The M04 rule guards on the field's existence for exactly this reason
  (`server/engine-v2/deterministic-engine.ts:161-165`).

Corollary, a standing ruling: `probability_basis` **stays** in `isBounded(PM)`. Removing it breaks the
recall floor. `pm-m03-seed-001` is the live tripwire, and the accepted cost is abstention.

---

## What each verdict obliges a caller to do

| Verdict | `action` | Obligation |
|---|---|---|
| FAIL | `FAIL` | Do not execute. Report verdict, `risk_score`, fired codes. Do not soften into a partial position. |
| WAIT | `HALT` | Do not execute. Read `unknown_fields` and `halt_reason`, clarify, re-audit. |
| PASS | `PROCEED` | Necessary, not sufficient. Downstream gates still apply. Record `verdict_hash` and the certificate. |

The loop for HALT is in [for agents](../for-agents.md).
