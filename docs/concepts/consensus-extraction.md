# Consensus extraction

The only model-bound stage in the system, deliberately quarantined
(`server/engine-v2/extraction-layer.ts:1-19`). The model's single job is to **report observable facts
in tri-state form**. It never judges, scores, or advises.

**Verdict is computed, not improvised.**

---

## The transport seam

```ts
type ModelFn = (prompt: string) => Promise<string>
```

`server/engine-v2/extraction-layer.ts:31`. Prompt in, raw text out — nothing else. The model is
*injected*, which is what makes the layer testable with a stub and runnable with no API key.

In production the Worker builds this from a request-scoped secret (`buildAnthropicModelFn`,
`djzs-trust-mcp/src/verify-pm-trade.ts:40-62`): a bare `fetch` at `temperature: 0`,
`max_tokens: 1024`. Reading the key from the passed-in argument rather than module-scope `process.env`
is the one change that made the layer Worker-compatible.

Swapping the model changes extraction *quality*. It cannot change a rule, a weight, or a hash.

---

## N = 3, merged by state unanimity

`extractAuditInputConsensus` (`server/engine-v2/extraction-layer.ts:497-572`). Three independent
samples of the **same** prompt, issued in parallel, then merged field by field.

```
                    +--> sample 1 --> parseOne --> AuditInput + surviving quotes
one prompt --+------+--> sample 2 --> parseOne --> AuditInput + surviving quotes
             |      +--> sample 3 --> parseOne --> AuditInput + surviving quotes
             |                            |
             +----------------------------+--> MERGE, per field:
                                               state split  -> unknown + disagreement
                                               all absent   -> evidence check, then absent
                                               all unknown  -> unknown
                                               all present  -> merge values
```

Merge rules, over `CONSENSUS_FIELDS` = the 8 perp fields plus `resolution_engagement`,
`probability_basis`, `edge_claim` (`:441`):

**State split → unknown.** If the three samples do not agree on the *state*, the field is demoted and
its name appended to `disagreements` (`:529-532`).

**All present → merge the values** (`:558-563`):

| Field | Merge |
|---|---|
| `data_sources` | union of all three arrays, case-insensitive dedupe, original casing kept (`:476`) |
| `oracle_source` | de-duplicated, joined with `" \| "` |
| everything else | strict-JSON majority if one exists, else sample 1 (`:461-473`) |

**Non-tri-state fields.** `agent_type`, `intended_action`, `market_type` take the majority
(`:508-517`). `audit_context` is a plain enum with a **2-of-3 vote** (`:519-522`): fewer than two
`"prediction_market"` votes and the field stays unset, routing the audit down the perp path — and, on
the Worker, out of scope entirely.

---

## Evidence-unanimity: identical states are not enough

`server/engine-v2/extraction-layer.ts:534-551`.

Three samples can all say `absent` while condemning **different claims**. Unanimous state with
divergent evidence is not consensus — it is three separate accusations. So for the three
evidence-bearing PM fields (`EVIDENCE_FIELDS`, `:445`), an `absent` merge additionally requires all
three surviving quotes to be **strictly identical** after normalization:

```
normalizeEvidence = lowercase -> collapse whitespace -> trim -> strip trailing .,;:!?
```

`:448`. Strict identity, not containment — a superset quote must not unify with a narrower one.

On failure the field demotes to `unknown` and the telemetry entry is tagged
`probability_basis(evidence)`. So `disagreements` distinguishes two failure modes:

| Entry | Meaning |
|---|---|
| `probability_basis` | **state** split — samples disagreed present/absent/unknown |
| `probability_basis(evidence)` | **evidence** split — all three said absent, but quoted different text |

Only the three evidence-bearing PM fields can produce the second form.

Quotes travel to the merge on an internal channel and are non-null only for a field still `absent`
after every per-sample demotion (`:347-351`). The merged `AuditInput` stays clean — quotes live in the
retained `raw` output, never on a field, so they can never reach the hash preimage.

---

## Per-sample hardening, before consensus ever runs

`parseOne` (`:253-353`). Three hard guarantees, enforced regardless of how the model behaves
(`:13-16`), each with a direct assertion in `server/engine-v2/extraction.test.ts`:

**1 · Strict tri-state.** Every fact is `present`, `absent`, or `unknown`. An unrecognized or missing
`state` fails safe to `unknown` (`coerceField`, `:178-201`).

**2 · `present` with an empty value is a contradiction.** `null`, `undefined`, `""`, or `[]` coerces to
`unknown` (`:188-193`). Asserted at `extraction.test.ts:59` — "null value in 'present' is coerced to
UNKNOWN (fail-safe)".

**3 · Unparseable output → every fact unknown.** JSON is pulled from the first balanced `{...}` block,
tolerating markdown fences and prose (`extractJsonBlock`, `:579-584`). On failure the sample returns
all-unknown with `failsafe: true` (`:268-274`). Asserted at `extraction.test.ts:72` — "non-JSON model
output → all-UNKNOWN fail-safe → WAIT (never a verdict)".

Then the PM-specific gates run per sample: three quote gates
([see DJZS-M](pm-taxonomy.md#every-pm-absent-must-carry-a-quote)), the falsification-marker and
value-overlap demotions on `resolution_engagement`, and the M03 probability-token precondition.

`extraction_failsafe` on the response is `true` **only when all three samples failsafed** (`:569`) —
one garbled sample is absorbed by the merge.

Determinism downstream of extraction is asserted directly: `extraction.test.ts:80` — "DETERMINISM:
same model output → same verdict 25×".

---

## The bound this buys

> The model can be wrong, lazy, or garbled, and the worst it can do is make us WAIT. It can never make
> us PASS or FAIL on a guess.
>
> — `server/engine-v2/extraction-layer.ts:18-19`

Every defence in this layer is one-directional. Quote gates, evidence-unanimity, the empty-value
coercion, the failsafe, the probability-token precondition: each can only *demote* a field toward
`unknown`. Demotion suppresses findings and produces abstention. None can manufacture an `absent`, and
only an `absent` fires a rule.

The accepted cost is stated rather than hidden: **abstention rates.** Every gate that suppresses a
false positive also converts some true positives into WAITs. See
[calibration](../calibration.md#known-limitations).

**Abstain over guess.**

---

## Reading `disagreements` as a caller

Non-empty `disagreements` is not an error. It says the extraction could not read that field stably
across three samples — usually because the thesis is genuinely ambiguous on that point.

A field in `disagreements` **and** in `unknown_fields` is why you got a WAIT — clarify that field.

A field in `disagreements` but **not** in `unknown_fields` is outside the scored set for this path and
did not affect the verdict. The production `pm-block-008` replay is the canonical case: extraction
disagreed on `stop_loss`, which is not in `PM_AUDIT_FIELDS`, so it never entered the hash preimage and
`verdict_hash` held byte-identical (`CLAUDE.md:91`).
