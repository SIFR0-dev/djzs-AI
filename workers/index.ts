// djzs-ai-edge — Cloudflare Worker (Step 2: read-only proxy to live Express origin)
//
// SCOPE:
//   - /health, /version  : edge-native liveness (no origin call)
//   - /api/status         : PROXIES origin GET /api/health (reflects live backend state)
//   - /api/audit/verify/:txId : PROXIES origin (free, read-only cert verification)
//
// It deliberately does NOT:
//   - import anything from ../server/ (the Express app is untouched / authoritative)
//   - re-implement any route (proxy only — origin stays the single source of truth)
//   - proxy POST / paid / escrow / XMTP routes (read-only GET allowlist only)
//   - reference any real secret or binding (see // BINDINGS: TBD). ORIGIN_URL is a
//     public, non-secret base URL set in wrangler.toml [vars].
//
// Reversible by design: deleting this Worker changes nothing about the backend.

import { Hono } from "hono";

interface Env {
  // Public base URL of the live Express origin (non-secret). Set in wrangler.toml [vars],
  // overridable locally via .dev.vars (e.g. http://localhost:5000 for offline testing).
  ORIGIN_URL: string;
  // BINDINGS: TBD — no KV / D1 / R2 / secrets wired yet.
}

const SHELL_VERSION = "0.2.0-proxy";

const app = new Hono<{ Bindings: Env }>();

// --- Edge-native liveness (no origin dependency) ---
app.get("/health", (c) => c.json({ ok: true, service: "djzs-ai-edge", role: "worker-proxy" }));

app.get("/version", (c) => c.json({ version: SHELL_VERSION, stage: "step2-proxy" }));

// --- Read-only proxy helper -------------------------------------------------
// Forwards a GET to the origin and returns its response verbatim (status + body +
// content-type). No request body is forwarded (GET only). Fails closed with 502.
async function proxyGet(originUrl: string, path: string): Promise<Response> {
  if (!originUrl) {
    return Response.json(
      { error: "origin_unconfigured", hint: "ORIGIN_URL is not set on the Worker" },
      { status: 503 },
    );
  }
  const target = new URL(path, originUrl).toString();
  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    // Pass through body + status; normalize content-type to what origin sent.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return Response.json(
      { error: "bad_gateway", target, detail: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
}

// --- Proxied read-only routes ----------------------------------------------
// /api/status reflects live backend health by proxying origin GET /api/health.
app.get("/api/status", (c) => proxyGet(c.env.ORIGIN_URL, "/api/health"));

// Free, read-only Proof-of-Logic certificate verification.
app.get("/api/audit/verify/:txId", (c) =>
  proxyGet(c.env.ORIGIN_URL, `/api/audit/verify/${encodeURIComponent(c.req.param("txId"))}`),
);

// Everything else is intentionally unhandled (no catch-all proxy by design).
app.all("*", (c) =>
  c.json(
    {
      error: "not_found",
      hint: "exposes GET /health, /version, /api/status, /api/audit/verify/:txId",
    },
    404,
  ),
);

export default app;
