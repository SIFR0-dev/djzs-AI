# `verify_pm_trade`

Deterministic pre-execution audit of a prediction-market trade thesis.

| | |
|---|---|
| **Endpoint** | `https://mcp.djzs.ai/mcp` (streamable HTTP) |
| **Price** | **2.00 USDC** per audit, x402 on Base mainnet, non-custodial |
| **Scope** | prediction markets **only** |
| **Registration** | `djzs-trust-mcp/src/index.ts:242-344` |
| **Pipeline** | `djzs-trust-mcp/src/verify-pm-trade.ts:70-121` |
| **Title** | `Verify Prediction-Market Trade Thesis (DJZS pre-execution audit)` (`index.ts:265`) |

The registered description is ASCII-only by ruling (`index.ts:245-249`): it travels inside the x402
payment resource, and the `agents` client wrapper base64-encodes that payload with bare `btoa`, which
throws on any code point above `0xFF`. A U+2192 arrow crashed every payer during rehearsal.

Agents see the price in band. The constant interpolates into the description at `:250`, and `2.00`
renders as `2`:

```
Paid tool: 2 USDC per audit via x402.
```

---

## Input

`VERIFY_PM_TRADE_INPUT` (`djzs-trust-mcp/src/verify-pm-trade.ts:27-32`) plus two optional Worker-side
fields (`index.ts:252-264`).

| Field | Type | Required | Effect |
|---|---|:---:|---|
| `intent` | `string`, min length 10 | **yes** | The free-text thesis to audit. The only input that reaches extraction. |
| `target_system` | `string`, 1–128 chars | no | Becomes the `Target-System` tag on the anchored certificate. **Nothing else.** Not extracted, not scored, never in the hash preimage. |
| `agent_address` | `string`, `/^0x[0-9a-fA-F]{40}$/` | no | Present → this verdict is written to that agent's on-chain DJZS trust score after the certificate anchors. Absent → certificate only. Never in the hash preimage. |

Both optional fields are strictly downstream of the verdict. Passing them cannot change `verdict`,
`risk_score`, `flags`, `unknown_fields`, or `verdict_hash`.

---

## Output — the ratified contract

Returned as a JSON string in `content[0].text`.

### When out of scope

`djzs-trust-mcp/src/verify-pm-trade.ts:77-86`. Four keys, and `verdict` is explicitly `null`:

```json
{
  "schema_version": "DJZS-ENGINE-V2",
  "tool": "verify_pm_trade",
  "in_scope": false,
  "reason": "PM-only tool: the intent did not extract as a prediction-market thesis. Perp auditing ships separately.",
  "verdict": null
}
```

**The scope ruling.** `audit_context !== "prediction_market"` — *including the undetermined case* —
returns `in_scope: false`. It never silently runs a perpetuals audit, because only 3 of the 11 perp
codes are wired and a 3/11 audit dressed as a full one would be a false assurance.

`audit_context` is set only when at least **2 of the 3** extraction samples vote `"prediction_market"`
(`server/engine-v2/extraction-layer.ts:519-522`), and the extraction prompt is instructed to omit the
key when unsure (`:167-172`). An intent needs a prediction-market venue, a YES/NO outcome, a resolution
date, or an event probability to qualify.

**No certificate is anchored and no trust score is written for an out-of-scope call** (`index.ts:283`,
`:319` both gate on `in_scope === true`). A cert for a non-audit would be a fabricated attestation, and
`buildPolCertificate` refuses to build one (`pol-certificate.ts:83-85`).

> An out-of-scope response is a **paid** response. The payment gate runs before the handler; scope is
> determined after extraction. You pay 2.00 USDC to be told your thesis was not a prediction-market
> thesis.

### When in scope

