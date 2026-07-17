# DJZS  Deterministic Pre-Execution Audit for Agents

DJZS audits the **reasoning** behind an autonomous agent's move *before* capital is
committed, and returns one of three verdicts  **PASS**, **WAIT**, or **FAIL** with the
specific reasoning defects flagged and a reproducible hash of the decision.

The wedge: transaction-security tools answer *"is this transaction safe to sign?"*. DJZS answers
a different question  *"should this position be taken at all?"*. A perfectly safe transaction can
still rest on broken reasoning; DJZS is the layer that catches the bad thesis.

---

## Use it now — the live MCP gate

`verify_pm_trade` is deployed as a Model Context Protocol tool (streamable HTTP) on a
Cloudflare Worker. Add it to an MCP-capable agent in one line:

```
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

Then call `verify_pm_trade` with a free-text prediction-market trade thesis. It extracts the
reasoning, audits it against the calibrated DJZS-M taxonomy, and returns
`PASS → PROCEED` / `FAIL` / `WAIT → HALT`, with the flagged defects and a `verdict_hash`.

**First external audit on record.** An outside agent audited a benchmark thesis
(`pm-block-008`) through the deployed tool and received:

```
verdict:       FAIL
flags:         DJZS-M03 (PROBABILITY_UNSOURCED), DJZS-M04 (CONSENSUS_NO_EDGE)
risk_score:    40
disagreements: []
verdict_hash:  0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937
```

Behavioral parity against the offline batteries (verdict + flags + extracted input) is green.
Hash parity is a pending re-mint — the calibration key lapsed during deployment — so the live
hash above stands as the record until it is re-run.

---

## Architecture C — extraction reports, the engine decides

DJZS separates the model-bound step from the trusted step:

```
free-text intent
      │
      ▼
EXTRACTION  (LLM, N=3 consensus)          reports observable FACTS, never a verdict
  · per-field state unanimity across the 3 samples; any disagreement → unknown
  · quote gates: a claimed "absent" must quote the intent verbatim, or it demotes to unknown
  · evidence-unanimity: a critical-driving "absent" needs the same quote across all samples
      │
      ▼
AuditInput  (each fact is tri-state: present / absent / unknown)
      │
      ▼
DETERMINISTIC ENGINE  (pure code — no model, no network, no clock)
  rules fire → weighted score → verdict
      │
      ▼
