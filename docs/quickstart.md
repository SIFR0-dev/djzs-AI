# Quickstart

**Two transports, three invocations.** The distinction matters: there are not three independent paths
to DJZS.

| Transport | How you reach it |
|---|---|
| **Worker-native streamable HTTP** | direct HTTP MCP connection |
| **`mcp-remote` stdio bridge** | raw `mcp-remote`, or the published `@sifr0-dev/djzs-ai` shim that pins and wraps it |

Both terminate at the same deployed Worker, `https://mcp.djzs.ai/mcp`
(`djzs-trust-mcp/src/index.ts:354`, `StreamableHTTPTransport` via `@hono/mcp`).

---

## 1 · HTTP MCP — Worker-native, primary

If your client speaks streamable-HTTP MCP directly, connect with no shim. For Claude Code:

```
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

Fewest moving parts, no local process. This same one-liner is hardcoded in the shim as its
failure-mode fallback (`packages/djzs-ai-shim/bin.js:14-15`) — the two surfaces agree in source.

## 2 · The published shim — a pinned wrapper of transport 2

Some MCP hosts can only launch a **stdio** server: they spawn a local process and talk over
stdin/stdout. `@sifr0-dev/djzs-ai` exists for them.

```
npx -y @sifr0-dev/djzs-ai
```

Or as a server entry (exact shape varies by client):

```json
{
  "mcpServers": {
    "djzs-trust": {
      "command": "npx",
      "args": ["-y", "@sifr0-dev/djzs-ai"]
    }
  }
}
```

**It carries no audit logic and no transport of its own.** It spawns
`npx mcp-remote https://mcp.djzs.ai/mcp` and pipes stdio through, forwarding the child's exit code and
relaying `SIGINT`/`SIGTERM`/`SIGHUP` (`packages/djzs-ai-shim/bin.js:21-49`). Its one dependency is
`mcp-remote ^0.1.38` (`packages/djzs-ai-shim/package.json:13`).

Two operational consequences, both worth knowing before you wire it into a host:

- **`mcp-remote` resolves from npm at invocation.** `npx -y` fetches it at run time; the shim does not
  vendor it. An offline or registry-blocked host will fail to start.
- **On spawn failure the shim prints the manual one-liner and exits `1`**
  (`packages/djzs-ai-shim/bin.js:26-33`). It does not silently fall back.

Published on the public npm registry — verify rather than taking a repo path for a publish:
`https://registry.npmjs.org/@sifr0-dev/djzs-ai` → `dist-tags.latest` `0.1.0`, sole version `0.1.0`,
`bin` `{"djzs-ai":"bin.js"}`. Source is `packages/djzs-ai-shim/` in this tree. Requires Node ≥ 18
(`packages/djzs-ai-shim/package.json:33`).

## 3 · Raw `mcp-remote` — the same transport, unpinned

```
npx -y mcp-remote https://mcp.djzs.ai/mcp
```

This is literally what pattern 2 shells out to. Use it when you would rather pin `mcp-remote`
yourself; use pattern 2 when you want the version pinned for you.

---

## Before your first audit: the tool is paid

`verify_pm_trade` costs **2.00 USDC per audit** on Base mainnet over x402
(`djzs-trust-mcp/src/index.ts:58`; repriced from 0.25 on 2026-07-16, `:43`). There is no free tier and
no API key. The description agents receive says so in band: `Paid tool: 2 USDC per audit via x402.`
(`:250` — the constant interpolates, so `2.00` renders as `2`).

`withX402` wraps the server (`:95`) and gates **only** the paid tool; `query_pol_certificates` and
`query_agent_trust` are ungated (`:94`).

**Settlement depends on Worker env.** The facilitator is CDP, configured from request-scoped secrets
via `createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)` (`:98`). The public
x402.org facilitator is not used, because it settles testnet only (A10 ruling, `:24-28`). Absent
credentials, the paid tool cannot settle. `GET /health/x402` (`:370`) reports
`facilitator_configured` and whether the configured network is actually advertised.

**Payment is non-custodial** (`:29-33`). Your EIP-3009 signature moves USDC from your wallet directly
to the DJZS treasury, `0xc1923748669dFC3a79497d0403A90a275161eCCA` (`:57` — a deliberate source
constant, EIP-55 verified 2026-07-14, distinct from the operator wallet; it appears as `payTo` in
every 402 challenge, so it is public by design). The recipient is bound **inside your signature**, so
no facilitator can redirect or skim it. CDP submits the transfer and pays gas — your wallet needs
USDC only, no ETH.

### The proven payer recipe

This is the path the deploy-parity gate replays against production. Other x402 clients are
deliberately undocumented until proven against this endpoint.

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { withX402Client } from "agents/x402"
import { privateKeyToAccount } from "viem/accounts"

