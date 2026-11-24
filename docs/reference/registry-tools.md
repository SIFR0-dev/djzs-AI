# query\_agent\_trust and query\_pol\_certificates

Two free, read-only MCP tools on `https://mcp.djzs.ai/mcp`. Neither costs anything or writes anything. Source:
`djzs-trust-mcp/src/index.ts`.

## query\_agent\_trust

Reads an agent's audit record before you delegate work to it, release escrow, or pay it. The record is written on
Base by paid MCP checks that passed `agent_address`, and indexed by the DJZS subgraph.

| Input | Notes |
| --- | --- |
| `agentAddress` | The agent's `0x` wallet address. |

| Output | Notes |
| --- | --- |
| `status` | `no_history`, `INSUFFICIENT_HISTORY` (under 10 scored audits: no rate is returned) or `OK`. |
| `total_audits`, `wait_count` | All recorded checks, and how many were WAIT. |
| `scored_audits`, `pass_count`, `fail_count` | PASS plus FAIL. WAIT is an abstention and is left out of both sides of the rate. |
| `fail_rate`, `fail_rate_lower_bound_95` | FAIL over scored audits, and its Wilson 95% lower bound. `null` below 10 scored audits. |
| `latest_verdict`, `latest_risk_score` | The most recent check. |
| `flag_counts` | How often S01 and X01 fired. |
| `interpretation` | How to read the numbers. |

The tool returns evidence, not a decision: it applies no threshold and emits no HALT. Its interpretation text
suggests, as a starting point only, that a lower bound above 0.3, or S01 or X01 firing more than once, is worth
refusing on. Weigh that against your own exposure.

> **Warning.** The DJZS subgraph's indexed counters count WAIT verdicts as FAIL (see
> [Disclosures](../disclosures.md#wait-is-counted-wrongly-by-the-subgraph)). The tool recomputes from per-audit
> verdicts and is correct, but anyone reading the subgraph directly gets an inflated fail rate.

## query\_pol\_certificates

Reads Proof-of-Logic certificates from Irys mainnet: the permanent record every in-scope paid MCP check anchors.

| Input | Notes |
| --- | --- |
| `targetSystem` | Only certificates whose Target-System tag equals this value, exactly. |
| `verdict` | `PASS` or `FAIL`. |
| `tier` | `micro`, `founder` or `treasury`. |
| `limit` | 1 to 100, default 20, newest first. |
| `from_ms`, `to_ms` | The search window in Unix milliseconds. Without `from_ms` the server searches the last 14 days, then the last 3 if the wider search fails; set it to reach older certificates. |

A WAIT verdict is not a filter value here; read WAIT history from `query_agent_trust`.
