# MCP server

```
https://mcp.djzs.ai/mcp
```

Streamable HTTP, stateless, no sign-in. It answers MCP clients only: a browser opening the address gets `406`.
Source: `djzs-trust-mcp/src/index.ts`.

| | |
| --- | --- |
| Server | `djzs-trust-mcp` 1.0.0, title "DJZS Trade Audit" |
| Protocol versions accepted | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 (probed 2026-11-20; an unknown version negotiates to 2025-11-25) |
| Registry name | `ai.djzs/trust-mcp` in the official MCP Registry |

## Connect

```bash
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

```json
{ "mcpServers": { "djzs-trust": { "type": "http", "url": "https://mcp.djzs.ai/mcp" } } }
```

For stdio-only frameworks, the published bridge `@sifr0-dev/djzs-ai` (0.1.0) runs `mcp-remote` against the same
address (`packages/djzs-ai-shim/`):

```bash
npx -y @sifr0-dev/djzs-ai
```

## Tools

| Tool | Cost | Use it to |
| --- | --- | --- |
| `verify_pm_trade` | 2.00 USDC | Check a prediction-market bet before placing it. [Reference](../reference/verify-pm-trade.md) |
| `verify_perp_trade` | 2.00 USDC | Check a perp or spot trade before placing it. [Reference](../reference/verify-perp-trade.md) |
| `query_agent_trust` | Free | Read an agent's on-chain audit record before you delegate to it or pay it. [Reference](../reference/registry-tools.md) |
| `query_pol_certificates` | Free | Read individual audit certificates on Irys. [Reference](../reference/registry-tools.md) |

The server's own instructions tell a model to confirm with the user before a paid call, and to send the
user's own words as `intent`. An idea sent to the wrong tool is refused and not charged.

## Paying from an MCP client

The paid tools use x402 on Base mainnet: 2.00 USDC per call, exact scheme, paid to
`0xc1923748669dFC3a79497d0403A90a275161eCCA` (the address in the live payment challenge; check it there, never
from a transaction history). The tested client is `withX402Client` from `agents/x402`.

* **Raise the cap.** The client's default limit is 0.10 USDC and it refuses this price before signing anything.
  Set `maxPaymentValue: 2000000n` (2.00 USDC in 6-decimal units) or higher.
* **Fund first.** The wallet must hold at least 2.00 USDC on Base before the call: the facilitator simulates the
  transfer when it verifies, so an underfunded wallet fails with `INVALID_PAYMENT`. The facilitator pays gas.
* **Find the settlement.** Over MCP the settlement receipt is on the tool result, at
  `result._meta["x402/payment-response"]` (`success`, `transaction`, `network`, `payer`). It is not an HTTP
  header.
* **Ask first.** A `confirmationCallback` lets the agent ask a person before each payment.

Full walkthrough with code: the [Connect guide](https://djzs.ai/guide#pay).

## What a paid MCP call writes

Both writes are permanent and public. Neither can change the verdict; a failed write is reported in the result
and the verdict stands.

* **A Proof-of-Logic certificate on Irys mainnet**, for every in-scope check. The result's `pol_certificate`
  says `anchored` (with the Irys id), `disabled` or `error`. `query_pol_certificates` reads them back.
* **The agent's on-chain trust score on Base**, only when you pass `agent_address`. The result's `trust_score`
  reports the write. `query_agent_trust` reads the record. Leave `agent_address` out if you do not want a public
  record tied to that wallet.

An optional `target_system` label is written on the certificate only with `target_system_subject` and a valid
`target_system_signature` from that address; otherwise it is discarded.

The paid HTTP route writes a different record, an EAS attestation: [Receipts and certificates](../concepts/receipts.md).
