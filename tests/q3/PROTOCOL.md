# Q3 — Does the DJZS verdict carry outcome information?

**Pre-registered protocol · v1.1 · 2026-09-01**
Status: DRAFT until committed to `main`. The commit that lands this file is the pre-registration timestamp. No record may be graded before that commit. After the commit this file is append-only (§10).

---

## 0. Scope — what this study measures, precisely

Q1 proved the deterministic engine over its entire input space. Q2 measured the extraction layer at 100% verdict stability under contract DJZS-X-v1.1. Neither says whether a DJZS verdict is *worth anything* — whether reasoning that passes the gate resolves better than reasoning that fails it.

An outcome study needs an **objective resolution**. Therefore every record in this study is a narrative **bound, at post time, to an objective resolution written in settlement terms**. Two binding types are admitted and recorded:

- **`venue`** — a specific Kalshi or Polymarket market. Graded by venue settlement. Carries `price_at_audit`, so it enters the base-rate-controlled analysis.
- **`series`** — a named public price series (e.g. Coinbase BTC-USD, CF BRR) with a threshold and a date named **by the source**. Graded from the series value at the date. Has no market price, so it enters **hit-rate analyses only** and is reported separately from the base-rate-controlled metric. Pre-declared here so it is not a post-hoc inclusion.

Two origins of narrative are admitted and recorded as a covariate:

- **`scan`** — a circulating narrative the daily scan already audits (a speech, a trade thesis, an X frame), bound at post time under the rule **the source names the threshold and the date** (`venue` if a market exists for it, else `series`). Narratives whose source names no threshold are logged `unbound` and **excluded from outcome analysis**. Observed bind rate on the first governed sweep under this rule: 2 of 5.
- **`pool`** — markets selected by the volume rule in §3, audited for coverage.

The study therefore measures the verdict on **bindable narratives**. Results generalize to unbound circulating narratives only by argument, not by data; the report will say so.

DJZS's claim is unchanged: a PASS certifies well-formed reasoning at a moment, never that the narrative is true. This study asks whether well-formed reasoning *happens to* resolve better than the market's own price implies. It might not. That is a publishable result.

---

## 1. Hypotheses (fixed now)

**H1 (primary, binary).** PASS-rated narratives resolve CORRECT at a higher rate than FAIL-rated narratives.

**H2 (operational, binary).** Narratives the gate would **ALLOW** (PASS) resolve CORRECT at a higher rate than those it would **BLOCK** (WAIT ∪ FAIL). This is the question a treasury asks.

**H2-ord (pre-declared fallback, ordinal).** Realized CORRECT rate decreases monotonically with risk-score band: `0` · `15` · `25–45` · `≥55`. Tested with a rank correlation. **Runs as the primary analysis if either binary cell has fewer than 25 records at the analysis point** (§6) — historically PASS is rare (0 of 21 governed sweeps), and a binary test on an empty cell is no test.

**H3 (exploratory).** Each code (M01–M04) individually carries outcome information. Reported with intervals; no claims — the study is not powered for it.

**Null.** No difference / no monotone relation. If the null survives, that is published (§6).

---

## 2. Unit of observation

One **record** = one narrative, bound to one market, audited once. A re-audit is a new record with `supersedes` set; only **first audits** enter the primary analysis.

---

## 3. Inclusion and authoring rules (fixed now)

**Coverage pool (`origin: pool`).** Each scan day, on each venue (Kalshi, Polymarket): the top-N markets by 24h volume **that have no existing record**, N=5 per venue. Every pooled market is audited. None skipped. Deviations require `inclusion_note` and set `deviated: true` (excluded from primary).

**Scan narratives (`origin: scan`).** Every narrative the daily scan audits is offered a market binding at post time. If bound, it enters with `origin: scan`; if not bindable, it is logged `unbound` and excluded.

**Authoring — the intent is verbatim public text.** The verdict is a function of the intent, so who writes the intent decides the study. Therefore:
- `intent.thesis` is the **verbatim** dominant public case for the recorded side, with `source_url` and `source_text` retained. No paraphrase, no tightening, no thinning.
- `intent.probability_basis` and `intent.bounds` are populated **only** with text present in the source, quoted. If the source states no basis or no invalidation, the fields are omitted and the engine judges that absence — that is the point.
- The operator writes `market`, `side`, and the settlement criterion. Nothing else.
- Extraction runs on the intent alone; `price_at_audit` is **not** in the intent and is appended only after the intent is hashed and committed (§4, §8). Extraction is therefore blind to price by construction.

**Engine of record.** The scan publishes a *pre-screen* — a model applying the taxonomy by hand, labeled advisory. That is not the DJZS verdict. `engine.*` in a record is populated **only** by a local run of the DJZS engine (extraction + deterministic scoring, contract version recorded). The pre-screen's codes and score are stored separately in `prescreen.*`. Their agreement rate is reported as a side-measurement (§6) — the doctrine "LLM detects, TypeScript decides" tested against its own upstream.

