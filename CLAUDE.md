# DJZS — Session Brief (Architecture C)

Repo: `github.com/SIFR0-dev/djzs-AI` (**PUBLIC** — never put secrets, key values, or
private handles in tracked files). The codebase outranks this brief; if they
disagree, the repo wins — fix the brief.

**Verify before trusting anything below:**
```
git branch --show-current    # expect: migration/codex-local-dev (canonical)
git log --oneline -1          # HEAD is the source of truth
```

## 1. Ground truth
- Canonical branch: `migration/codex-local-dev`. All engine-v2 / PM work lives here.
- `main` = legacy deploy lineage ONLY — it has **no engine-v2** and no `/api/v2/audit`.
  Do not assume `main` reflects current state.
- One task per session; re-confirm pwd/branch/HEAD at the top of each task.

## 2. Engine state (engine-v2 is canonical)
Architecture C: LLM **consensus extraction** (N=3, per-field state unanimity; any
disagreement → unknown) → **pure deterministic engine** (no LLM, no network; same
struct → same verdict + `verdict_hash`, always).
- **Perp taxonomy**: 11 codes, weights sum 200, `WEIGHTS_HASH` frozen. 3 live:
  X01 EXECUTION_UNBOUND (CRIT) · E01 ORACLE_UNVERIFIED (HIGH) · I01 FOMO_LOOP (MED).
- **PM taxonomy**: COMPLETE 4/4, `PM_WEIGHTS_HASH` frozen (sum 100, FAIL threshold 25):
  M01 NARRATIVE_RESOLUTION_GAP 30/CRIT · M02 FALSIFICATION_ABSENT 30/CRIT ·
  M03 PROBABILITY_UNSOURCED 25/HIGH · M04 CONSENSUS_NO_EDGE 15/MED.
- **M04 is ADVISORY**: solo M04 = residual PASS with the flag on the certificate;
  it blocks only by stacking (e.g. M03+M04 = 40, or alongside any CRITICAL).

## 3. Standing rulings (do not relitigate)
- `isBounded(PM)` = invalidation **AND** engagement **AND** basis (all present).
- **L3**: `probability_basis` STAYS in `isBounded(PM)` — removing it breaks the recall
  floor. `pm-m03-seed-001` is the live tripwire pinning this; accepted cost is abstention.
- **Rung-membership principle**: a field joins the scored sets (`PM_AUDIT_FIELDS` /
  `isBounded`) iff a *solo* block depends on it. `edge_claim` is in NEITHER (advisory →
  no WAIT-pressure, PM hashes stay frozen).
- **M03 definitional precondition**: an unsourced-probability absent requires an explicit
  probability token in the intent (`%`, `percent`, `odds`, `chance`, `likel`, `probabl`);
  no token → the absent drains to unknown.
- **Evidence-unanimity**: a critical-driving absent merges to absent only if all N samples
  carry strictly-identical quotes; divergence → unknown + `<field>(evidence)` telemetry.
- **Quote gates**: every PM absent needs a verbatim intent-quote or it demotes to unknown.
  Engagement additionally runs a **falsification-marker check** (a quote lifting the
  falsification clause demotes to unknown).

## 4. Calibration
- Bench: `server/engine-v2/calibration/calibration-dataset.json` — **45 cases, 41 scoreable**
  (`reviewed && scope == "coded_v0.1"`).
- ALL labels are `damon_validated` ground truth. **Never fabricate, relabel, or edit a
  case's label/intent to make it pass** — ground truth is Damon's, not the model's.
- Live run (**Damon's terminal ONLY** — needs the extraction key):
  ```
  npx tsx --env-file=.env.test server/engine-v2/calibration/run-live.ts
  npx tsx server/engine-v2/calibration/score.ts <predictions.json> <dataset.json>
  ```
- Battery **×2** is the standard for a ruling. Targets: recall 100, false_block 0, missed_rogue [].
- Known noise (not regressions): perp execute-WAITs (abstention by design), `data_sources`
  wobble across samples, `block-x01-1` FAIL/WAIT drift.
- **Residual-B**: derived-percent basis-absent instability; `pm-exec-007` is the sole live
  member; 0 occurrences across the last 3 cycles.

## 5. Working rules
- **CC never commits.** Damon signs in his own shell.
- Verdict-core changes MUST show: perp parity byte-identical incl `verdict_hash` (vs prior
  HEAD) **and** PM-hash stability on legacy inputs (no `edge_claim` key).
- Run the **offline stub harness** (stubbed model, no key) before ANY live run. (Not yet a
  tracked repo file — rebuilt in scratch each session; a candidate to commit.)
- Touch only the files a task names.

## 6. Deployment reality (as of 2026-07-04)
- The calibrated `/api/v2/audit` route serves **nowhere public**. Deploy lineage = `main`-only
  Docker (`djzs/djzs-ai:latest`, built by GH workflows on push to `main`); `main` has no
  engine-v2. The runtime env (`docker-compose.yml`) lacks `ANTHROPIC_API_KEY` — the key the
  extraction path reads — so even a branch deploy would fail extraction.
- `djzs-trust-mcp` = Cloudflare Worker, **streamable HTTP at `/mcp`**, trust-registry tools
  only (`query_pol_certificates` → Irys; `query_agent_trust` → Base placeholder). Manual
  `wrangler deploy`, no CI. Does **not** reach the audit engine.
- `verify_pm_trade` (MCP tool over the PM engine) = the next build.

## 7. Addenda — 2026-07-05
- ARCHITECTURE RULING: verify_pm_trade is WORKER-NATIVE — extraction+engine run inside djzs-trust-mcp, importing server/engine-v2 + shared/ FROZEN via build alias. The Express /api/v2/audit route is demoted to dev-reference and must never serve publicly (sole-public-instance rule).
- SCOPE RULING: PM-only — audit_context !== "prediction_market" (incl. undetermined) → in_scope:false; never a silent perp audit (perp is 3/11 live).
- ADAPTER: @hono/mcp@0.3.0 (@modelcontextprotocol/hono has no 1.x; only 2.0.0-prereleases).
- v1 CONTRACT: verdict/action/flags/unknowns/disagreements/verdict_hash + taxonomy versions. NO PoL write, NO x402 in v1 — deliberate spec omissions; re-rule both before the Worker URL becomes discoverable. Taxonomy HASHES (4 exported constants) not yet in the response — same re-rule point.
- DEPLOY PARITY GATE: replay a historically-stable bench intent (e.g. block-008) tsx-vs-live; same extracted input + verdict with different verdict_hash = bundle break, halt. Differing extraction (visible in unknowns/disagreements) = known variance, rerun.
- KNOWN ISSUE: Worker transitively bundles claude-client.ts as dead code (extraction-layer's defaultModel import). Fix = server-scoped split. Separate task.
