# DJZS-LF — perpetuals / general-reasoning taxonomy

`DJZS-LF-v1.1`. Eleven codes, frozen. Weights sum to **200**. FAIL threshold **50**
(`server/engine-v2/deterministic-engine.ts:43`). **3 of 11 wired live.**

Table: `shared/audit-schema.ts:53-151`. Live rules: `server/engine-v2/deterministic-engine.ts:117`.

> **No deployed tool serves this path.** The three live detectors run inside the engine, but the only
> registered MCP tool is `verify_pm_trade`, which is PM-only and refuses non-PM intents with
> `in_scope: false` (`djzs-trust-mcp/src/verify-pm-trade.ts:77`). A caller has no way to reach these
> codes today. The gap is the missing serving tool, not the dormant detectors. See
> [roadmap](../roadmap.md).

| Code | Name | Category | Severity | Weight | Live |
|---|---|---|---|---:|:---:|
| DJZS-S01 | CIRCULAR_LOGIC | Structural | CRITICAL | 30 | |
| DJZS-S02 | LAYER_INVERSION | Structural | HIGH | 25 | |
| DJZS-S03 | DEPENDENCY_GHOST | Structural | MEDIUM | 18 | |
| DJZS-E01 | ORACLE_UNVERIFIED | Epistemic | HIGH | 25 | ● |
| DJZS-E02 | CONFIDENCE_INFLATION | Epistemic | MEDIUM | 18 | |
| DJZS-I01 | FOMO_LOOP | Incentive | MEDIUM | 16 | ● |
| DJZS-I02 | MISALIGNED_REWARD | Incentive | MEDIUM | 16 | |
| DJZS-I03 | DATA_UNVERIFIED | Incentive | MEDIUM | 16 | |
| DJZS-X01 | EXECUTION_UNBOUND | Execution | CRITICAL | 15 | ● |
| DJZS-X02 | RACE_CONDITION | Execution | HIGH | 9 | |
| DJZS-T01 | STALE_REFERENCE | Temporal | LOW | 12 | |

The `LFCode` union is exactly these 11 (`shared/audit-schema.ts:3-8`). The three live ones are
X01 (`deterministic-engine.ts:79`), E01 (`:93`), I01 (`:105`). **That is the 3/11.** The other eight
are defined, weighted, and hash-locked but do not fire — disclosed roadmap, not silent coverage.

Both invariants are asserted in `tests/`, not merely in the source:

- `tests/taxonomy.lock.test.ts:16-32` holds a golden map locking every code's name, category, weight,
  and severity; `:44-58` asserts the live table matches it code by code.
- `:40-42` pins `MAX_RISK_SCORE` to 200 as governance-locked; `:65-74` pins both hashes:

```
WEIGHTS_HASH   0x7faf01a7533f3a149a014ede5ba5c06188132311b7e32c59796ce285cceae826
TAXONOMY_HASH  0x011ce858f2aa7c03482f082b60862a74434ae0489c68d030cfcae5c2490ec765
```

Both ride every `verify_pm_trade` response alongside the PM hashes
(`djzs-trust-mcp/src/verify-pm-trade.ts:97-99`), even though the perp rules never run on that path.

---

## Abstention is live on the PM path only

`shared/audit-schema.ts:14`:

```ts
export type AuditVerdict = "PASS" | "FAIL";
```

**The type cannot express WAIT.** The engine's perp path computes a WAIT rung
(`deterministic-engine.ts:208-210`), but the certificate type this taxonomy issues against is
two-valued, so there is nowhere to put it.

The constraint continues downstream into the settlement wiring. `DJZSEscrowLock` gates on a boolean:

```
contracts/DJZSEscrowLock.sol:47    bool passed,
contracts/DJZSEscrowLock.sol:97    bool passed,
contracts/DJZSEscrowLock.sol:108   if (passed) {
```

A two-valued wire cannot carry a three-valued verdict. Any perpetuals serving tool has to resolve this
before abstention means anything on this path — either widen the type and the contract, or map WAIT to
one of the two and say which. **Neither has been ruled.**