---

## 4. Record schema

Two-phase. Phase A is written, hashed, and committed **before** the price is looked up. Phase B appends the price and re-hashes.

```json
{
  "id": "q3-2026-09-02-001",
  "protocol_version": "1.1",
  "posted_at": "2026-09-02T14:05:00Z",
  "origin": "scan | pool",
  "scan_ref": "DJZS DAILY SCAN // N7",
  "supersedes": null,
  "deviated": false,
  "inclusion_note": null,

  "source": { "url": "https://…", "text": "verbatim public case as found", "captured_at": "2026-09-02T14:04:00Z" },

  "binding": { "type": "venue | series", "series": null, "threshold": null, "at": null },
  "prescreen": { "codes": ["DJZS-M01","DJZS-M02"], "sigma": 60, "verdict": "FAIL", "by": "scan-model" },

  "market": {
    "venue": "kalshi",
    "ticker": "KXBTCD-26SEP0217-T76999.99",
    "title": "BTC above $77,000 at Sep 2 17:00 ET?",
    "side": "YES",
    "resolution_source": "Kalshi rules — CF Benchmarks BRR",
    "resolution_due": "2026-09-02T21:00:00Z"
  },

  "intent": { "market": "…", "side": "YES", "thesis": "<verbatim from source.text>", "probability_basis": "<only if quoted in source>", "bounds": {} },
  "intent_sha256": "0x…",
  "intent_hash": "0x…",

  "engine": {
    "verdict": "FAIL", "action": "FAIL", "risk_score": 25, "codes": ["DJZS-M03"], "unknown_fields": [],
    "verdict_hash": "0x…",
    "taxonomy": { "pm": "DJZS-PM-v1.0", "engine": "DJZS-ENGINE-V2", "extraction": "DJZS-X-v1.1" },
    "eas_uid": null, "paid": false
  },

  "criterion": {
    "correct_if": "Kalshi settles this market YES.",
    "incorrect_if": "Kalshi settles this market NO.",
    "void_if": "Market cancelled, voided, or settlement disputed past 7 days.",
    "grade_due": "2026-09-03T00:00:00Z"
  },

  "phase_a_hash": "sha256 over canonical JSON of everything above — computed and committed BEFORE price lookup",

  "price_at_audit": 0.71,
  "implied_prob_at_audit": 0.71,
  "price_captured_at": "2026-09-02T14:06:00Z",

  "record_hash": "sha256 over canonical JSON of everything above — Phase B",

  "outcome": null
}
```

Rules:
- `implied_prob_at_audit` is the price of the **audited side**. It is used directly (§6). There is no "if favored" branch. For `binding.type: series` the price fields are `null` and the record is excluded from the base-rate-controlled metric.
- `engine.*` comes from the engine run in §3; `prescreen.*` from the scan. They are never merged.
- The shadow book (directional positions taken against or with a narrative) is **not** part of a record. It tests a different hypothesis — the contrarian value of a FAIL — and belongs to the journal.
- `criterion` is written in the venue's settlement terms, never in terms of the narrative's intent.
- `phase_a_hash` and `record_hash` are both committed the same day. The day's `record_hash` values are Merkle-rooted and **anchored to Irys** (§7) — git history alone is rewritable and is not sufficient tamper-evidence. Merkle rule: distinct hashes, lowercased, sorted ascending; sha256(a‖b) per level; duplicate the last on odd counts; root 0x-prefixed. Canonical JSON: keys sorted recursively, no whitespace, `undefined` omitted. Verifiers fetching from `gateway.irys.xyz` must follow the redirect to the CDN.
- **Venue tickers are validated against the venue API in Phase A**; a ticker that does not resolve aborts the phase (learned from pilot N5, which sealed with a ticker missing its strike suffix).

Outcome block (written at or after `grade_due`, never before):

```json
"outcome": { "result": "CORRECT | INCORRECT | VOID", "settled_value": "YES", "evidence_url": "https://…", "graded_at": "…", "grader": "auto:kalshi-api | dj", "note": null }
```

Grading is against `criterion` **as written**. Ambiguity → `VOID` with a note, never reinterpretation.

---

## 5. Grading

- **Automated where the venue API settles the market**: `q3-grade` compares settlement to `criterion`, writes `outcome`, `grader: "auto:<venue>"`.
- **Manual only for residue**, with `evidence_url`, `grader: "dj"`.
- **Conflicts of interest, stated.** The operator authors bindings and grades manual residue. Mitigations: intents are verbatim public text (§3); criteria are pre-written in settlement terms; price is appended after the intent is hashed (§4); every manual grade carries evidence; 10% of manual grades are blind-regraded by a second party or a second model instance given only `criterion` and `evidence_url`.
- **VOID** records are excluded from denominators and their **rate is reported by group** — differential voiding would bias the comparison.