```json
{
  "schema_version": "DJZS-ENGINE-V2",
  "tool": "verify_pm_trade",
  "in_scope": true,
  "taxonomy": {
    "perp": "DJZS-LF-v1.1",
    "pm": "DJZS-PM-v1.0",
    "weights_hash": "0x7faf01a7533f3a149a014ede5ba5c06188132311b7e32c59796ce285cceae826",
    "taxonomy_hash": "0x011ce858f2aa7c03482f082b60862a74434ae0489c68d030cfcae5c2490ec765",
    "pm_weights_hash": "0xb4102cd37df7f6bcfdc8d8468296a3bc1e59c41593effc8dbb1cb71922a1bb64",
    "pm_taxonomy_hash": "0xf7792040e4d30a3736c5b9480fccf5814e02d6392d893da2e5103a9074b7bace"
  },
  "verdict": "FAIL",
  "action": "FAIL",
  "risk_score": 40,
  "flags": [ /* full objects */ ],
  "unknown_fields": [],
  "disagreements": [],
  "verdict_hash": "0x…",
  "extraction_failsafe": false,
  "halt_reason": "…only when action is HALT…",
  "pol_certificate": { /* … */ },
  "trust_score": { /* only when agent_address was passed */ }
}
```

Field by field, from `djzs-trust-mcp/src/verify-pm-trade.ts:92-118` and `index.ts:339-341`:

#### `schema_version` — `"DJZS-ENGINE-V2"`

Constant. Identifies the response contract, not the taxonomy version.

#### `tool` — `"verify_pm_trade"`

Constant.

#### `in_scope` — `boolean`

Check it **first**; on `false` the verdict fields do not exist.

#### `taxonomy` — object, 6 keys

The four exported hash constants plus both taxonomy version strings (`verify-pm-trade.ts:96-103`).
Record them: they let anyone prove which weight tables a historical verdict was scored against. Both
taxonomies are reported even though only the PM rules ran — the two never share a namespace or a hash
(`shared/pm-taxonomy.ts:1-13`).

**Mind the naming asymmetry.** The *unqualified* keys are the **perpetuals** table:

| Key | Table |
|---|---|
| `weights_hash`, `taxonomy_hash` | DJZS-LF — the taxonomy that did **not** score this audit |
| `pm_weights_hash`, `pm_taxonomy_hash` | DJZS-M — the taxonomy that **did** |

Read the key names, not their prominence.

#### `verdict` — `"PASS" | "WAIT" | "FAIL"`

The engine's word. See [the verdict ladder](../concepts/verdict-ladder.md).

#### `action` — `"PROCEED" | "HALT" | "FAIL"`

The caller's instruction. Fixed map, `verify-pm-trade.ts:89-90`:

```
PASS -> PROCEED      WAIT -> HALT      FAIL -> FAIL
```

**Gate on this field.** Do not re-derive it from `risk_score` or from `flags.length`.

#### `risk_score` — integer

Sum of the fired flags' weights (`deterministic-engine.ts:257`). PM range 0–100. FAIL at `>= 25`, or on
any CRITICAL regardless of score.

#### `flags` — array of full objects

Not codes — full objects, by design (`verify-pm-trade.ts:107`):

```json
{ "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED", "severity": "HIGH", "weight": 25,
  "evidence": "Probability or edge asserted without verifiable basis — rumor, track record, or bare conviction is not a source." }
```

| Key | Source |
|---|---|
| `code` | `DJZS-M01`…`M04` (PM path) |
| `name`, `severity`, `weight` | read from the frozen taxonomy at flag time (`deterministic-engine.ts:56-59`) |
| `evidence` | the rule's own fixed statement of what it found — **not** model prose, **not** a quote from your intent |

The verbatim intent quote that justified an `absent` is deliberately **not** here. It stays in the
extraction layer's retained raw output so it can never reach the hash preimage.

**`flags` can be non-empty on a PASS.** A solo DJZS-M04 rides a PASS with the flag attached
(`verify-pm-trade.ts:107`). Treating `flags.length > 0` as a block halts on advisories the engine let
through on purpose.

#### `unknown_fields` — array of field names

**The three WAIT-eligible fields**, in the frozen order of `PM_AUDIT_FIELDS`
(`audit-input-schema.ts:88`):

```
invalidation_condition · resolution_engagement · probability_basis
```

Non-empty with no rung-1 finding is what produces WAIT. This array **is** in the hash preimage.

`edge_claim` is **scored but not WAIT-eligible** — it can fire M04 yet never appears here. Deliberate,
for three stated reasons (`audit-input-schema.ts:53-58`):

