# workers/ — Cloudflare edge Worker (djzs-ai-edge)

In-place Cloudflare migration. Adds an edge surface alongside the existing Node/Express
backend without changing or replacing it. **Express remains the single source of truth;**
the Worker only proxies read-only GETs to it.

## Routes (Step 2)
| Route | Behavior |
|-------|----------|
| `GET /health` | Edge-native liveness. No origin call. |
| `GET /version` | Worker version/stage. No origin call. |
| `GET /api/status` | **Proxies** origin `GET /api/health` — reflects live backend state. |
| `GET /api/audit/verify/:txId` | **Proxies** origin — free, read-only Proof-of-Logic cert verification. |
| anything else | `404` JSON (no catch-all proxy by design). |

## Proxy model
- The Worker forwards selected GETs to `ORIGIN_URL` (set in `../wrangler.toml` `[vars]`,
  default `https://djzs.ai`; override locally via `.dev.vars`).
- Responses are passed through verbatim (status + body + content-type).
- Fails closed: `503` if `ORIGIN_URL` unset, `502` on upstream fetch failure.
- **No route is re-implemented** — proxying avoids behavior drift from the Express origin.

## What this deliberately is NOT
- ❌ No import from `../server/`. The Express app is untouched and authoritative.
- ❌ No POST / paid (`/api/audit/{micro,founder,treasury}`) / escrow / XMTP routes.
  Read-only GET allowlist only — no money, no on-chain writes, no secrets.
- ❌ No real bindings or secrets — all stubbed `// BINDINGS: TBD`. `ORIGIN_URL` is a
  public URL, not a secret.
- ❌ Not in the production serving path until a later, separately-approved deploy step.

## Local dev / deploy (run manually)
```bash
# Worker, local (proxies to ORIGIN_URL; override to localhost via .dev.vars):
npm run cf:worker:dev          # wrangler dev

# Test the proxy against a local Express origin instead of prod:
#   1) echo 'ORIGIN_URL=http://localhost:5000' > .dev.vars
#   2) npm run dev          # start Express on :5000 (separate terminal)
#   3) npm run cf:worker:dev

# Pages (serve built client locally):
npm run build && npm run cf:dev

# Deploy (only when approved):
npm run cf:deploy              # wrangler pages deploy dist/public
npx wrangler deploy            # publish the Worker (prints *.workers.dev URL)
```

## Next steps (not yet scoped/approved)
Expand the read-only allowlist, then carefully consider any POST/edge logic, edge config,
and optionally `estimateModelProb()` via Workers AI with Venice fallback. XMTP agent stays
on the existing stack until explicitly migrated. One approved step at a time.
