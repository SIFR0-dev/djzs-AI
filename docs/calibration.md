# Calibration

The bench, the method, and the limitations — including the ones that are uncomfortable to state.

Dataset: `server/engine-v2/calibration/calibration-dataset.json`, version `djzs-calibration-v0.3`.
Scorer: `server/engine-v2/calibration/score.ts`. Case schema: `dataset.schema.ts`.

---

## The bench

Recomputed from the dataset at the pinned SHA. Every number below is labelled with what it counts —
there are three different denominators in play and conflating them is easy.

**45 cases total.**

**Provenance, over all 45** — the `origin` field, whose union is public at `dataset.schema.ts:33`
(`"damon_validated" | "model_suggested"`):

| `origin` | Count |
|---|---:|
| `damon_validated` | **43** |
| `model_suggested` | **2** |

**Scoreable: 41 of 45.** Scoreable means `reviewed === true && scope === "coded_v0.1"` — the filter the
scorer applies (`score.ts:10`). The four exclusions, each for a different reason:

| Case | `origin` | Why excluded |
|---|---|---|
| `block-002` | `damon_validated` | `scope: "parked_uncoded"` — validated ground truth whose rule (DJZS-I02) is not built. Becomes that rule's acceptance test the day it is coded. |
| `block-003` | `damon_validated` | same |
| `block-004` | `model_suggested` | `reviewed: false` — never ratified |
| `block-005` | `model_suggested` | `reviewed: false` — never ratified |