> PM-only ADVISORY signal. Not in `PM_AUDIT_FIELDS`: advisory uncertainty must not create WAIT-pressure,
> and `unknown_fields` feeds the `verdict_hash` — existing PM hashes stay frozen. Not in `isBounded`:
> the L3 principle — a field joins the scored sets iff a solo block depends on it; solo M04 cannot block
> by frozen weight.

Being scored and being WAIT-eligible are two different memberships; only these three fields hold both.

#### `disagreements` — array of strings

Extraction telemetry across the three samples (`extraction-layer.ts:450-458`). Two forms:

| Entry | Meaning |
|---|---|
| `probability_basis` | **state** split — the samples disagreed present/absent/unknown |
| `probability_basis(evidence)` | **evidence** split — all three said absent, but their verbatim quotes differed |

Covers all 11 `CONSENSUS_FIELDS`, so perp-only fields can appear here on a PM audit. Those are outside
`PM_AUDIT_FIELDS`, did not affect the verdict, and are not in the preimage — the canonical case is a
`stop_loss` disagreement on an otherwise stable PM verdict (`CLAUDE.md:91`). **Not** in the hash
preimage.

#### `verdict_hash` — `0x`-prefixed sha256 hex

`sha256(canonicalize({verdict, risk_score, sorted flag codes, unknown_fields}))` and nothing else. See
[verdict_hash](../concepts/verdict-hash.md).

#### `extraction_failsafe` — `boolean`

`true` **only when all three samples** produced unparseable output and every fact fell back to
`unknown` (`extraction-layer.ts:569`). One garbled sample is absorbed by the merge. A `true` plus a
WAIT means the audit told you nothing about your thesis — re-run it.

#### `halt_reason` — string, present only when `action === "HALT"`

`verify-pm-trade.ts:114-118`:

```
WAIT: 2 field(s) unresolvable from intent — [resolution_engagement, probability_basis]. Clarify intent and re-audit.
```

#### `pol_certificate` — object, present when `in_scope: true`

The ProofOfLogic anchor (`index.ts:283-311`). **Strictly after** the verdict exists; nothing in it can
reach the preimage. **Fail-open** — a failure annotates and never blocks or mutates the verdict.

| `status` | Meaning |
|---|---|
| `"anchored"` | plus `node`, `irys_id`, `gateway_url`, `audit_id`, `verdict_hash` |
| `"disabled"` | `IRYS_UPLOAD_KEY` not configured on the Worker |
| `"error"` | anchoring threw; `detail` carries the first 300 chars |

Target is Irys **mainnet** (`IRYS_NODE_URL`, `djzs-trust-mcp/wrangler.toml`), so certs are permanent
and visible to [`query_pol_certificates`](query-pol-certificates.md). Payload shape:
`djzs-trust-mcp/src/pol-certificate.ts:92-115`.

#### `trust_score` — object, present only when `agent_address` was passed

`index.ts:319-337`, writer at `trust-writer.ts:84-110`. Written **after** the certificate anchors, so
the on-chain record links to a real cert via `irysTxId`. Fail-open; never gates the audit.

| `status` | Meaning |
|---|---|
| `"written"` | plus `tx_hash`, `contract` (`0xB3324D07A8713b354435FF0e2A982A504e81b137`) |
| `"skipped"` | no anchored cert to link to · `DJZS_WRITER_KEY` unset · address malformed · `riskScore` outside 0–100 |
| `"error"` | the write threw; `detail` carries the first 300 chars |

---

## Four worked examples

Verdicts, scores, and hashes below were produced by running `runDeterministicAudit` from this tree at
the pinned SHA on the struct each thesis extracts to. Example A reproduces the on-record production
hash byte-identical, which is what validates the other three.

### A · Stacked FAIL — M03 + M04

Bench case `pm-block-008`. The thesis the first external audit ran on (`CLAUDE.md:91`).

> Bet YES on Polymarket that the Fed cuts at the September meeting — it's trading at 92c and everyone
> knows it's happening, I'd say 95% at least. The market resolves on the official FOMC statement. I'm
> wrong if the August minutes turn hawkish.