PASS · WAIT · FAIL   +   verdict_hash
```

**Why this shape:** the verdict rules are model-independent. The LLM only turns messy text into a
structured struct; the audit *rules* that decide the verdict are frozen code. Swap the model and
the extraction quality changes — the rules, weights, and hash do not.

**Determinism by construction.** The same `AuditInput` always yields the same verdict and the same
hash:

```
verdict_hash = sha256(canonicalize({ verdict, risk_score, flags: codes.sorted(), unknown_fields }))
```

**WAIT is never silent.** An under-specified thesis — one where a decision-critical fact is
`unknown` — resolves to WAIT, mapped to **HALT** for the caller, with `unknown_fields` returned so
the agent knows exactly what to clarify. Abstention is a first-class outcome, never a guessed
PASS or FAIL.

---

## Taxonomies (frozen)

### DJZS-M — Prediction Market (`DJZS-PM-v1.0`) — the calibrated, live path

Weights sum to **100**; FAIL threshold **25**. All four codes are implemented and calibrated.

| Code | Name | Severity | Weight | Detects |
|------|------|----------|-------:|---------|
| DJZS-M01 | NARRATIVE_RESOLUTION_GAP | CRITICAL | 30 | Thesis reasons about a narrative adjacent to the actual resolution question. |
| DJZS-M02 | FALSIFICATION_ABSENT | CRITICAL | 30 | No stated condition that would prove the thesis wrong before resolution. |
| DJZS-M03 | PROBABILITY_UNSOURCED | HIGH | 25 | Market or model probability asserted without verifiable basis. |
| DJZS-M04 | CONSENSUS_NO_EDGE | MEDIUM | 15 | Thesis restates consensus at an extreme price with no differentiated edge. |

**M04 is advisory-grade.** On its own it does not block — a lone M04 rides a PASS with the flag on
the certificate (weight 15 is below the FAIL threshold). It contributes to a block only by stacking
with another finding (e.g. M03 + M04 = 40 → FAIL, as in the first audit above).

`verify_pm_trade` is **PM-only**: if the intent does not extract as a prediction-market thesis
(including the undetermined case), it returns `in_scope: false` rather than silently running a
perpetuals audit.

### DJZS-LF — Perpetuals / general reasoning (`DJZS-LF-v1.1`)

Weights sum to **200**. The taxonomy is frozen at **11 codes**; **3 are wired live** in the engine
today (marked ●). The rest are defined and weighted but not yet firing — coverage is stated
honestly rather than implied.

| Code | Name | Category | Severity | Weight | Live |
|------|------|----------|----------|-------:|:----:|
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

Both weight tables are hash-locked (`WEIGHTS_HASH` / `TAXONOMY_HASH`, and the PM equivalents, are
exported constants); changing a weight is a deliberate re-derive, not a hot patch.

---

## MCP tools

The deployed Worker exposes three tools over streamable HTTP at `/mcp`:

| Tool | What it does |
|------|--------------|
| `verify_pm_trade` | Pre-execution audit of a prediction-market thesis (the gate described above). |
| `query_pol_certificates` | Read prior ProofOfLogic certificates from the Irys datachain. |
| `query_agent_trust` | LIVE on-chain trust score (subgraph-indexed): totalAudits, failRate, latest verdict, action PROCEED/HALT/NO_HISTORY. |

---

## Honest v1 posture

What the tool does **not** do yet — recorded deliberately, to be re-ruled before the gate is
broadly promoted:

- **No ProofOfLogic write on the tool.** `verify_pm_trade` returns a `verdict_hash` but does not yet
  anchor a certificate. Existing Irys certificates are prior-architecture lineage, not output of
  this tool.
- **No payment gate on the tool.** The MCP tool is not metered; the older paid HTTP tiers are a
  separate surface.
- **Taxonomy hashes not in the response.** The four hash constants are exported from the frozen
  tables but are not yet included in the tool's JSON response.

The response contract today is: `verdict`, `action`, `risk_score`, `flags`, `unknown_fields`,
`disagreements` (the per-field sample-agreement telemetry), `verdict_hash`, `extraction_failsafe`,
`in_scope`, and taxonomy versions.

---

## Legacy HTTP API (backward-compatible)

Before the MCP gate, DJZS ran as a paid HTTP audit service. Those endpoints remain for
backward compatibility — the MCP gate above is the current surface. The tiers are metered in
USDC on Base Mainnet via an `x-payment-proof` header:

| Tier | Endpoint | Price | Memo limit |
|------|----------|------:|-----------|
| Micro | `POST /api/audit/micro` | $0.10 | 2,000 chars |
| Founder | `POST /api/audit/founder` | $1.00 | 5,000 chars |
| Treasury | `POST /api/audit/treasury` | $10.00 | unlimited |

`POST /api/audit` aliases the Micro tier, and an escrow-settled variant (`POST /api/audit/escrow`)
takes on-chain escrow in place of a payment header. These tiers run the older detection path, not
the Architecture C engine — treat their output as legacy.

---

## On-chain artifacts

The A2A manifest (`agent.json`) attests four DJZS contracts on Base Mainnet, each marked
`verified`. Source for each lives in `contracts/`:

| Contract | Address | Source |
|----------|---------|--------|
| DJZSLogicTrustScore | `0xB3324D07A8713b354435FF0e2A982A504e81b137` | `contracts/DJZSLogicTrustScore.sol` |
| DJZSEscrowLock | `0xB041760147a60F63Ca701da9e431412bCc25Cfb7` | `contracts/DJZSEscrowLock.sol` |
| DJZSAgentRegistry | `0xe40d5669Ce8e06A91188B82Ce7292175E2013E41` | `contracts/DJZSAgentRegistry.sol` |
| DJZSStaking | `0xA362947D23D52C05a431E378F30C8A962De91e8A` | `contracts/DJZSStaking.sol` |

Addresses are as recorded in `agent.json`; verify any of them on BaseScan.

A fifth contract, `contracts/DJZSProofOfLogicNFT.sol`, exists as source only — it is not in the
deployed manifest, and this document makes no claim that certificate NFTs are live or mintable.

Prior ProofOfLogic certificates live on the Irys datachain and are readable via the
`query_pol_certificates` MCP tool. They are prior-architecture lineage, not output of
`verify_pm_trade`.

---

## Read the log

The commit history is the product's own audit trail: each verdict-bearing change ships with a
`PENDING` note naming what is still unproven, and the next commit that closes it discharges that
note explicitly. Every claim — a recall number, a parity result, a live verdict hash — is cited to
a specific run at the moment it is pushed, not asserted after the fact. If you want to know what is
proven versus deferred, `git log` is the source of truth and this file is downstream of it.

---

## Repository map

- `server/engine-v2/` — Architecture C: `deterministic-engine.ts` (the frozen decider),
  `extraction-layer.ts` (N=3 consensus extraction), `audit-input-schema.ts`, `hash.ts`, and the
  `calibration/` bench + scorer.
- `shared/audit-schema.ts` — the DJZS-LF perpetuals taxonomy (source of the table above).
- `shared/pm-taxonomy.ts` — the DJZS-M prediction-market taxonomy.
- `djzs-trust-mcp/` — the Cloudflare Worker: the MCP server and the `verify_pm_trade` tool,
  importing the engine and shared taxonomies frozen via a build alias.
- `server/` (older tiers) — the prior HTTP audit path and its ProofOfLogic / settlement plumbing,
  retained for backward compatibility. Its legacy detection tier historically used a Venice-hosted
  model; the Architecture C path does not depend on it.

---

*The deterministic core runs with zero external dependencies. The extraction step is the only
model-bound component, isolated to a single swappable function.*
