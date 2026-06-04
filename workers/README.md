# workers/ — Cloudflare edge shell (djzs-ai-edge)

Step 1 of the **in-place** Cloudflare migration. Adds an edge surface alongside the
existing Node/Express backend without changing or replacing it.

## What this is
- A minimal **Hono Worker** (`index.ts`) exposing three endpoints:
  - `GET /health` → `{ ok: true, ... }`
  - `GET /version` → `{ version, stage }`
  - `GET /api/status` → `{ status: "shell", migrated_routes: [] }`
- Cloudflare **Pages** serves the existing Vite client build from `dist/public`
  (configured in `../wrangler.toml`, `pages_build_output_dir`). The build script is
  unchanged — `npm run build` already emits there.

## What this deliberately is NOT (Step 1 boundaries)
- ❌ No import from `../server/` — the Express app is untouched.
- ❌ No `/api/*` route migrated or proxied. The three endpoints are fresh shell stubs.
- ❌ No XMTP agent work.
- ❌ No real bindings or secrets — all stubbed `// BINDINGS: TBD`.
- ❌ The live API at https://djzs.ai is still the Node/Express backend. This shell is not
  in the serving path until a later, separately-approved step.

## Local dev / deploy (run manually, not part of file scaffolding)
```bash
# Worker shell, local:
npm run cf:worker:dev          # wrangler dev

# Pages (serve built client locally):
npm run build && npm run cf:dev

# Deploy (only when approved):
npm run cf:deploy              # wrangler pages deploy dist/public
```
`wrangler` must be installed first (`npm i` after the devDependency was added).

## Next steps (not yet scoped/approved)
Progressively front routes through the Worker, add edge config, optionally
`estimateModelProb()` via Workers AI with Venice fallback. One approved step at a time.