Extracted struct: engagement **present** (the September meeting, the official FOMC statement),
invalidation **present** (the August minutes), basis **absent** ("95%" rests on the price plus
conviction), edge **absent** ("everyone knows it's happening").

```json
{
  "verdict": "FAIL",
  "action": "FAIL",
  "risk_score": 40,
  "flags": [
    { "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED", "severity": "HIGH",   "weight": 25 },
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE",     "severity": "MEDIUM", "weight": 15 }
  ],
  "unknown_fields": [],
  "verdict_hash": "0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937"
}
```

M01 and M02 stay silent — this thesis *does* engage the market's criteria and *does* state a
falsification. **M03 alone would have condemned it:** weight 25 against a threshold of 25, and the
comparison is `>=` (`deterministic-engine.ts:271`). M04 adds 15 on top of an already-failing score,
taking `risk_score` to 40. Of the four PM codes, **only M04 cannot block alone** — see
[which stacks block](../concepts/pm-taxonomy.md#which-stacks-block).

### B · Clean PASS

Bench case `pm-exec-004`.

> Bet YES on Polymarket that the SEC approves the ETH staking ETF by March 31 — the market resolves on
> the SEC's official docket, and the docket already shows the final amended S-1 with the
> accelerated-review designation that preceded every prior approval. I'm wrong if the SEC issues
> another comment letter before March.

All four PM fields **present**: it reasons from the resolution source itself, states a falsification,
sources its claim in the docket, and articulates a real edge.

```json
{
  "verdict": "PASS",
  "action": "PROCEED",
  "risk_score": 0,
  "flags": [],
  "unknown_fields": [],
  "verdict_hash": "0xbf34cdf397e99774df8219ce0f7ce021f4519c044dbe79765012160afa1f0246"
}
```

Zero flags **and** `isBounded` — rung 2 of the ladder. The "accelerated-review designation preceded
every prior approval" is a documented pattern **in the resolution source**, which M03 counts as a
verifiable basis and explicitly *not* as a forecasting track record.

### C · PASS with the M04 advisory

Bench case `pm-exec-010`. The solo-advisory signature case.

> Bet YES on Polymarket that the Fed cuts at the September meeting — it's at 92c and that consensus is
> exactly right, I see no reason the market is missing anything. The market resolves on the official
> FOMC statement. I'm wrong if the August minutes turn hawkish.

All three **scored** fields present; `edge_claim` **absent** — the argued case is that consensus is
correct. No probability token, so M03 is structurally silent by the definitional precondition.

```json
{
  "verdict": "PASS",
  "action": "PROCEED",
  "risk_score": 15,
  "flags": [
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE", "severity": "MEDIUM", "weight": 15 }
  ],
  "unknown_fields": [],
  "verdict_hash": "0x73c5c4f3f15045e5f3a9d2b2219592a9ae40bdff72f45169376b592f4484ec64"
}
```

**A PASS carrying a flag, and a scored 15.** Rung 2 is skipped (flags exist), rung 3 is skipped
(nothing unknown), so it lands on rung 4. Weight 15 < threshold 25 and severity MEDIUM, so M04 cannot
condemn alone — but its points are inside the frozen 100-point budget and do count.

> **Deterministic target vs. live face.** The result above is the engine's output on the struct this
> thesis is *meant* to extract to, and it is the pin held in the offline harness. Live extraction on
> this case has also been observed landing on **WAIT-with-flag** when a scored field wobbles. Both are
> correct at their own layer: the engine is deterministic, the extraction is not. The ratified bound is
> that this case is **never FAIL**.

### D · WAIT with disagreements

Same surface as A, but the three extraction samples split on `probability_basis` — two read the "95%"
as unsourced, one could not tell. State split → the field demotes to `unknown` and the name lands in
`disagreements`.

```json
{
  "verdict": "WAIT",
  "action": "HALT",
  "risk_score": 15,
  "flags": [
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE", "severity": "MEDIUM", "weight": 15 }
  ],
  "unknown_fields": ["probability_basis"],
  "disagreements": ["probability_basis"],
  "verdict_hash": "0x9dd51469c93f9e84a45be778887b1948de2aad2a4493140ea0b83c6c0e721ca6",
  "halt_reason": "WAIT: 1 field(s) unresolvable from intent — [probability_basis]. Clarify intent and re-audit."
}
```

Compare against A: the *same thesis shape*, one field demoted, and the verdict moves from FAIL to WAIT
with a different hash. M03 does not fire, because it fires only on `absent`, never on `unknown`. The
engine will not condemn on a fact it could not read stably — **abstain over guess**.

Note `risk_score: 15` on a WAIT: the advisory M04 still fired and still scores; it simply cannot lift
the verdict off the WAIT rung.

This is the worked instance of the [HALT loop](../for-agents.md#the-halt-loop). The field appears in
**both** `unknown_fields` and `disagreements` — the diagnostic branch meaning *the model read your
thesis unstably*. The fix is to state the basis explicitly, not to add a missing fact.

#### D′ · the same WAIT, reached by an evidence split

Same thesis, but all three samples say `absent` and quote **different** unsourced assertions. Evidence
unanimity fails (`extraction-layer.ts:534-549`) and the field demotes on that path instead:

```json
{
  "verdict": "WAIT",
  "action": "HALT",
  "risk_score": 15,
  "flags": [
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE", "severity": "MEDIUM", "weight": 15 }
  ],
  "unknown_fields": ["probability_basis"],
  "disagreements": ["probability_basis(evidence)"],
  "verdict_hash": "0x9dd51469c93f9e84a45be778887b1948de2aad2a4493140ea0b83c6c0e721ca6",
  "halt_reason": "WAIT: 1 field(s) unresolvable from intent — [probability_basis]. Clarify intent and re-audit."
}
```

**Byte-identical to D except for one string.** Both branches set the field to `UNKNOWN` before the
engine runs (`extraction-layer.ts:531` vs `:546`), so the engine receives the same struct and returns
the same verdict, score, `unknown_fields`, and `verdict_hash`. `disagreements` is not in the hash
preimage, which is why the `(evidence)` suffix moves nothing.

The difference is diagnostic, and it changes what a caller should do:

| `disagreements` entry | What it says | Fix |
|---|---|---|
| `probability_basis` | one assertion, read inconsistently | state whether a basis exists |
| `probability_basis(evidence)` | **multiple** unsourced assertions; the samples condemned different ones | source them, or drop them |

---

## Errors

| Condition | Response |
|---|---|
| Unpaid or underfunded | x402 payment-required refusal before the handler runs. An underfunded payer fails as `INVALID_PAYMENT` — the facilitator's verify simulates the transfer. |
| Facilitator not configured | The paid tool cannot settle; it errors **before** the handler. Fail-closed: no audit is served free (`index.ts:90-96`). |
| `ANTHROPIC_API_KEY` unset on the Worker | `isError: true`, `{"error": "ANTHROPIC_API_KEY secret not configured on this Worker — extraction cannot run."}` (`index.ts:267-275`) |
| `intent` shorter than 10 chars | Schema rejection: `"intent must be at least 10 characters"` |
| Model output unparseable ×3 | `extraction_failsafe: true`, every fact unknown, `verdict: "WAIT"` |
| Anchoring or score write fails | The audit still returns. `pol_certificate.status` / `trust_score.status` carry `"error"`. Fail-open. |

## Operational health

`GET https://mcp.djzs.ai/health/x402` (`index.ts:370-399`) builds the same CDP facilitator config the
paid tool uses, calls `getSupported()` — which signs a real CDP JWT, so a 200 also proves the auth path
end to end — and reports whether the configured network is actually advertised.

It answers three questions a deploy needs: is a facilitator configured at all
(`facilitator_configured`), does it settle the network this Worker is set to (`network_supported`), and
what does it actually advertise (`advertised_networks`).

`200` when the network is advertised, `502` when it is not, `503` when credentials are absent. This is
the probe that would have caught the 2026-07-13 outage — a resource server asking a facilitator for a
network it did not settle. A deploy is done when the deployed version is probed live and answers
correctly, not when the CLI prints "Deployed".
