# @sifr0-dev/djzs-ai

**DJZS audit gate — a stdio bridge to the remote MCP server at `https://mcp.djzs.ai/mcp`.**

> No agent acts without audit.

## What it is

`@sifr0-dev/djzs-ai` is a thin **stdio ⇄ HTTP bridge**. The DJZS audit gate is a
remote MCP server that speaks streamable HTTP. Some MCP frameworks and clients
can only launch **stdio** servers (they spawn a local process and talk over
stdin/stdout). This package is for them: it spawns
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) under the hood, points
it at the DJZS endpoint, and pipes stdio straight through — so a stdio-only host
connects to the remote gate as though it were a local server.

It carries no audit logic of its own. It is plumbing: the audit happens on the
server.

## Two ways to connect

### 1. Remote HTTP — primary

If your client speaks HTTP MCP directly, connect to the endpoint with no shim.
For Claude Code:

```sh
claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp
```

This is the preferred path. Fewer moving parts, no local process to spawn.

### 2. This shim — secondary (stdio-only hosts)

For frameworks that can only launch a stdio command, use this package as the
server command:

```sh
npx -y @sifr0-dev/djzs-ai
```

Or as an MCP server entry (shape varies by client):

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

The `djzs-ai` binary spawns `npx mcp-remote https://mcp.djzs.ai/mcp`, forwards
stdio, and exits with the child's exit code. If it can't spawn the bridge, it
prints the manual HTTP one-liner above and exits `1`.

## Requirements

- Node.js ≥ 18
- Network access to `https://mcp.djzs.ai/mcp`

## The doctrine

**No agent acts without audit.** Route through the gate — HTTP first, this shim
where stdio is all you have.

## License

MIT
