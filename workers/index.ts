// djzs-ai-edge — Cloudflare Worker shell (Step 1 of in-place CF migration)
//
// SCOPE: a minimal Hono app exposing three health/introspection endpoints ONLY.
// It deliberately does NOT:
//   - import anything from ../server/ (the Express app is untouched)
//   - migrate or proxy any existing /api/* route
//   - touch the XMTP agent
//   - reference any real secret or binding (see // BINDINGS: TBD)
//
// This is a deployable placeholder so the edge surface exists and is verifiable,
// before any real route migration is scoped/approved.

import { Hono } from "hono";

// Env is intentionally empty in Step 1. Real bindings come later, approved.
// BINDINGS: TBD
type Env = Record<string, never>;

// Static shell version. Not read from package.json (Worker has no fs at runtime).
// Bump manually or wire to a build-time var in a later step.
const SHELL_VERSION = "0.1.0-shell";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "djzs-ai-edge", role: "worker-shell" }));

app.get("/version", (c) => c.json({ version: SHELL_VERSION, stage: "step1-shell" }));

app.get("/api/status", (c) =>
  c.json({
    status: "shell",
    note: "Edge Worker shell only — no Express routes migrated yet. Live API remains the Node/Express backend.",
    migrated_routes: [],
  }),
);

// Everything else is intentionally unhandled in the shell.
app.all("*", (c) => c.json({ error: "not_found", hint: "shell exposes /health, /version, /api/status only" }, 404));

export default app;
