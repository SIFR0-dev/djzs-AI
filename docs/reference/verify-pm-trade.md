# Reference — `verify_pm_trade`

The deterministic PM-trade audit tool. Paid, PM-only, streamable HTTP at
`https://mcp.djzs.ai/mcp`. This page is the contract, field by field, cited to the
implementation at `77aae6d`: the pure pipeline in
`djzs-trust-mcp/src/verify-pm-trade.ts` and the MCP/x402 wrapper in
`djzs-trust-mcp/src/index.ts`.

> **Audit before act.** **Verdict is computed, not improvised.** **Abstain over guess.**

---

## Request

Registered as the sole paid tool via `server.paidTool(...)`
(`index.ts:242-266`). Input schema:

| field | type | required | notes |
|---|---|---|---|
| `intent` | string, ≥ 10 chars | **yes** | Free-text prediction-market trade thesis to audit (`verify-pm-trade.ts:27-32`). |
| `target_system` | string, ≤ 128 chars | no | Becomes the `Target-System` tag on the anchored PoL certificate. **Never touches the hash preimage** (`index.ts:254-257`). |
| `agent_address` | `0x` 20-byte address | no | If set, this audit's verdict is written to that agent's on-chain DJZS trust score (D1 ruling 2026-07-16), fail-open, strictly after the certificate anchors. **Never touches the hash preimage** (`index.ts:258-263`). |

## Response

Assembled from the pipeline result (`verify-pm-trade.ts:92-118`) plus the wrapper's
annotations (`index.ts:351-354`). Every field, from the actual structs:

| field | source | meaning |
|---|---|---|
| `schema_version` | `verify-pm-trade.ts:93` | `"DJZS-ENGINE-V2"`. |
| `tool` | `:94` | `"verify_pm_trade"`. |
| `in_scope` | `:95` | `true` for a PM thesis; `false` for a refusal (see below). |
| `taxonomy` | `:96-103` | Both namespaces + all published hashes: `perp` (`DJZS-LF-v1.1`), `pm` (`DJZS-PM-v1.0`), `weights_hash`, `taxonomy_hash`, `pm_weights_hash`, `pm_taxonomy_hash`. Let a caller confirm the exact frozen weights and codes the engine used. |
| `verdict` | `:104` | `PASS` / `WAIT` / `FAIL`. |
| `action` | `:105` | `PROCEED` / `HALT` / `FAIL`. |
| `risk_score` | `:106` | Summed weight of fired flags. |
| `flags` | `:107` | Full flag objects: `{ code, name, severity, weight, evidence }` (`deterministic-engine.ts:25-31`). |
| `unknown_fields` | `:108` | Scored PM fields the extraction could not resolve. |
| `disagreements` | `:109` | N=3 extraction telemetry; `"(evidence)"` variants included. |
| `verdict_hash` | `:110` | Reproducible fingerprint of the verdict-bearing content (see below). |
| `extraction_failsafe` | `:111` | `true` only when **all** N samples failsafed. |
| `halt_reason` | `:114-118` | Present only when `action === "HALT"`; names the unresolvable field(s). |
| `pol_certificate` | `index.ts:294-323, :352` | Annotation, present when `in_scope` (see below). |
| `trust_score` | `index.ts:330-349, :353` | Annotation, present only when written (see below). |

## Verdict semantics

Tri-state, computed by the frozen engine. The action map is the entirety of the ladder —
**there are no L1–L5 bands on this surface** (`verify-pm-trade.ts:89-90`):

| verdict | action | meaning |
|---|---|---|
| `PASS` | `PROCEED` | No blocking rule fired on known facts. A sub-threshold, non-critical advisory can ride a PASS (see M04 below). |
| `WAIT` | `HALT` | A decision-critical fact is unknown — first-class abstention, not a guess. The `halt_reason` names the unresolvable fields (`:114-118`). |
| `FAIL` | `FAIL` | A rule fired on facts the engine knows. |

**Weights** (`shared/pm-taxonomy.ts`): M01 30 · M02 30 · M03 25 · M04 15 — sum **100**,
enforced by a fatal integrity throw at module load (`:36,:44,:52,:60`, `:66-67`, `:76-81`).
`PM_FAIL_THRESHOLD = 25` (`:74`).

- **A single M01 or M02 fires at 30 ≥ 25 — instant FAIL.** Both are `CRITICAL`, so they
  also condemn via the `hasCritical` branch regardless of score
  (`deterministic-engine.ts:258, :271`).
- **A solo M04 (15) is sub-threshold and rides a PASS as advisory** — scored inside the
  budget, but 15 < 25 and not critical, so the flag lands on the certificate without
  blocking (`verify-pm-trade.ts:107`; `deterministic-engine.ts:159-172, :271-278`).

PM and perp never share a code namespace or a hash (`shared/pm-taxonomy.ts:7-9`).

## `in_scope: false` — refused, and not charged

