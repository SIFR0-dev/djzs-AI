#!/usr/bin/env node
"use strict";

// DJZS audit gate — stdio bridge to the remote MCP server.
// For stdio-only MCP frameworks that cannot speak HTTP directly, this shim
// spawns `npx mcp-remote <url>` and pipes stdio straight through, so the
// framework talks to the remote server as if it were a local stdio server.
//
// No agent acts without audit.

const { spawn } = require("node:child_process");

const REMOTE_URL = "https://mcp.djzs.ai/mcp";
const MANUAL_ONE_LINER =
  "claude mcp add --transport http djzs-trust https://mcp.djzs.ai/mcp";

// Forward any extra args the caller passed after `djzs-ai`.
const extraArgs = process.argv.slice(2);
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npxCmd, ["mcp-remote", REMOTE_URL, ...extraArgs], {
  stdio: "inherit",
});

// spawn() failure (e.g. npx not on PATH) surfaces here, not as an exit code.
child.on("error", (err) => {
  process.stderr.write(
    `djzs-ai: failed to spawn \`${npxCmd} mcp-remote ${REMOTE_URL}\`: ${err.message}\n\n` +
      "Connect the remote MCP server directly instead:\n\n" +
      `    ${MANUAL_ONE_LINER}\n\n`
  );
  process.exit(1);
});

// Forward the child's exit status. On signal death, re-raise so parents see it.
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});

// Relay termination signals to the child so it can shut down cleanly.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
