# Architecture C Landing — Punch List

```
Branch: migration/codex-local-dev (canonical durable branch)
Remote: in sync as of 865d4cf
Status: engine-v2 built + smoke-green; NOT wired into any production route
```

---

## Canonical Name Resolution

| Token | Where | Stays? |
|-------|-------|--------|
| `WARN` | `server/engine/types.ts` (old analyst, Architecture A/B) | Yes — old engine stays, do not delete |
| `WAIT` | `server/engine-v2/` throughout | Yes — canonical Architecture C term |

Do NOT conflate them. Any new route, gate, or cert uses WAIT. The old engine's WARN is its own vocabulary.

---

## Current Production Violation (Architecture C is NOT live)

```
/api/audit/* → audit-agent.ts → DJZSEngine (server/engine/) → LLM + rule detector → binary PASS/FAIL
                                                                  ↑
                                                       WARN surfaces here (not WAIT)
                                                       PoL cert hashes THIS output
                                                       Extraction is non-deterministic
                                                       engine-v2/ imported by nothing outside its own dir
```

The deterministic engine (`engine-v2/`) is an island. Every calibration win is invisible to production. The cert anchors non-deterministic LLM output. WAIT never surfaces — under-specified theses collapse into the LLM's binary PASS/FAIL. Architecture C is violated end-to-end.

---

## Punch List (ordered — do not reorder)

### 1. New server route → engine-v2 → PASS/WAIT/FAIL

**What:** Add `POST /api/v2/audit` (or equivalent) that routes:
```
req.body.intent
  → extractAuditInput()      (server/engine-v2/extraction-layer.ts)
  → runDeterministicAudit()  (server/engine-v2/deterministic-engine.ts)
  → { verdict: "PASS" | "WAIT" | "FAIL", risk_score, flags, unknown_fields, verdict_hash }
```

**What it is NOT:** a replacement for the existing `/api/audit/*` tiers. Those stay as-is (backward compat, x402 payment gate, PoL cert on old path). This is a new parallel route behind the same payment gate, emitting the Architecture C response shape.

**WAIT mapping at this layer:**
- PASS → agent may proceed
- FAIL → agent must stop
- WAIT → agent must HALT / escalate (explicit, not silent) — surface `unknown_fields` in response so the caller knows why

**Blocked on:** `ANTHROPIC_API_KEY` in runtime env (extraction calls Claude). Nothing else.

---

### 2. Land gate.ts + retarget to /api/v2/audit + explicit WAIT branch

**What:** The gate (composeMemo / auditTrade / gate / auditAndGate, built + 10/10 green in web session) was authored targeting the wrong route (old LLM binary path). Landing it as-built does NOT fix the Architecture C violation.

Steps:
- Copy gate.ts from web session output into `server/adapters/metamask/gate.ts`
- Retarget the HTTP call from `/api/audit` → `/api/v2/audit`
- Add explicit WAIT → HALT branch (currently the gate is binary; the retarget makes WAIT reachable, so it must be handled — silence is not acceptable)
- Intended install location: `skills/djzs-audit-gate/` (repo root, for `npx skills add`) and/or `.claude/skills/djzs-audit-gate/` (local use)

**Blocked on:** Item 1 (route must exist before gate can target it).

---

### 3. Cert over deterministic core (not LLM extraction)

**What:** The PoL cert currently hashes the old LLM auditor's output — non-deterministic by construction. SHA-256 on non-deterministic output certifies the run, not the logic.

Fix: cert must hash the `EngineResult` fields that ARE deterministic:
```typescript
// already computed in runDeterministicAudit():
verdict_hash = sha256(canonicalize({ verdict, risk_score, flags: flags.map(f=>f.code).sort(), unknown_fields }))
```
`verdict_hash` is already on `EngineResult`. The cert surface should anchor to this field, not to the raw LLM response or the old engine's output.

**What this means:** same input struct → same cert hash, every time. The extraction (LLM) step produces non-deterministic text → deterministic struct → deterministic cert. The moat is at the struct boundary.

**Blocked on:** Item 1 (cert must be issued on the v2 route's output, not the old path's).

---

### 4. Extraction layer + calibration bench (dependency, not a step to defer)

**What:** Items 1–3 are mechanically landable but architecturally untrusted until extraction is calibrated.

Current state:
- `calibration-dataset.json` not yet on disk (21 cases authored, paste pending)
- `score.ts` ready; defaults to `calibration-dataset.json`; scorer gates on `reviewed: true`
- `smoke-live.ts` passing (3/3): block FAIL, exec PASS — extraction prompt fixes landed (`43a5b61`, `865d4cf`)
- Remaining calibration work: paste 21 cases → flip `reviewed: true` after manual validation → run scorer → measure recall + false-block rate → tune extraction prompt if needed

**Blocked on:** calibration-dataset.json paste (your action). Scorer run needs `ANTHROPIC_API_KEY`.

This step does not block landing Items 1–3 mechanically, but it DOES block claiming calibration confidence. Ship with that caveat explicit in the route response if landing before calibration closes.

---

### 5. Skill commit + install

**What:** Once gate.ts is retargeted (Item 2) and the route is live (Item 1):
- Commit gate.ts + any skill wrapper to `skills/djzs-audit-gate/`
- Install locally: `.claude/skills/djzs-audit-gate/`
- Verify `npx skills add` path if publishing

**Blocked on:** Items 1 and 2.

---

## Dependency Graph

```
[4 calibration]           [1 new route /api/v2/audit]
      ↓ (confidence)              ↓
      └──────────────────→ [2 gate.ts land + retarget]
                                  ↓
                           [3 cert over det. core]
                                  ↓
                           [5 skill commit + install]
```

Items 1 and 4 can proceed in parallel. Items 2, 3, 5 are sequentially gated on 1.

---

## What Requires the Extraction Key

| Item | Needs key? |
|------|-----------|
| 1 — new route (runtime) | Yes — `extractAuditInput` calls Claude |
| 2 — gate.ts (runtime) | Yes — gate calls the route |
| 3 — cert (runtime) | Yes — cert issued on live route output |
| 4 — calibration scorer | Yes — live extraction run needs key |
| 4 — dataset paste + review | No — you paste + flip `reviewed: true` offline |
| 5 — skill install | No |

---

## What Is NOT Changing

- `server/engine/` (old analyst, Architecture A/B) — stays, do not delete
- `/api/audit/*` tier routes — stays, backward compat
- `server/engine/types.ts` WARN — stays, old engine vocabulary
- `dataset.json` (forecasting harness) — separate artifact, untouched