const client = new Client({ name: "my-agent", version: "1.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.djzs.ai/mcp")))

const paid = withX402Client(client, {
  account: privateKeyToAccount(PAYER_KEY), // wallet holding USDC on Base; gas is facilitator-paid
  network: "base",
  maxPaymentValue: 2000000n,               // 2.00 USDC atomic — REQUIRED; library default caps at 0.10
})

const res = await paid.callTool(
  async (offer) => true,                   // confirmation callback: inspect the 402 offer, return true to pay
  { name: "verify_pm_trade", arguments: { intent: "<your thesis>" } },
)
```

Two pitfalls, both hit and fixed live:

- `maxPaymentValue` **must** be raised to `2000000n`. The library default caps at 0.10 USDC and
  refuses the price before signing anything. Payers sign exact amounts, so a stale cap fails loudly —
  silent overcharge is impossible.
- The wrapped `callTool` is **callback-first**: confirmation callback first, tool call second.

Fund the payer above the price before you run. The facilitator's verify step *simulates* the transfer,
so an underfunded wallet fails as `INVALID_PAYMENT`, not as "insufficient funds".

---

## Your first audit — a FAIL, read field by field

Send a thesis with a real defect. This is `pm-block-008` from the calibration bench
(`server/engine-v2/calibration/calibration-dataset.json`):

```
Bet YES on Polymarket that the Fed cuts at the September meeting — it's trading at 92c and
everyone knows it's happening, I'd say 95% at least. The market resolves on the official FOMC
statement. I'm wrong if the August minutes turn hawkish.
```

The response, abridged to the decision fields:

```json
{
  "in_scope": true,
  "verdict": "FAIL",
  "action": "FAIL",
  "risk_score": 40,
  "flags": [
    { "code": "DJZS-M03", "name": "PROBABILITY_UNSOURCED", "severity": "HIGH",   "weight": 25,
      "evidence": "Probability or edge asserted without verifiable basis — rumor, track record, or bare conviction is not a source." },
    { "code": "DJZS-M04", "name": "CONSENSUS_NO_EDGE",     "severity": "MEDIUM", "weight": 15,
      "evidence": "The thesis's stated edge is the consensus/market position itself — no independent reason the market is mispriced." }
  ],
  "unknown_fields": [],
  "disagreements": [],
  "verdict_hash": "0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937"
}
```

### How to read it

**`verdict` and `action`.** `verdict` is the engine's word; `action` is the caller's instruction. The
map is fixed at `djzs-trust-mcp/src/verify-pm-trade.ts:89-90`:

```
PASS -> PROCEED      WAIT -> HALT      FAIL -> FAIL
```

Gate on `action`. Never re-derive it from `risk_score`.

**Why this failed, and what it got right.** The thesis *does* engage the market's own resolution
criteria ("the official FOMC statement", "the September meeting") and *does* state a falsification
("I'm wrong if the August minutes turn hawkish") — so M01 and M02 stay silent. What it lacks is a
basis for "95%": the number rests on the price plus conviction. That is M03, and at weight 25 against
a threshold of 25 **M03 alone would have condemned it**. M04 fires too, because the argued case for
the bet *is* the consensus, taking `risk_score` to 40.

**`flags`.** Full objects, not codes. The `evidence` string is the rule's own fixed statement of what
it found, read from the frozen taxonomy — not model prose, and not a quote from your intent. Any
`severity: "CRITICAL"` forces FAIL regardless of score.

**`unknown_fields`.** Empty here. When non-empty, the engine could not audit a decision-critical fact
and the verdict is WAIT. Three fields are eligible — see
[the verdict ladder](concepts/verdict-ladder.md).

**`verdict_hash`.** A sha256 over `{verdict, risk_score, sorted flag codes, unknown_fields}` and
nothing else (`server/engine-v2/deterministic-engine.ts:281-288`). No timestamp, no nonce, no intent
text. Feed the same extracted struct in again — next week, from a different client — and you get this
exact hash. Record it alongside the trade. See [verdict_hash](concepts/verdict-hash.md).

**`disagreements`.** Extraction telemetry: fields where the three samples split, demoted to unknown.
Empty here. When populated, the model could not read your thesis stably on that point.

### Then the receipts

Two more blocks arrive after the verdict, both strictly downstream of it and both fail-open:

- `pol_certificate` — the ProofOfLogic certificate anchored to Irys mainnet, retrievable at
  `https://gateway.irys.xyz/<irys_id>`.
- `trust_score` — present only if you passed `agent_address`; the on-chain write result.

Neither can touch `verdict_hash`. Full contract:
[`verify_pm_trade` reference](reference/verify-pm-trade.md).

---

**Audit before act.**
