# DJZS — deterministic pre-execution audit

DJZS audits the **reasoning** behind an autonomous agent's move *before* capital is committed. It
returns one of three verdicts — **PASS**, **WAIT**, **FAIL** — with the specific reasoning defects
flagged and a reproducible hash of the decision.

**Audit before act.**

The wedge is a different question from transaction security. Simulation and threat-scanning answer
*"is this transaction safe to sign?"*. DJZS answers *"should this position be taken at all?"*. A
perfectly safe transaction can still rest on a broken thesis.

**Verdict is computed, not improvised.**

---

## Architecture C

The model-bound step is quarantined away from the trusted step. The LLM reports facts; frozen code
decides.

```
free-text intent
      |
      v
EXTRACTION LAYER  -- LLM, N=3 samples of one prompt -- reports FACTS, never a verdict
  · per-field STATE unanimity across the 3 samples; any split -> unknown
  · quote gates: a claimed "absent" must quote the intent verbatim, or it demotes to unknown
  · evidence-unanimity: a critical-driving "absent" needs the SAME quote in all 3 samples
  · unparseable model output -> every fact unknown (fail-safe), never a fabricated verdict
      |                                     server/engine-v2/extraction-layer.ts:497
      v
AuditInput  -- every scored fact is TRI-STATE: present | absent | unknown
      |                                     server/engine-v2/audit-input-schema.ts:21
      v
DETERMINISTIC ENGINE  -- pure function. no model, no network, no clock, no randomness
  rules fire on affirmative knowledge only -> weighted score -> verdict
      |                                     server/engine-v2/deterministic-engine.ts:177
      v
PASS · WAIT · FAIL   +   risk_score · flags · unknown_fields · verdict_hash
```

The verdict rules are model-independent. Swap the extraction model and extraction *quality* changes —
the rules, the weights, and the hash do not. How three samples merge, and why every gate can only
demote toward `unknown`, is in [consensus extraction](concepts/consensus-extraction.md).

`absent` and `unknown` are never collapsed (`server/engine-v2/audit-input-schema.ts:7`). An *absent*
stop-loss is a finding. An *unknown* stop-loss is a question. The first can condemn; the second can
only make the engine wait.

**Abstain over guess.**

---

## STATUS

| Item | State | Evidence |
|---|---|---|
| DJZS-M (prediction market) | **COMPLETE 4/4** — all four codes implemented and firing | `shared/pm-taxonomy.ts:31`; rules `server/engine-v2/deterministic-engine.ts:124-172` |
| DJZS-M04 | **ADVISORY** — scored inside the 100-point budget, but sub-threshold at 15, so a solo M04 rides a PASS | `shared/pm-taxonomy.ts:56`, `djzs-trust-mcp/src/verify-pm-trade.ts:107` |
| DJZS-LF (perpetuals) | 11 codes frozen, **3 wired live**: X01, E01, I01 | `server/engine-v2/deterministic-engine.ts:79`, `:93`, `:105`; `RULES` at `:117` |
| Perpetuals serving surface | **NONE** — no deployed tool routes to the perp path | only `verify_pm_trade` is registered (`djzs-trust-mcp/src/index.ts:242`) |
| Abstention (WAIT) | **PM path only.** The perp certificate type cannot express it | `shared/audit-schema.ts:14` — `AuditVerdict = "PASS" \| "FAIL"` |
| `verify_pm_trade` | **DEPLOYED** at `https://mcp.djzs.ai/mcp` | route `djzs-trust-mcp/src/index.ts:354` |
| Price | **PAID — 2.00 USDC per audit**, x402 on Base mainnet, non-custodial | `VERIFY_PM_TRADE_PRICE_USD = 2.00` (`djzs-trust-mcp/src/index.ts:58`); gate `withX402(...)` (`:95`) |
| Facilitator | **CDP**, not x402.org — the public facilitator settles testnet only | A10 ruling `djzs-trust-mcp/src/index.ts:24-28`; wired at `:98` |
| ProofOfLogic certificate write | **LIVE** — Irys mainnet, fail-open | `djzs-trust-mcp/src/index.ts:283-311`; `IRYS_NODE_URL` in `djzs-trust-mcp/wrangler.toml` |
| On-chain trust score | **LIVE** — optional `agent_address` writes `updateScore` on Base, fail-open | `djzs-trust-mcp/src/trust-writer.ts:84-110` |
| `query_agent_trust` | **LIVE but config-gated** — real subgraph query; absent `SUBGRAPH_URL` it reports `unavailable` | `djzs-trust-mcp/src/index.ts:200`, gate `:188-189` |
| Taxonomy hashes in the response | **SHIPPING** — all four exported constants ride every audit | `djzs-trust-mcp/src/verify-pm-trade.ts:96-103` |
| Hash parity on `pm-block-008` | **DISCHARGED 2026-07-12** — byte-identical reproduction from live N=3 extraction into the frozen engine, exit 0 | instrument `server/engine-v2/calibration/anchor-pm-block-008.ts`; `CLAUDE.md:91` |

---

## Taxonomies (frozen, hash-locked)