Tri-state abstention as shipped today is a `verify_pm_trade` property, reached through the
`PASS→PROCEED · WAIT→HALT · FAIL→FAIL` action map
(`djzs-trust-mcp/src/verify-pm-trade.ts:89-90`) — not a DJZS-LF property.

---

## The three live rules

### DJZS-X01 — EXECUTION_UNBOUND (CRITICAL, 15)

**Weight 15 against a threshold of 50 — this code condemns purely on severity.** It never reaches the
FAIL line on score, so the `hasCritical` clause (`deterministic-engine.ts:202`) is the entire
mechanism. Same for S01 (30, CRITICAL) when it is wired. On the perp path the severity override is
load-bearing; on the PM path it is redundant — see
[the verdict ladder](verdict-ladder.md#hascritical-is-redundant-on-the-pm-path-and-load-bearing-on-the-perp-path).

`server/engine-v2/deterministic-engine.ts:80-91`. Fires when an active position has no halt condition
at all:

```
(leverage.present OR position_size.present)
  AND stop_loss.absent
  AND invalidation_condition.absent
```

Both exits must be affirmatively absent. Silence on either is `unknown`, and the rule does not fire.

The extraction prompt does substantial work upstream (`extraction-layer.ts:50-69`). A stated plan to
act with no exit logic is **absent**, not unknown: "no stop loss", "unhedged", "all in", "diamond
hands", "ride the momentum". An aggressive or leveraged entry with conspicuous silence on exits is
also absent. But a *vague gesture* at an exit with no level — "I'll bail if it tanks" — stays
`unknown`, asserted in `server/engine-v2/extraction.test.ts:38`.

### DJZS-E01 — ORACLE_UNVERIFIED (HIGH, 25)

`server/engine-v2/deterministic-engine.ts:94-103`:

```
data_sources.present
  AND (oracle_source.absent OR oracleIsUnverified(oracle_source))
```

`oracleIsUnverified` is a v0.1 **string heuristic** over the oracle description, stated as such in the
code (`:66-77`). Markers: `self-reported`, `frontend`, `dashboard`, `their own`, `protocol's own`,
`the team's`, `website`, `app shows`, `ui shows`. The recorded plan is to replace it with a schema
trust-tier field; acceptance test `block-e01-2`.

An `unknown` oracle does **not** fire E01. Only an affirmatively absent one, or a
present-but-self-reported one, does.

### DJZS-I01 — FOMO_LOOP (MEDIUM, 16)

`server/engine-v2/deterministic-engine.ts:106-115`. Fires when any cited data source is a social
signal. Exact-match against a fixed list (`:46`):

```
social_sentiment · social · twitter · x.com · telegram · discord · sentiment
```

### How they stack

X01 alone is FAIL on severity. E01 + I01 = 41, under 50 → not FAIL on score. E01 + I01 + X01 = 56,
FAIL twice over.

Worked from this tree — an unbounded 10x long sourced from Twitter, `oracle_source` unknown:

```
verdict: FAIL   risk_score: 31   flags: [DJZS-X01, DJZS-I01]
unknown_fields: [take_profit, oracle_source, confidence]
```

E01 does not appear: `oracle_source` is `unknown`, not `absent`. The CRITICAL X01 drives the FAIL,
which is why three open questions do not turn it into a WAIT — rung 1 precedes rung 3.

---

## The perp ladder differs from PM

- **Threshold 50**, not 25 (`:43`).
- **`isBounded` is a disjunction**: `stop_loss.present` **OR** `invalidation_condition.present`
  (`:198-200`).
- **Unknowns collected over all 8 `AUDIT_FIELDS`** (`audit-input-schema.ts:70-79`). The PM-only fields
  are deliberately excluded, which is why they could be added without moving any perp hash.

`AUDIT_FIELDS` ordering is load-bearing: it is the ordering of any WAIT report and it feeds the verdict
hash by construction. It is frozen.

---

## Known bench noise on this path

Recorded as noise, not regressions:

- **Perp execute-WAITs** — abstention by design.
- **`data_sources` wobble** across the three extraction samples; the merge unions them
  case-insensitively (`extraction-layer.ts:476-489`) rather than demoting.
- **`block-x01-1` FAIL/WAIT drift.**

See [calibration](../calibration.md).