---

## 6. Analysis plan (fixed now)

**Sample size and power.** Stage 1 analysis runs once at **n = 100** graded, non-void, non-deviated, first-audit records. With 50/50 cells, α = 0.05, power 0.80, the minimum detectable difference in CORRECT rate is ≈ **27 percentage points** (e.g., 50% vs 77%). That is a large effect; Stage 1 can only see a strong gate. Stage 2 at **n = 200** detects ≈ 19 points. These numbers are stated so the result is read at the resolution it has.

**Minimum cell size.** Binary analyses (H1, H2) require ≥ 25 records in each cell. If a cell is smaller, the binary result is reported as "cell insufficient" and **H2-ord becomes the primary analysis** for that stage. This switch is pre-declared here; it is not a post-hoc choice.

**Interim looks.** Descriptive summaries may be published at any time, labeled *interim — not the pre-registered analysis*. **No stopping rule triggers on an interim look.**

**Primary metric (binary).** Difference in CORRECT rate, 95% Newcombe interval, for PASS vs FAIL and ALLOW vs BLOCK.

**Base-rate control (mandatory).** `market_expected = implied_prob_at_audit`. For each group report mean realized CORRECT minus mean `market_expected` — the group's edge over its own market prices. A group that beats its prices carries information the market did not hold. A group that merely sits on high-probability markets does not.

**Decision at each stage — three terminal branches and one continuation, each with its published sentence:**

| ALLOW − BLOCK interval | base-rate-controlled edge (ALLOW) | conclusion published on `/ruleset`, verbatim |
|---|---|---|
| excludes 0, positive | > 0 | *"Reasoning that passes the gate resolved better than its market prices implied (interval: …, n = …)."* |
| **excludes 0, negative** | any | *"Reasoning that passes the gate resolved WORSE than reasoning it blocked (interval: …, n = …). The verdict is anti-informative on this sample. The gate's outcome claim is withdrawn pending redesign."* **Terminal. Not extended.** |
| includes 0 | ≤ 0 | *"The verdict carries no outcome information at this sample size (interval: …, n = …)."* **Terminal at Stage 2; at Stage 1 → continue to Stage 2.** |
| includes 0 | > 0 | *Inconclusive.* Continue to Stage 2. At Stage 2, publish the interval and stop. |

When H2-ord is primary, the same table applies with the rank-correlation interval in place of the difference interval.

**Secondary (H3).** CORRECT rate for records where each code fired vs not, with intervals. Reported, never claimed.

**Side-measurement (pre-screen agreement).** Share of records where `prescreen.verdict == engine.verdict`, and where the code sets match. Reported with an interval. High agreement means the scan's public verdicts are trustworthy proxies; low agreement means the cards must say "pre-screen" louder. No decision rule attaches to it.

**`series` records.** Included in H1/H2/H2-ord hit-rate analyses; excluded from the base-rate-controlled edge (no market price exists). Both populations reported with their n.

---

## 7. Artifacts

| artifact | path | owner |
|---|---|---|
| this protocol | `tests/q3/PROTOCOL.md` | append-only after commit |
| record schema | `tests/q3/record.schema.json` | derived from §4 |
| signal book | `tests/q3/records/YYYY-MM-DD.json` | scan writes; committed daily |
| logger | `tests/q3/q3-log.ts` — Phase A record + hash; Phase B price + hash | seat |
| anchor | `tests/q3/q3-anchor.ts` — Merkle root of the day's `record_hash` values → `POST mcp.djzs.ai/q3/anchor` (authenticated; signs with the Worker's Irys key) → Irys; tx id stored in `tests/q3/anchors.json`; `--verify <date>` is the third-party path | seat · **mandatory daily** |
| schema | `tests/q3/record.schema.json` — JSON Schema for §4 | seat |
| verifier | `tests/q3/q3-verify.ts` — recomputes both hashes on every record, every day's root, and matches every anchor to its Irys item; runs in CI | seat |
| grader | `tests/q3/q3-grade.ts` | seat |
| analysis | `tests/q3/q3-analyze.ts` — §6 report; refuses the label "primary" before Stage 1 n; applies the cell-size switch automatically | seat |
| CI | `djzs-gate` job `q3-integrity` runs `q3-verify.ts` on every push; a sealed day without an anchor is a warning, a hash or anchor mismatch fails the build | seat |

Worker secrets (`DJZS_Q3_ANCHOR_KEY`, `IRYS_UPLOAD_KEY`) are set with `wrangler secret bulk <file>`, never by interactive paste — a pasted value was corrupted once by terminal escape sequences.

---

## 8. Daily workflow (operator)