A non-PM intent is never silently perp-audited. The pipeline returns
`{ in_scope: false, verdict: null, reason, ... }` (`verify-pm-trade.ts:76-86`).

As of commit `77aae6d`, the wrapper surfaces this as `isError: true` in the block that sits
**directly after** the `runVerifyPmTrade` call (`index.ts:277`, then `:284-289`). The
`agents`/x402 middleware settles payment only for results carrying no error flag — so a
refused audit is a **free** refusal; the `reason` still travels in `content`
(`index.ts:279-283`).

## `pol_certificate`

Produced only when `in_scope === true` (`index.ts:295`), strictly **after** the audit
result exists, and **fail-open**: an anchoring failure annotates the response and never
blocks or mutates the verdict (`index.ts:291-293`).

| `status` | when |
|---|---|
| `disabled` | `IRYS_UPLOAD_KEY` absent → `{ status: "disabled", detail }` (`index.ts:296-300`). |
| `anchored` | anchored via Irys → `{ status: "anchored", node, ...anchored }` (`index.ts:301-315`). |
| `error` | anchoring threw → `{ status: "error", detail }` (`index.ts:316-321`). |

## `trust_score`

Written only when **all three** hold: `in_scope === true`, an `agent_address` was given,
and a certificate actually anchored (the on-chain record links to the real cert via its
`irysTxId`) — otherwise `{ status: "skipped", reason }` (`index.ts:331-335`). Fail-open and
**downstream of `verdict_hash`**; nothing here feeds the hash preimage (`index.ts:325-329`).

## `verdict_hash`

A pure function of the verdict-bearing content, stable across runs by construction — **no
cache, no nonce, no timestamp** (`deterministic-engine.ts:215-216`). On the PM path the
preimage is exactly:

```
canonicalize({ verdict, risk_score, flags: <fired codes, sorted>, unknown_fields })
```

hashed with the engine's dependency-free SHA-256 (`deterministic-engine.ts:281-288`). Only
those four keys enter it — which is why `target_system` and `agent_address` cannot change
the hash. Reproduce it with `server/engine-v2/calibration/anchor-pm-block-008.ts`: it drives
live N=3 extraction into the frozen engine and compares against the first external audit's
recorded hash, exiting 0 on a byte-identical match (hash parity discharged 2026-07-12,
`CLAUDE.md:91`).

---

## Worked examples

Constructed from the taxonomy semantics to show each rung — **illustrative, not live
calls.** `verdict_hash` shown as `0x…`.

### 1 — Stacked FAIL

A thesis that engages no resolution criteria, states no falsification condition, and sources
its probability from rumor. M01 + M02 + M03 fire.

```json
{
  "in_scope": true, "verdict": "FAIL", "action": "FAIL", "risk_score": 85,
  "flags": [
    { "code": "DJZS-M01", "name": "NARRATIVE_RESOLUTION_GAP", "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M02", "name": "FALSIFICATION_ABSENT",     "severity": "CRITICAL", "weight": 30 },
    { "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED",    "severity": "HIGH",     "weight": 25 }
  ],
  "unknown_fields": [], "verdict_hash": "0x…"
}
```

`risk_score` 85 ≥ 25, two CRITICALs — **FAIL**.

### 2 — Clean PASS

Resolution criteria engaged, an explicit falsification condition present, and a sourced
probability basis. No rule fires; the thesis is bounded on every scored PM field.

```json
{
  "in_scope": true, "verdict": "PASS", "action": "PROCEED", "risk_score": 0,
  "flags": [], "unknown_fields": [], "verdict_hash": "0x…"
}
```

### 3 — PASS with a solo M04 advisory

Engaged, falsifiable, sourced — but the stated edge just restates the consensus/market
position. M04 alone fires (15), below the FAIL line and non-critical, so it rides a PASS as
advisory (the flag lands on the certificate; the trade is not blocked).

```json
{
  "in_scope": true, "verdict": "PASS", "action": "PROCEED", "risk_score": 15,
  "flags": [
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE", "severity": "MEDIUM", "weight": 15 }
  ],
  "unknown_fields": [], "verdict_hash": "0x…"
}
```

### 4 — WAIT with disagreements

The N=3 extraction could not agree on whether the thesis engages the market's resolution
criteria, so that field resolves to `unknown`. No rule fires on a `resolution_engagement` it
does not know — the engine abstains rather than guess.

```json
{
  "in_scope": true, "verdict": "WAIT", "action": "HALT", "risk_score": 0,
  "flags": [],
  "unknown_fields": ["resolution_engagement"],
  "disagreements": ["resolution_engagement"],
  "halt_reason": "WAIT: 1 field(s) unresolvable from intent — [resolution_engagement]. Clarify intent and re-audit.",
  "verdict_hash": "0x…"
}
```

**HALT** — do not act on an abstention. Clarify the intent and re-audit.
