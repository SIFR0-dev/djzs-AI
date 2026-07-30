# DJZS

**Deterministic pre-execution audit for trading agents.**

An LLM reads the trade thesis and emits booleans. TypeScript decides. The verdict is
tri-state — **PASS / WAIT / FAIL** — and carries a `verdict_hash` any caller can
reproduce from the same frozen engine.

> **Audit before act.**
> **Verdict is computed, not improvised.**
> **Abstain over guess.**

The model never scores. Extraction runs N=3 and collapses to a per-field state only on
unanimity; any disagreement becomes `unknown`. The pure engine then maps that struct to a
verdict with zero model dependence, zero randomness, zero I/O — same struct, same verdict,
same hash, always (`server/engine-v2/deterministic-engine.ts:1-16`, `:215-216`).

## STATUS — 2026-07-28

- **`verify_pm_trade` is live** at `https://mcp.djzs.ai/mcp` — a Cloudflare Worker over
  streamable HTTP (`djzs-trust-mcp/src/index.ts:366-370`; canonical domain per
  `CLAUDE.md` §12).
- **PM taxonomy: 4/4** (M01–M04), frozen at `DJZS-PM-v1.0`, weights sum 100 enforced by a
  fatal integrity throw (`shared/pm-taxonomy.ts:31-64`, `:66-67`, `:76-81`). The paid tool
  is **PM-only** — a non-PM intent is refused, never silently perp-audited
  (`djzs-trust-mcp/src/verify-pm-trade.ts:76-86`).
- **Perp taxonomy: 3/11 live** — the DJZS-LF detectors that have engine rules today:
  X01 EXECUTION_UNBOUND (`deterministic-engine.ts:79`), E01 ORACLE_UNVERIFIED (`:93`),
  I01 FOMO_LOOP (`:105`). No perp serving surface ships yet; perp auditing is disclosed
  roadmap, not a live tool.
- **Price: 2.00 USDC per audit**, x402 on Base mainnet (`djzs-trust-mcp/src/index.ts:58`;
  the gate wraps the MCP server at `:95`; repriced from 0.25 on 2026-07-16, `:43`). The two
  registry tools are free — `withX402` gates only the paid tool (`:94`).
- **Refused audits are free.** An out-of-scope intent returns `in_scope: false`, surfaced
  as `isError`; the x402 middleware settles only error-free results, so a refusal takes no
  payment (`index.ts:279-289`, commit `77aae6d`).
- **Hash parity: DISCHARGED 2026-07-12** — not "pending." `anchor-pm-block-008.ts`
  reproduces the first external audit's `verdict_hash` byte-for-byte from live N=3
  extraction into the frozen engine, exit 0
  (`server/engine-v2/calibration/anchor-pm-block-008.ts`; `CLAUDE.md:91`). The repo-root
  `README.md` and `PHASE2_SPEC.md` still read "hash-parity pending" — they are stale and
  are **not** sources of truth.
- **No Bazaar listing, none pending.** The registry manifest
  (`djzs-trust-mcp/server.json` → `ai.djzs/trust-mcp`) declares no x402 Bazaar discovery
  metadata, so CDP does not index it (`CLAUDE.md` §12). Discovery runs through the MCP
  Registry and npm (`@sifr0-dev/djzs-ai`).

## Read next

- [Quickstart](quickstart.md) — connect a client and run your first audit.
- [Reference — verify_pm_trade](reference/verify-pm-trade.md) — the full request/response contract.

---

*verified-at `77aae6d` — every `file:line` in these docs resolves at this commit. Code
capabilities are cited to source; deploy and runtime facts are cited to the repo's own log
(`CLAUDE.md`) and were not re-probed live in this pass.*