1. Pull the coverage pool per §3 (top-N **new** markets by volume, per venue). Collect the scan's narratives and bind each to a market where possible. Use the venue's exact ticker (Kalshi tickers carry a strike suffix, e.g. `KXFEDDECISION-26SEP-H25`); Phase A will refuse one that does not resolve.
2. For each: capture `source.text` verbatim + URL. Build `intent` with verbatim thesis only; basis/bounds only if quoted in source.
3. Run the engine locally (no payment) → verdict, codes, hashes, contract versions.
4. Write `criterion` in settlement terms. **Do not look up the price yet.**
5. `q3-log --phase-a` → `phase_a_hash`; commit.
6. Look up `price_at_audit`; `q3-log --phase-b` → `record_hash`; commit.
7. End of day: `q3-anchor` → Irys; commit `anchors.json`.
8. `q3-grade` daily; commit.
9. Do not read the running tally as a result. It is not one until §6 says it is.

**Pilot records.** Records logged before the tooling in §7 existed, or where price was observed before the Phase A hash, or where the engine was not run at post time, are kept with `deviated: true` and an `inclusion_note`. They are the first entries in the book and are excluded from primary analysis. Day one of the study is the first scan on which steps 1–8 run as written.

**Expected pace.** Sticky pools and first-audit-only mean fewer new records per day than pool size suggests; venue churn (daily crypto and weather markets on Kalshi) is the driver. Estimate: Stage 1 read **late October to November 2026**; it moves with churn.

---

## 9. What this study cannot show

- Causation.
- Anything about unbound circulating narratives (excluded by §0).
- Effects smaller than the stated MDE at each stage.
- Anything before Stage 1 n is reached.

## 10. Handover and amendment policy

Any future session, model instance, or collaborator can execute this study from this document and §7 without further instruction. After the pre-registration commit, this file is **append-only**: changes are new versions added under *Amendments* with date and reason; earlier text is never edited. The primary analysis uses the version in force when the first record was posted.

---

## Amendments

**v1.1 — 2026-09-01 — pre-commit revision under external audit (PROTOCOL_AUDIT, djzs-mainnet-01).** v1.0 never landed on `main`; this is a replacement, not an amendment, and the audit is recorded here for the record.

Accepted: §0/§3 described different studies (fixed: market-bound narratives from two recorded origins); author-composed intents were the dominant confound (fixed: verbatim public text; two-phase price commit); base-rate formula inverted underdog records (fixed: `market_expected = implied_prob_at_audit`); no decision branch for a significant negative result (fixed: terminal branch with published sentence, not extended); no power statement (fixed: MDE ≈ 27 pts at n=100, ≈ 19 at n=200); no minimum cell size (fixed: 25, with pre-declared ordinal fallback); Irys anchoring optional (fixed: mandatory); optimistic timeline (fixed: new-market pool rule and revised estimate); VOID not reported by group (fixed).

Second pre-commit revision, same day, after the first governed sweep applied the binding rule (scan `2026-09-02_v2_governed_005`): (a) binding types `venue` / `series` added — the sweep bound a narrative to a public price series ("BTC September close below August close") that has no venue market; objective and gradable, but without a market price, so admitted for hit-rate analyses and pre-declared as excluded from base-rate control; (b) **engine of record** made explicit — the sweep's Σ scores are a pre-screen, not engine output; `prescreen.*` and `engine.*` are separate fields and their agreement is a side-measurement; (c) shadow book explicitly excluded from records; (d) pilot-record rule for day-0 entries.

Third same-day revision, after the tooling's live test: pilot records `q3-2026-09-02-N5` and `-N2` logged, sealed, and anchored (Irys `Cf87hGKm9unc642AC4CztyqBj6GiDFhLaCXqVSKrWfY4`, root `0x8a5117fa…`), verified from two independent implementations (TypeScript tooling; from-scratch Python port). First pre-screen agreement data: verdicts 2/2, code sets 1/2 (engine M03 vs pre-screen M03+M04 on N5). N5 sealed with an unresolvable venue ticker → **Phase A now validates venue tickers before hashing** (§4, §8). Grader auto-path confirmed against a finalized Kalshi market; series and unresolvable-ticker records route to manual grading with evidence.

**Refuted, with evidence:** the claim that a market-tethered inclusion rule structurally suppresses M01 and M02, collapsing FAIL to M03. Q2 (`tests/out/q2-live-2026-09-02-01-41-39.json`) contains six market-tethered intents: R1 and R2 fired **M01** 5/5 (thesis argues an adjacent proposition despite the ticker), I1–I3 fired **M02** 5/5 (no stated invalidation despite settlement existing). The codes test the *thesis's* engagement and the *intent's* invalidation, not the market's properties. The auditor's downstream concern — PASS scarcity threatening cell size — was correct on independent grounds and is addressed by the H2-ord fallback.
