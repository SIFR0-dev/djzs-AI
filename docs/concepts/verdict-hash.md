# verdict_hash

The claim: **the same extracted struct always yields the same verdict and the same hash.** Not
usually, not modulo caching — always, by construction.

---

## The preimage, published

```
verdict_hash = sha256Hex(canonicalize({
  verdict,          // "PASS" | "WAIT" | "FAIL"
  risk_score,       // integer sum of fired weights
  flags,            // fired CODES only, sorted — no names, no severities, no evidence
  unknown_fields,   // the scored fields that were unknown, in canonical order
}))
```

Both engine paths build it identically — perp at `server/engine-v2/deterministic-engine.ts:217-224`,
PM at `:281-288`.

Four fields. Nothing else. **Not** in the preimage:

- no timestamp, no nonce, no `audit_id`
- no intent text
- no `disagreements`, no `extraction_failsafe`
- no flag `name`, `severity`, `weight`, or `evidence` — only the sorted code strings
- no `edge_claim`, and no field outside the path's scored set
- no certificate id, no payment, no `agent_address`

`flags.map(f => f.code).sort()` is what enters, so flag ordering out of the rule loop cannot move the
hash. `unknown_fields` enters in the frozen order of `AUDIT_FIELDS` / `PM_AUDIT_FIELDS`
(`server/engine-v2/audit-input-schema.ts:70`, `:88`).

---

## Why it is stable

**`canonicalize`** (`shared/hash.ts:59-70`) sorts object keys recursively before serializing, so
property order cannot leak into the digest.

**`sha256Hex`** (`shared/hash.ts:9-56`) is a pure, dependency-free SHA-256 — no `node:crypto`, no
WebCrypto, no platform digest. Byte-identical in Node, a browser, and workerd. Returns `0x`-prefixed
lowercase hex.

**The engine is a pure function** (`server/engine-v2/deterministic-engine.ts:1-7`): zero model
dependence, zero randomness, zero I/O. No cache, no nonce, no clock (`:215-216`).

Stability is structural rather than enforced by a test — but it *is* also tested. `tests/` asserts the
property on the legacy certificate path, which shares the same `canonicalize`/sha256 construction:
`tests/determinism.test.ts:188-217` runs 50 distinct flag combinations 10× each and asserts exactly one
unique fingerprint per case, with evidence strings **deliberately randomized** per run
(`:25`). `:220-233` asserts directly that different evidence with the same flags yields the same hash.
On the engine-v2 path, `server/engine-v2/extraction.test.ts:80` asserts same model output → same
verdict 25×.

---

## What it does and does not prove

| Proves | Does not prove |
|---|---|
| The engine scored **this** verdict from **this** struct | That the extraction read your thesis correctly |
| Which frozen taxonomy tables applied (via the `taxonomy` block) | That the thesis is a good trade |
| That nobody edited the verdict after the fact | Anything about *when* the audit ran |

Two different theses that extract to the same struct produce the same hash. That is correct: the hash
commits to the **audited struct**, not the prose. The certificate closes that gap separately with
`intent_sha256` — a commitment to the exact intent text, computed *after* the verdict exists
(`djzs-trust-mcp/src/pol-certificate.ts:106`) and therefore incapable of reaching the preimage.

---

## Not the v1 trace hash

Two hashes exist in this repository and must never be conflated:

| | Algorithm | Where | Preimage |
|---|---|---|---|
| **`verdict_hash`** — engine-v2, current | sha256, `0x`-hex | `deterministic-engine.ts:217`/`:281` | verdict · risk_score · sorted codes · unknown_fields |
| `logic_hash` — v1 legacy | sha256 over a different struct | `shared/audit-schema.ts:273-289` | schema_version · a boolean map over all 11 LF codes · risk_score |

The v1 construction hashes an eleven-key boolean map and carries the schema version inside the
preimage. It belongs to the legacy detector path. Only `verdict_hash` is the engine-v2 artifact, and
only `verdict_hash` is what the PoL certificate anchors (`pol-certificate.ts:103-104` names the
distinction explicitly).

The two paths also use different FAIL thresholds — the legacy tests exercise 60
(`tests/determinism.test.ts:32`, `:181-184`), engine-v2 perp uses 50
(`deterministic-engine.ts:43`), engine-v2 PM uses 25. Do not carry a threshold across.

---

## The parity gate

Determinism is only worth as much as it is *checked*, and it is checked at the boundary that can break
it: the bundler.

`server/engine-v2/calibration/anchor-pm-block-008.ts` replays bench thesis `pm-block-008` through live
N=3 extraction into the frozen engine and asserts the hash:

```
0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937
```

Exit 0 on parity, 1 on divergence, 2 on setup error (`:6-8`). Against a deployed Worker, use
`djzs-trust-mcp/harness/pol-live-call.ts` or `pol-paid-call.ts`.

**The gate's discrimination rule.** Same extracted struct plus same verdict but a *different*
`verdict_hash` means the bundle broke — halt, roll back. **Differing extraction** — visible in
`unknowns` and `disagreements` — is known model variance: re-run, do not halt. Only one of those two
failures is a code defect.

**Status: DISCHARGED 2026-07-12** (`CLAUDE.md:91`). Byte-identical reproduction from live N=3
extraction into the frozen engine, exit 0. In that run the extraction disagreed on `stop_loss` — a
field outside `PM_AUDIT_FIELDS`, hence outside the preimage — and the hash held. That is the mechanism
working as designed.

The earlier "calibration key 401-dead, re-mint owed" note was itself stale: a working key had been
present in `.env.test` since 2026-07-08. The root `README.md` and `PHASE2_SPEC.md` still describe
parity as pending; they are not sources of truth for this set.

---

## Reproduce it yourself

Offline, no key, no network — the engine is importable and pure:

```ts
import { runDeterministicAudit } from "./server/engine-v2/deterministic-engine"

const P = (value: unknown) => ({ state: "present", value } as const)
const A = { state: "absent" } as const
const U = { state: "unknown" } as const

// The struct pm-block-008 extracts to.
const input = {
  agent_type: "trader", intended_action: "prediction-market bet",
  audit_context: "prediction_market",
  leverage: U, position_size: U, stop_loss: U, take_profit: U,
  invalidation_condition: P("the August minutes turn hawkish"),
  resolution_engagement:  P("the official FOMC statement / September meeting"),
  probability_basis: A,   // no basis for "95%"        -> M03
  edge_claim: A,          // the case IS the consensus -> M04
  data_sources: U, oracle_source: U, confidence: U,
}

runDeterministicAudit(input as never)
// verdict "FAIL" · risk_score 40 · flags [DJZS-M03, DJZS-M04] · unknown_fields []
// verdict_hash 0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937
```

Run it on any machine, any day. Same four fields of input state, same hash. That is the entire claim,
and the reason a DJZS verdict is worth recording next to a trade.
