# Use with OpenAI agents

An agent built with the OpenAI Agents SDK can use DJZS in two ways. Which one depends on whether the agent
holds a wallet.

| The agent | Use | Cost |
| --- | --- | --- |
| Has no wallet (a hosted agent, a prototype) | The MCP server, hosted. The free tools work as-is. | Free |
| Holds a wallet and needs a receipt | The paid HTTP route, called from the agent's own code | 2.00 USDC per receipt |

> **Status.** The snippets below follow OpenAI's published SDK examples with the DJZS address in place of
> theirs. The DJZS side is covered by the repository's tests. As of 2026-11-24 DJZS has not yet run them against
> production with an OpenAI key. Until that is done this page is not linked from the docs menu.

## 1. No wallet: attach the MCP server

The server needs no sign-in, so the SDK's hosted MCP tool can reach it directly. OpenAI's servers make the
calls. Three tools are usable this way:

| Tool | Use it to |
| --- | --- |
| `check_thesis` | Check a trade thesis: PASS, WAIT or FAIL with the reasons. No receipt. |
| `query_agent_trust` | Read another agent's on-chain audit record before delegating to it. |
| `query_pol_certificates` | Read individual audit certificates. |

**Python** (`pip install openai-agents`, `OPENAI_API_KEY` set)

```python
import asyncio

from agents import Agent, HostedMCPTool, Runner


async def main() -> None:
    agent = Agent(
        name="Trade checker",
        instructions=(
            "Before any trade, call check_thesis with the user's thesis in their own words. "
            "Report the verdict and the reasons. Do not call verify_pm_trade or verify_perp_trade: "
            "they need a payment this agent cannot make."
        ),
        tools=[
            HostedMCPTool(
                tool_config={
                    "type": "mcp",
                    "server_label": "djzs",
                    "server_url": "https://mcp.djzs.ai/mcp",
                    "require_approval": "never",
                }
            )
        ],
    )

    result = await Runner.run(
        agent,
        "Check this: Kalshi, Fed decision in December. Buying YES on no change at 96 cents. "
        "CME FedWatch put a hold at 95% on Nov 22. I am wrong if the Fed cuts.",
    )
    print(result.final_output)


asyncio.run(main())
```

**TypeScript** (`npm install @openai/agents`)

```ts
import { Agent, hostedMcpTool } from "@openai/agents";

const agent = new Agent({
  name: "Trade checker",
  instructions:
    "Before any trade, call check_thesis with the user's thesis in their own words. Report the verdict and the reasons.",
  tools: [
    hostedMcpTool({
      serverLabel: "djzs",
      serverUrl: "https://mcp.djzs.ai/mcp",
    }),
  ],
});
```

What to expect:

* `check_thesis` returns `status: "OK"` with `verdict`, `risk_score`, `flags` and `verdict_hash`, plus
  `free: true` and `attested: false`. See [Free check](free-check.md#from-an-mcp-client).
* All MCP callers share one daily allowance. When it is used up the tool returns `status: "LIMIT_REACHED"`
  with `resets_at`.
* The two paid tools are listed too. Called from a hosted agent they return a payment demand, because OpenAI's
  servers hold no wallet. The instruction above keeps the model away from them.

## 2. With a wallet: buy the receipt over HTTP

A receipt is the paid product: the verdict attested on Base, bound to the thesis and the payer, checkable by
anyone at [djzs.ai/verify](https://djzs.ai/verify). It needs a 2.00 USDC payment signed by a wallet, so the call
has to run in your own code, not on OpenAI's servers.

Wrap the paid HTTP route as one function tool in your agent and pay with a standard x402 client. The route, the
request body, the payment terms and the tested payer are in [Paid check over HTTP](paid-http.md). Nothing on the
DJZS side is specific to OpenAI.

Two rules worth keeping in the tool:

* **Take the payment address from the live payment challenge**, never from a transaction history.
* **Ask a person before each payment.** The check costs the same whatever the verdict.

## Which to use first

Run `check_thesis` while the thesis is being shaped; it costs nothing. Buy the receipt once, on the version you
are about to act on, when someone else needs to be able to check that you checked.
