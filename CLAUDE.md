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

## 8. Addenda — 2026-07-05 (evening)
- DEPLOYED: djzs-trust-mcp version 714ca880-dd53 at djzs-trust-mcp.easy-less-spoil.workers.dev — 3 tools live; 10021 resolved by f546742; module scope proven at edge (51ms startup).
- FIRST EXTERNAL AUDIT: verify_pm_trade(pm-block-008) by an outside agent → FAIL, M03+M04, risk 40, disagreements [], verdict_hash 0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937. Behavioral parity vs 3/3 tsx batteries: GREEN. Hash parity: DISCHARGED 2026-07-12 via anchor-pm-block-008.ts, byte-identical reproduction from live N=3 extraction into the frozen engine (exit 0). This run's extraction disagreed on stop_loss (record: []); the field sits outside the PM hash preimage, so the hash held. The 401-dead note was stale: a working key was present in .env.test since 2026-07-08 (file mtime), unrecorded.
- IRYS HARDENING — VALIDATED PRE-WRITE: unbounded DJZSCerts query timed out 2x; timestamp:{from,to} (ms) returned ~350ms on two independent clients. Patch = trailing-window bounds, 6 lines, next Worker pass.
- KNOWN ISSUE upgrade: claude-client dead-code = proven detonator (10021), neutralized by compat date; server-scoped split remains the durable fix.
- KEY CUSTODY: dedicated keys ruled (Worker secret / calibration .env.test); calibration key died during the console visit.

## 9. Addenda — 2026-07-12 (Step 1)
- Step 1 DISCHARGED at e95bb49 (spec A7): worker-side PoL write behind an injectable UploadFn seam; devnet default via IRYS_NODE_URL var; IRYS_UPLOAD_KEY secret; fail-open, in_scope only; optional target_system input feeds only the Target-System tag. Two devnet certs live (ids in A7); anchor gate byte-identical throughout.
- DEVNET FACTS, live-observed: small uploads accepted at zero balance (price endpoint quotes nonzero regardless); gateway.irys.xyz serves devnet items; ~60d retention makes devnet certs ephemeral by design. Deployed query side still times out unbounded; bounds patch owed (addenda-8 item stands).
- PRODUCTION: deployed Worker predates e95bb49; anchoring goes live on secret put + deploy. Deploy parity gate (addenda-7) now scripted: harness/pol-live-call.ts --url <worker>/mcp replays pm-block-008, expect 0x8591..4937 anchored.
- TERMINAL DOCTRINE (two incidents, 2026-07-12): paste blocks carry bare commands only, one command per line, each block opens with its cd (zsh default treats # tails as arguments and aborts whole lines on unquoted parens). wrangler dev ALWAYS as `npx wrangler dev --local --show-interactive-dev-session=false`: the interactive hotkey layer turned stray keystrokes into public tunnels twice while live secrets were loaded; killed, blast radius bounded (no tool path echoes env), rule ratified. Pagers are the same hazard class: a bare `git diff` opened less mid-block and swallowed the rest of the block; review commands run alone or as `git --no-pager`.
- MANIFEST POSTURE: root Dependabot banner unchanged at 155 (register item). The Worker package's own tree audits to one shipping advisory (elliptic, low, no ecosystem fix); ws and @ethersproject/providers proven OUTSIDE the bundle closure by esbuild metafile.
