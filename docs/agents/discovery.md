# Discovery

Where an agent, a crawler or a registry finds DJZS without being told.

| File | Address | What it is |
| --- | --- | --- |
| llms.txt | `https://djzs.ai/llms.txt` | Plain-text guide for language models. It opens with the free POST. |
| llms.txt (docs index) | `https://docs.djzs.ai/llms.txt` | The GitBook docs index, for language models reading the documentation. A different file from the one above. |
| AI Catalog | `https://djzs.ai/.well-known/ai-catalog.json` | AI Catalog (`specVersion` `"0.9"`) with the MCP server card inline. Served as `application/ai-catalog+json`, CORS open. |
| MCP Registry | `ai.djzs/trust-mcp` | The official MCP Registry entry: remote, streamable HTTP, `https://mcp.djzs.ai/mcp` (`djzs-trust-mcp/server.json`). |
| A2A agent card | `https://mcp.djzs.ai/.well-known/agent.json` | Agent card for agent-to-agent clients. |
| OpenAPI | `https://mcp.djzs.ai/openapi.json` | OpenAPI 3.1 for the free check (`POST /try/verdict`, `GET /try/quota`, `GET /try/example`) and the paid routes with their payment offers. CORS open. |
| Docs MCP | `https://docs.djzs.ai/~gitbook/mcp` | GitBook's MCP server for these docs: search them and read a page from an MCP client. Streamable HTTP, no key. It reads the docs only; the checks run on `https://mcp.djzs.ai/mcp`. |
| x402 resources | `https://djzs.ai/.well-known/x402.json` | The two paid resources with their x402 terms. |

The djzs.ai home page points to the catalog twice: `<link rel="ai-catalog">` in the page head and a
`Link: </.well-known/ai-catalog.json>; rel="ai-catalog"` response header.

## The server card

The catalog entry is `urn:air:djzs.ai:trust-mcp:mcp`, type `application/mcp-server-card+json`, with the card
inline:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "ai.djzs/trust-mcp",
  "version": "1.0.0",
  "title": "DJZS Trade Audit",
  "description": "Checks a prediction-market, perp or spot trade thesis before the order: PASS, WAIT or FAIL.",
  "websiteUrl": "https://djzs.ai",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.djzs.ai/mcp" }]
}
```

The card also lists the repository and two icons. It validates against the server-card schema of
`modelcontextprotocol/ext-server-card` at commit `28db12c`, and its name, version, title, website and icons match
what the server reports in `initialize`. Like any server card it is advisory: the live connection is the
source of truth.

Two version notes, as of 2026-11-20:

* The AI Catalog is a release candidate. Its spec says implementations use `"0.9"`; the MCP server-card docs show
  `"1.0"` in their example. The catalog follows the catalog spec and moves to `"1.0"` when that version is
  published.
* The card does not list protocol versions, because a static file would drift from the server. The server
  accepts the four listed on [MCP server](mcp.md).
