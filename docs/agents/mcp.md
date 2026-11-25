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
| `check_thesis` | Free | Check a thesis with no wallet: the same PASS, WAIT or FAIL and reasons, no receipt. [How it works](free-check.md#from-an-mcp-client) |
| `get_paid_audit` | Free | Collect an audit the user paid for in the browser through a pay link. [Paying from a chat](#paying-from-a-chat-the-pay-link) |
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

The call, as the deploy check runs it against production:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { withX402Client } from "agents/x402"
import { privateKeyToAccount } from "viem/accounts"

const client = new Client({ name: "my-agent", version: "1.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.djzs.ai/mcp")))

const paid = withX402Client(client, {
  account: privateKeyToAccount(PAYER_KEY), // a wallet holding USDC on Base
  network: "base",
  maxPaymentValue: 2000000n, // 2.00 USDC; the default cap is 0.10 USDC
})

const res = await paid.callTool(
  async (offer) => true, // inspect the offer; return true to sign and pay
  { name: "verify_pm_trade", arguments: { intent: "<the bet in the user's own words>" } },
)
```

The wrapped client's `callTool` takes the confirmation callback first and the tool call second. Other x402
clients are not documented here until they have been proven against this server. To pay with MPP from a
terminal instead, see [Paid check over HTTP](paid-http.md).

## Paying from a chat: the pay link

A chat app has no wallet, so it cannot answer the x402 requirement itself. For that case, a paid tool called
with no payment returns the same x402 requirement as before (`isError`, `_meta["x402/error"]`, content[0]
unchanged, so an x402 client pays exactly as above) and also a pay link:

* `_meta["ai.djzs/pay"]`: `url` (`https://mcp.djzs.ai/pay/ps_…`), `pay_session`, `expires_at` (30 minutes),
  `price`, `network`. The same link is in a second text item, for clients that only show text.
* The page shows the exact thesis and the price. The user signs one EIP-3009 USDC authorization (2.00 USDC to the
  treasury above) in their own browser wallet.
* The server checks the authorization with the facilitator, then makes the same paid MCP call in-process with
  the payment attached. The audit, the certificate and the settlement are the paid tool's own: an out-of-scope
  thesis or a failed audit is not charged.
* The chat then calls `get_paid_audit` with the `pay_session`:

| `status` | Meaning |
| --- | --- |
| `PAID` | `audit` holds the paid tool's full result; `payment` holds the settlement (`transaction`, `network`, `payer`). |
| `PENDING` | Not paid yet. `pay_url` is the link to give the user again. |
| `PROCESSING` | The payment is settling and the audit is running. Call again shortly. |
| `REFUSED_SCOPE` | Sent to the wrong paid tool. Nothing was charged. |
| `UNCERTAIN` | The settlement could not be confirmed. Check the wallet before paying again; contact support with the `pay_session`. |
| `EXPIRED` | The link expired unpaid. Call the paid tool again for a new one. |

A link is a capability, not an identity: whoever opens it can pay for that one audit, and whoever holds the
`pay_session` can read its result. The URL carries only a random id. At most `PAY_LINK_DAILY_LIMIT` links
(default 300) are minted per UTC day; past it the paid tools answer with the x402 requirement alone. Sessions
are deleted a week after their link expires.

On MCP protocol revision 2026-07-28 the same URL is meant to arrive as a URL-mode elicitation. This server
speaks 2025-11-25 and earlier, and Claude declares URL elicitation to legacy connector servers as form-only, so
for now the link travels in the tool result.

## Skills

The server publishes one skill under the Skills over MCP extension (`io.modelcontextprotocol/skills`):
`djzs-trade-audit` at `skill://djzs-trade-audit/SKILL.md`. It tells a model which tool to use, to send the
user's own words, to ask before paying, how to use the pay link, and how to read PASS, WAIT and FAIL.

* Declared in the `initialize` result's `capabilities.extensions`, beside `resources`.
* `skills/list` and `skills/get` return the frontmatter and the manifest (URI, `sha256:` digest, byte size of
  every file); the files are read with `resources/read`.
* The source is `skills/djzs-trade-audit/` in the repo. The Worker serves a compiled copy
  (`djzs-trust-mcp/src/skills-bundle.generated.ts`) that CI checks against the files on disk, so the bytes served
  always match the digests published.

The extension is specified against revision 2026-07-28. A client that only loads server skills on that revision
will see this one once the server speaks it.

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