| Taxonomy | Version | Codes | Weight sum | FAIL threshold | Live |
|---|---|---:|---:|---:|---|
| DJZS-M — prediction market | `DJZS-PM-v1.0` | 4 | 100 | 25 (`shared/pm-taxonomy.ts:74`) | 4/4 |
| DJZS-LF — perpetuals / general | `DJZS-LF-v1.1` | 11 | 200 | 50 (`server/engine-v2/deterministic-engine.ts:43`) | 3/11 |

The two never share a code namespace or a hash — stated in the PM table's own header
(`shared/pm-taxonomy.ts:1-13`). Each asserts its weight sum at module load and throws on drift
(`shared/pm-taxonomy.ts:76`, `shared/audit-schema.ts:164`).

Comparison is `>=`, and a CRITICAL flag condemns regardless of score. **A single M01 or M02 fire is
30 against a threshold of 25 — instant FAIL.** Detail: [the verdict ladder](concepts/verdict-ladder.md).

Computed at the pinned SHA:

```
DJZS-PM-v1.0   PM_WEIGHTS_HASH   0xb4102cd37df7f6bcfdc8d8468296a3bc1e59c41593effc8dbb1cb71922a1bb64
               PM_TAXONOMY_HASH  0xf7792040e4d30a3736c5b9480fccf5814e02d6392d893da2e5103a9074b7bace
DJZS-LF-v1.1   WEIGHTS_HASH      0x7faf01a7533f3a149a014ede5ba5c06188132311b7e32c59796ce285cceae826
               TAXONOMY_HASH     0x011ce858f2aa7c03482f082b60862a74434ae0489c68d030cfcae5c2490ec765
```

The two DJZS-LF values are pinned by assertion in `tests/taxonomy.lock.test.ts:66-74`, against a
golden map that locks every code's name, category, weight, and severity (`:16-32`).

Details: [DJZS-M](concepts/pm-taxonomy.md) · [DJZS-LF](concepts/perp-taxonomy.md).

---

## Tools on the deployed Worker

Three tools over streamable HTTP at `https://mcp.djzs.ai/mcp`.

| Tool | Price | What it does |
|---|---|---|
| [`verify_pm_trade`](reference/verify-pm-trade.md) | **2.00 USDC** | Pre-execution audit of a prediction-market thesis. Anchors a ProofOfLogic certificate (fail-open); optionally writes the verdict to an agent's on-chain trust record (fail-open). |
| [`query_pol_certificates`](reference/query-pol-certificates.md) | free | Reads prior ProofOfLogic certificates from the Irys mainnet index. |
| [`query_agent_trust`](reference/query-agent-trust.md) | free | Reads an agent's on-chain trust score via the DJZS subgraph. Config-gated. |

`withX402` gates only the paid tool; the two registry tools are ungated
(`djzs-trust-mcp/src/index.ts:94`). Fail-open means both side effects sit strictly downstream of the
verdict: a failure in either annotates the response and can never block, alter, or delay the audit —
nor reach the [`verdict_hash`](concepts/verdict-hash.md) preimage.

`verify_pm_trade` is **PM-only**. An intent that does not extract as a prediction-market thesis —
including the undetermined case — returns `in_scope: false` rather than silently running a
perpetuals audit (`djzs-trust-mcp/src/verify-pm-trade.ts:77`).

---

## What is not here

Stated plainly, because omission reads as a claim:

- **No perpetuals tool.** X01/E01/I01 fire inside the engine, but no deployed surface routes an intent
  to the perp path.
- **No abstention on the perp path.** `AuditVerdict` is `"PASS" | "FAIL"`
  (`shared/audit-schema.ts:14`); the type cannot express WAIT. Downstream, `DJZSEscrowLock` gates on a
  `bool passed` (`contracts/DJZSEscrowLock.sol:47`, `:97`, `:108`) — a two-valued wire.
- **No free tier on `verify_pm_trade`.** The payment gate is fail-closed.
- **No certificate NFT.** `contracts/DJZSProofOfLogicNFT.sol` is source only, not in the deployed
  manifest, not mintable.
- **The Express `/api/v2/audit` route is dev-reference only** and must never serve publicly.
- **Legacy HTTP tiers** (`/api/audit/*`) run the older pre-Architecture-C detector.

Each of these, with the ruling or blocker behind it, is in the [roadmap](roadmap.md) — where
everything is marked not yet shipped.

---

## Where to go next

- [Quickstart](quickstart.md) — connect, then read your first FAIL.
- [The verdict ladder](concepts/verdict-ladder.md) — how PASS/WAIT/FAIL are decided, line by line.
- [`verify_pm_trade` reference](reference/verify-pm-trade.md) — the ratified contract, field by field.
- [For agents](for-agents.md) — the HALT loop, the gate pattern, and payments.
- [Calibration](calibration.md) — the bench, the method, and the named limitations.

---

Source of truth is the tree. Where these docs and the code disagree, the code wins — and this page is
a bug. `README.md` and `PHASE2_SPEC.md` at the repo root are **not** sources of truth for this
documentation set; both carry claims that were true once and are stale now.

```
verified-at: feaa2b4881349a220c6f9cf403623be92eef512f
```

Every `file:line` on every page of this set resolves at that commit.