**All 41 scoreable cases carry `origin: "damon_validated"`.** Verified by enumeration, not assumed: the
two `model_suggested` entries are exactly the two `reviewed: false` cases, and the scorer drops both.
So the headline figures are computed over 41 single-annotator-validated cases — see
[known limitations](#known-limitations) for what that costs.

Composition of the 41:

| Split | Count |
|---|---:|
| `label: "block"` (must be stopped) | 20 |
| `label: "execute"` (must not be blocked) | 21 |
| PM path (`pm-*`) | 20 |
| Perp path | 21 |

Across all 45: 27 carry a `near_pair_id`; 40 are `difficulty: "hard"`, 5 `"easy"`.

> Ground truth is the annotator's, not the model's. **Never fabricate, relabel, or edit a case's label
> or intent to make it pass.** A bench that moves to accommodate the engine measures nothing.

---

## Method: near-pairs

**27 of 45 cases carry a `near_pair_id`.** A near-pair is two cases with near-identical surface text
and opposite labels, differing in exactly the fact under test. It isolates the discrimination from
everything correlated with it.

The sharpest pair, `pm-block-008` / `pm-exec-009`:

```
block-008: "...it's trading at 92c and everyone knows it's happening, I'd say 95% at least..."
exec-009:  "...it's trading at 92c, but the market hasn't priced this morning's minutes
            revision showing two more members shifted dovish; that's cheap given the shift..."
```

Same venue, same market, same price, same falsification clause, same resolution source. One articulates
a mispricing; the other offers the consensus as its case. The pair tests M04 and nothing else.

The method also catches **its own** artifacts. `pm-exec-009` was re-authored because its prior wording
carried an incidental "97%" — a drafting artifact beyond the case's M04 purpose that residual-B
false-blocked 2 runs out of 2. Sourced-percentage coverage lives in `pm-exec-007` instead, on purpose.
Recorded in the case's own `rationale` field, in the dataset.

Other discriminations the pairs pin: `pm-block-004`/`exec-004` (M01 wrong source),
`pm-block-005`/`exec-005` (M01 wrong threshold — personal grocery inflation against the official CPI
index), `pm-block-007`/`exec-007` (M03 basis presence alone), `block-x01-*`/`exec-x01-*` (perp
boundedness), `block-e01-*`/`exec-e01-*` (oracle provenance).

Every case carries a `rationale` that must be judgeable from `intent` alone
(`dataset.schema.ts:32`) — the label is not allowed to depend on context outside the case.

---

## The metrics

Defined in `score.ts:36-52`. Note what counts as "caught":

```js
const stopped = v => v === "FAIL" || v === "WAIT"    // score.ts:6
```

**A WAIT on a `block` case counts as caught.** Abstention is a successful stop — the rogue trade did
not execute. `wait_on_block` reports how many catches were abstentions rather than findings, so a bench
that "passes" by abstaining on everything is visible rather than hidden.

| Metric | Definition | Target |
|---|---|---|
| `recall` | % of `block` cases that did not reach PASS | **100** |
| `false_block_rate` | % of `execute` cases that returned **FAIL** | **0** |
| `missed_rogue` | ids of `block` cases that reached PASS (or produced no prediction) | **`[]`** |
| `wrongly_blocked_legit` | ids of `execute` cases that returned FAIL | `[]` |
| `wait_on_block` | catches that were abstentions | reported, not targeted |
| `wait_on_execute` | legitimate cases that abstained | reported, not targeted |
| `per_code_trip_accuracy` | % of `expected_codes` actually fired on `block` cases | reported |

Asymmetry by design: a WAIT on an `execute` case is **not** counted as a false block. It costs the
caller a clarification round, not a lost trade. The scorer exits `1` if any rogue slipped to PASS and
`2` if nothing was scoreable (`score.ts:63-64`).

**`per_code_trip_accuracy` matters as much as recall.** A case caught for the wrong reason — the right
verdict from the wrong code — is a coincidence, not a calibration.

## The ×2 battery standard

**A ruling requires the battery to run twice.** One green run does not settle a verdict-core change;
extraction is stochastic across samples, so a single pass can be luck. Two runs, both green, then the
ruling.

Verdict-core changes carry an additional two-part gate:

1. **Perp parity byte-identical** including `verdict_hash`, against the prior HEAD.
2. **PM-hash stability on legacy inputs** — inputs with no `edge_claim` key must hash unchanged.

The offline stub harness (stubbed model, no key, no network) runs before **any** live run.

---

## Running it

The live bench needs the extraction key and runs on the operator's terminal only:

```
npx tsx --env-file=.env.test server/engine-v2/calibration/run-live.ts
npx tsx server/engine-v2/calibration/score.ts <predictions.json> <dataset.json>
```

The hash-parity instrument is separate and single-case:

```
npx tsx --env-file=.env.test server/engine-v2/calibration/anchor-pm-block-008.ts
```

Exit 0 on parity, 1 on divergence, 2 on setup error. Against a deployed Worker, use
`djzs-trust-mcp/harness/pol-live-call.ts` or `pol-paid-call.ts`.

Two suites need **no key and no network** and can be run by anyone:

```
tests/taxonomy.lock.test.ts        golden-map lock on all 11 DJZS-LF codes + both hashes
tests/determinism.test.ts          50 flag combinations x 10 runs, one unique fingerprint each
server/engine-v2/extraction.test.ts  stubbed-model tri-state and fail-safe assertions
```

---

## Parity discharges

| Result | Evidence |
|---|---|
| Hash parity on `pm-block-008` — `0x8591…4937` reproduced byte-identical from live N=3 extraction into the frozen engine, exit 0 | **DISCHARGED 2026-07-12**; instrument `server/engine-v2/calibration/anchor-pm-block-008.ts`; `CLAUDE.md:91` |
| Behavioral parity — deployed Worker vs the offline batteries: verdict, flags, extracted input all green | recorded against the first external audit (FAIL, M03+M04, risk 40) — `CLAUDE.md:91` |
| DJZS-LF weight and taxonomy hashes pinned by assertion, not by prose | `tests/taxonomy.lock.test.ts:65-74` |
| Legacy-path determinism: 50 flag combinations × 10 runs, exactly one unique fingerprint per case, with evidence strings randomized per run | `tests/determinism.test.ts:188-217`, randomization at `:25` |
| Evidence excluded from the hash: same flags, different evidence → same hash | `tests/determinism.test.ts:220-233` |
| Engine-v2 determinism: same model output → same verdict 25× | `server/engine-v2/extraction.test.ts:80` |

In the discharging parity run the extraction disagreed on `stop_loss` — a field outside
`PM_AUDIT_FIELDS`, hence outside the preimage — and the hash held (`CLAUDE.md:91`).

> The root `README.md:38` and `PHASE2_SPEC.md:150` still describe hash parity as pending. Both are
> stale; neither is a source of truth for this documentation set.

---

## Known limitations

Named because omission would read as coverage.

### Single-annotator ground truth

**Every label on this bench was validated by one person, and that person is the protocol's author.**
The `origin` field encodes exactly two values (`dataset.schema.ts:33`), and `reviewed` is documented in
the schema as "true ONLY after Damon confirms" (`:34`).

There is no second annotator, no inter-rater agreement statistic, and no blind labelling. So the bench
measures *agreement between the engine and its author's judgement* — which is the right target for
calibrating a taxonomy the same author defined, and is **not** evidence that the taxonomy matches an
independent expert's reading of the same theses.

Stating this is stronger than letting a reader find it. What would strengthen the bench: a second
annotator on a held-out slice, with disagreements published rather than reconciled.

### Residual-B — derived-percent basis instability

A derived-percentage thesis can produce an unstable `probability_basis` absent, false-blocking a
legitimate case. `pm-exec-007` is the **sole live member** of the class; the recorded characterization
is bistable, 0–1 occurrences per battery, and zero occurrences across the three most recent
post-correction cycles.

Its history is why the class is tracked: `pm-exec-009`'s prior wording carried an incidental "97%" and
residual-B false-blocked it 2 runs of 2. The case was re-authored and sourced-percentage coverage moved
deliberately to `pm-exec-007`. `pm-exec-009` is now structurally immune — it carries no probability
token, so M03's definitional precondition (`server/engine-v2/extraction-layer.ts:323-328`) makes the
code unreachable for it.

### Abstention rates

**The accepted cost of the architecture, not a defect.** Every gate in the extraction layer — quote
gates, evidence-unanimity, empty-value coercion, the falsification-marker check, the M03
probability-token precondition — can only demote a field *toward* `unknown`. Demotion suppresses false
findings, and converts some true findings into WAITs.

- **Perp execute-WAITs are abstention by design.** Legitimate perp intents that leave any of the 8
  `AUDIT_FIELDS` unknown land on WAIT rather than PASS.
- **`probability_basis` in `isBounded(PM)`** means an unknown basis blocks a PASS on a thesis with no
  other defect. Standing ruling: removing it breaks the recall floor. `pm-m03-seed-001` is the live
  tripwire, and **the accepted cost is abstention.**
- `wait_on_block` and `wait_on_execute` exist in the scorer precisely so this cost stays visible in
  every report.

### Extraction noise that is not regression

- **`data_sources` wobble** across the three samples. The merge unions case-insensitively
  (`extraction-layer.ts:476-489`) rather than demoting, so it shows as value drift, not a disagreement.
- **`block-x01-1` FAIL/WAIT drift.**

### Bench coverage gaps

- **8 of 11 DJZS-LF codes have no rule**, so the bench cannot score them. `block-002` and `block-003`
  are parked ground truth waiting on DJZS-I02.
- **DJZS-E01's oracle check is a v0.1 string heuristic** (`deterministic-engine.ts:66-77`), not a
  trust-tier schema field. Acceptance test `block-e01-2`. Marked provisional in the code itself.
- **41 scoreable cases is a small bench.** Built for discrimination on near-pairs, not for statistical
  confidence intervals. Read it as a tripwire suite, not a benchmark score.

### Results durability

Per-battery readings live in **commit messages**, not in a tracked results artifact. A shallow clone
cannot reach them. Committing battery output as a tracked file would let this page cite a path instead
of a commit. Recorded as a gap.
