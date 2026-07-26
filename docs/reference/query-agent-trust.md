# `query_agent_trust`

Read an agent's DJZS trust score, aggregated on-chain and indexed by the DJZS subgraph.

| | |
|---|---|
| **Price** | **free** — `withX402` gates only `verify_pm_trade` (`djzs-trust-mcp/src/index.ts:94`) |
| **Registration** | `djzs-trust-mcp/src/index.ts:180-237` |
| **Status** | **Live query, config-gated.** Not a placeholder, and not unconditionally available. |
| **Contract** | `DJZSLogicTrustScore` `0xB3324D07A8713b354435FF0e2A982A504e81b137` on Base mainnet (`trust-writer.ts:29`) |

## Not a placeholder — and not unconditionally live

Both halves matter, and stating only one of them is a misrepresentation.

**It is a real query.** The handler `fetch`es `env.SUBGRAPH_URL` with a GraphQL query for `agent(id:)`
(`index.ts:200`), parses `totalAudits`, `passCount`, `failCount`, `latestVerdict`, `latestRiskScore`,
and a `flags(first: 1000)` collection (`:218-224`), and computes `failRate` and the HALT rule from
those values (`:221-225`). There is no placeholder branch left in the code.

**It is gated on configuration.** `SUBGRAPH_URL` is a Phase-3 Worker **secret**, not a plain var — the
Studio endpoint URL carries an API key (`index.ts:78`). Absent it, the tool returns, with `isError`
(`:188-189`):

```json
{ "status": "unavailable",
  "detail": "SUBGRAPH_URL not configured on this Worker; trust index not wired." }
```

It does **not** fall back to a placeholder, and it does not fabricate a neutral score. Document the
failure mode when you wire this into an agent: `unavailable` means *the index was not reachable*, which
is not the same as *this agent has no history*.

> **Stale metadata caveat.** MCP clients cache tool descriptions. A client that connected before the
> subgraph wiring may still display an older "returns placeholder" text until it reconnects. The live
> handler is subgraph-backed regardless of what your client shows.

---

## Input

| Field | Type | Required |
|---|---|:---:|
| `agentAddress` | `string`, must match `/^0x[0-9a-fA-F]{40}$/` | **yes** |

Lowercased before the query (`index.ts:191`); subgraph entity ids are lowercase.

Note the casing difference from `verify_pm_trade`, which takes `agent_address` (snake_case). This tool
takes `agentAddress` (camelCase).

---

## Output

Four shapes. Check for `status` before reading tallies.

### An agent with history

```json
{
  "agent": "0x…",
  "totalAudits": 1,
  "passCount": 0,
  "failCount": 1,
  "failRate": 1.0,
  "latestVerdict": "FAIL",
  "latestRiskScore": 40,
  "flag_counts": { "DJZS-S01": 0, "DJZS-X01": 0 },
  "action": "HALT",
  "halt_rule": "HALT if failRate > 0.3 or DJZS-S01/DJZS-X01 fired more than once",
  "halt_reason": "failRate 1.00"
}
```

`failRate` is `failCount / totalAudits`, rounded to 4 decimals (`index.ts:221`, `:229`). `halt_reason`
appears only when `action` is `HALT` (`:235`).

### No history — `status: "no_history"`

```json
{
  "agent": "0x…",
  "status": "no_history",
  "trust": "unknown",
  "action": "NO_HISTORY",
  "message": "No DJZS audit history for this agent; nothing to trust or distrust yet."
}
```

`index.ts:212-215`. **`NO_HISTORY` is not a PASS.** An unaudited agent has no basis to be trusted, and
the tool refuses to imply one. Treat it as "unknown", not "clean" — the same abstain-over-guess
discipline the engine applies to an unknown fact.

### Not wired — `status: "unavailable"`

`isError: true`. `SUBGRAPH_URL` not configured (`index.ts:188-189`).

### Query failure — `status: "error"`

`isError: true`, with `detail` naming the cause: `subgraph HTTP <code>`, GraphQL errors truncated to
200 chars, or a network exception truncated to 200 chars (`index.ts:204-210`).

---

## The HALT rule

Fixed in the handler (`index.ts:225`) and echoed back as `halt_rule`:

```
HALT if failRate > 0.3  OR  DJZS-S01 count > 1  OR  DJZS-X01 count > 1
```

Strictly greater than in all three clauses: a failRate of exactly 0.3 does not halt, and a single S01
or X01 does not halt.

### Read the flag counts honestly

`flag_counts` reports **only** `DJZS-S01` (CIRCULAR_LOGIC) and `DJZS-X01` (EXECUTION_UNBOUND)
(`index.ts:223-224`). Both are **perpetuals** codes, and DJZS-S01 is one of the eight DJZS-LF codes
that are **not wired** — see [DJZS-LF](../concepts/perp-taxonomy.md).

On today's deployment:

- The only tool that writes trust scores is `verify_pm_trade`, which is PM-only and can therefore only
  write `DJZS-M01`–`M04` codes (`index.ts:326-328`).
- **`DJZS-S01` can never be non-zero**, because no live rule fires it anywhere.
- **`DJZS-X01` can never be non-zero from `verify_pm_trade`**, because the PM path does not run the
  perp rules. A non-zero value could only come from a historical write by an earlier surface.
- The clause that actually bites today is `failRate > 0.3`.

The two flag clauses are forward-looking — they arm when a perpetuals serving tool ships. Stated here
rather than left to be discovered, because the registered description presents all three as active
criteria and other agents read that description as contract.

---

## How a record gets written

Only via `verify_pm_trade` with an `agent_address`, and only after that audit's certificate anchors
(`index.ts:319-337`, writer at `trust-writer.ts:84-110`):

```
verify_pm_trade(intent, agent_address)
   -> verdict + verdict_hash          (deterministic engine)
   -> Irys mainnet certificate        (must anchor for the write to proceed)
   -> updateScore(agent, riskScore, verdict, flags, irysTxId)   on Base mainnet
        · from a DEDICATED owner-authorized writer key, NOT the owner key
        · fail-open: any fault annotates the response, never blocks the audit
   -> The Graph indexes the event
   -> query_agent_trust reads it
```

The write is skipped rather than attempted when there is no anchored certificate to link to
(`index.ts:322-323`) — an on-chain score with no retrievable cert behind it would be an unbacked
assertion.

Contract-side constraint: `riskScore` must be an integer in **0–100** or the write is skipped
(`trust-writer.ts:88-90`). The PM taxonomy maxes at exactly 100, so PM verdicts always fit. A perp
verdict could not — DJZS-LF sums to 200. Another unruled blocker on the perp port; see
[roadmap](../roadmap.md).

Indexing is not instantaneous. A score queried immediately after a write may not appear yet.

---

## Use it before you delegate

The registered description names the intent (`index.ts:182`):

> USE BEFORE delegating work, releasing escrow, or executing agent transactions.

This is the trust loop closed: an agent's own audit history, written by the auditor, indexed publicly,
readable by anyone, with no self-report in the path.

**Audit before act.**
