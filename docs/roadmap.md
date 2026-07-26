# Roadmap

**Nothing on this page is shipped.** Everything shipped is in the [STATUS table](README.md#status).
This page is the other list — kept because an undisclosed gap reads as coverage.

Each item states what exists, what is missing, and what ruling is open.

---

## x402 — the payment gate ships; three things on top of it do not

The gate itself is **live**: 2.00 USDC per `verify_pm_trade` audit
(`djzs-trust-mcp/src/index.ts:58`), `withX402` at `:95`, CDP facilitator at `:98`. That part is not
roadmap. What sits unshipped on top of it:

### Bazaar / paid-route discovery — NOT SHIPPED, and not currently attainable

**DJZS has no Bazaar listing, and none is pending.** Two independent reasons, both stated because
either alone would be enough:

**1 · DJZS declares no discovery metadata.** CDP indexes a paid route on first settlement only if that
route declares Bazaar discovery metadata (x402-v2 extensions). `@x402/extensions` is **absent from both
manifests** — root `package.json` and `djzs-trust-mcp/package.json` each contain zero references — and
no discovery or bazaar declaration exists anywhere under `djzs-trust-mcp/src/`. The Worker ships
`@x402/core` and `@x402/evm` at 2.18.0 plus `@coinbase/x402` 2.1.0: the settlement path, not the
discovery layer.

**2 · The MCP side of the catalog is empty upstream.** Readings taken against the CDP discovery API on
2026-07-24:

| Query | Result |
|---|---:|
| `type=http` | **14,206** resources — the index itself is healthy |
| `type=mcp` | **0** resources, catalog-wide |
| merchant lookup, DJZS treasury | `total: 0` |

The `type=http` reading is the control. Without it the zero is indistinguishable from an unreachable
endpoint; with it, the zero is a diagnosis.

`type=mcp` returning zero across the entire catalog is not a DJZS condition. The upstream cause is
tracked at `x402-foundation/x402#2112`, **closed 2026-07-16 as completed — and the zero persists after
the close.** Recorded as the observation, not reconciled: a closed issue whose symptom survives is
either a partial fix or a different root cause, and guessing which would be inventing a fact.

So declaring the metadata would not, today, produce a listing. Both pieces of work are required —
**the upstream block is the binding one.**

### Payer-client surface — one path documented on purpose

Only the `withX402Client` recipe is documented, because it is the only path the deploy-parity gate
replays against production ([quickstart](quickstart.md#the-proven-payer-recipe)). HTTP-framed wrappers
and AgentKit are an **undocumented open seam**: they may work, they are not proven against this
endpoint, and DJZS will not claim them until they are.

### Facilitator dependency — recorded, not resolved

Mainnet payment depends on a mainnet-capable facilitator. The public `x402.org` facilitator is
**testnet-only**, which is why the CDP facilitator is in the path (A10 ruling,
`djzs-trust-mcp/src/index.ts:24-28`). The dependency is external to DJZS code and is not currently
redundant. Live probe: [`/health/x402`](reference/verify-pm-trade.md#operational-health).

---

## Irys ProofOfLogic — the write ships; two reads do not

**Shipped:** every in-scope audit anchors a certificate to Irys **mainnet**, permanent and retrievable
(`djzs-trust-mcp/src/index.ts:283-311`).

**Not shipped:**

### Certificate NFTs — source only

`contracts/DJZSProofOfLogicNFT.sol` exists as source. It is **not** in the deployed manifest and there
is no mint path. No claim is made that certificate NFTs are live or mintable.

### WAIT certificates are not queryable by verdict

`query_pol_certificates` computes `pass_count` and `fail_count` only, and its `verdict` filter offers
`"PASS"` and `"FAIL"` with no `"WAIT"` option (`index.ts:106`, `:171-172`). WAIT certificates **are**
anchored, so they appear in `total_returned` and in neither counter.

This is doctrinal, not cosmetic. WAIT is built as first-class abstention — **abstain over guess** — and
a certificate registry that cannot surface abstentions by filter makes that doctrine unauditable from
outside, which is the thing DJZS sells. A WAIT-aware filter is unbuilt.

### Deep history needs an explicit window

The mainnet index scans by timestamp and times out on wide windows. The default path auto-narrows
14d → 3d (`index.ts:126-150`); older certificates need an explicit `from_ms`, used as-is with no
fallback. A paginated or indexed history read is unbuilt.

---

## Perpetuals port — the gap is a serving tool, and a type

**8 of 11 DJZS-LF codes do not fire.** Live: X01, E01, I01. Dormant: S01, S02, S03, E02, I02, I03, X02,
T01 — defined, weighted, hash-locked, unwired.

**But the binding gap is not the dormant detectors.** No deployed tool routes an intent to the perp
path at all; `verify_pm_trade` is PM-only and refuses non-PM intents with `in_scope: false`. Lighting
up detectors changes nothing a caller can see until a perp serving tool exists.

Four known preconditions, none ruled:

1. **A `verify_perp_trade` tool.** Unbuilt, unspecified.
2. **The verdict type cannot express abstention.** `AuditVerdict` is `"PASS" | "FAIL"`
   (`shared/audit-schema.ts:14`), and `DJZSEscrowLock` gates on a `bool passed`
   (`contracts/DJZSEscrowLock.sol:47`, `:97`, `:108`). WAIT has nowhere to go on this path — either
   widen the type and the contract, or map WAIT to one of the two and say which.
3. **A contract range conflict.** `updateScore` requires `riskScore` in **0–100** or the write is
   skipped (`trust-writer.ts:88-90`). DJZS-LF sums to **200**. A perp verdict above 100 cannot be
   written to the current trust contract — resolvable by normalizing, widening, or a separate score.
4. **DJZS-E01's oracle check is a v0.1 string heuristic** (`deterministic-engine.ts:66-77`), flagged in
   the code for replacement by a schema trust-tier field. Acceptance test `block-e01-2`.

Bench-side, `block-002` and `block-003` sit parked as validated ground truth waiting on DJZS-I02
([calibration](calibration.md#the-bench)).

---

## D3 — not shipped

The next architectural phase. Not built, not specified in this tree, and no capability is claimed for
it. Listed so its absence from the STATUS table is deliberate rather than an omission.

---

## Structural debt, disclosed

Not features — known defects and accepted costs, recorded so they are not discovered.

### Worker bundles dead code

The Worker transitively bundles `server/claude-client.ts` because the extraction layer imports it for
its `defaultModel` (`server/engine-v2/extraction-layer.ts:28`, `:227`). That module reads
`process.env.ANTHROPIC_API_KEY` at module scope and once detonated as a Cloudflare `10021` error. It is
neutralized by the compatibility date, which makes `nodejs_compat` define a global `process` so the
read returns `undefined` (`djzs-trust-mcp/wrangler.toml`). **The durable fix is a server-scoped split**,
a separate task. The live path is unaffected: `verify_pm_trade` reads its key from the request-scoped
`env` binding.

### The Express `/api/v2/audit` route

Demoted to **dev-reference** and must never serve publicly — the sole-public-instance rule. The
calibrated engine reaches the public exclusively through the Worker.

### Legacy HTTP tiers

`/api/audit/micro|founder|treasury` run the pre-Architecture-C detector, not this engine. Retained for
backward compatibility. Treat their output as legacy — including their FAIL threshold, which is not the
engine's.

### Root-repo documentation drift

`README.md:38` and `PHASE2_SPEC.md:150` still describe hash parity as pending; it was discharged
2026-07-12 (`CLAUDE.md:91`). Neither file is a source of truth for this documentation set. Repo-hygiene
cleanup is a separate task and is deliberately not done here.

### Accepted, unfixable-upstream advisory

`djzs-subgraph`'s `decompress` (zip-slip) has **no patched version**, and the current `graph-cli` still
bundles it. The advisory's suggested fix is a `graph-cli` **downgrade** that would break the modern
manifest. Not applicable in practice: `decompress` only extracts our own subgraph source during build,
never an untrusted archive. **Accepted, not downgrading.**

### Abstention cost

Named in full at [calibration → known limitations](calibration.md#known-limitations).

### Single-annotator bench

Every calibration label was validated by one person, the protocol's author. No second annotator, no
inter-rater statistic. See [calibration](calibration.md#single-annotator-ground-truth).

---

## What will not change

Committed positions, listed so nobody plans around a reversal:

- **The engine stays a pure function.** No model, no network, no clock inside the verdict path.
- **`absent` and `unknown` stay distinct.** Collapsing them is what the architecture exists to prevent.
- **Weight tables stay hash-locked**, and locked by test as well as by source
  (`tests/taxonomy.lock.test.ts`). A weight change is a governance re-derive, not a patch.
- **WAIT stays a first-class verdict.** It is not a degraded PASS and will not be quietly mapped to one.
- **A rung-membership rule stays a rule:** a field joins the scored sets iff a *solo* block depends on
  it.

**Abstain over guess.**
