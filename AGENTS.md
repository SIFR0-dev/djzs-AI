# AGENTS.md — djzs-AI (Hermes working rules)

Hermes loads this at session start when run from this repo. **Guidance, not enforcement** —
the teeth live in `~/.hermes/config.yaml` (`approvals.mode: manual`, empty
`command_allowlist`, `local` backend, `env_passthrough: []`), which are already set and
must stay as-is.

## Ground truth (corrected 2026-06-03 — supersedes SETUP.md)
- The two-folder model in SETUP.md is **stale and dropped.** There is **no `djzs-old/`**,
  and `djzs-ai` / `djzs-AI` are **one and the same folder** (macOS case-insensitive,
  inode 55319071). This single repo is the canonical live app.
- This repo is the **live application**, still on the **Replit / Node stack**: Express
  (`server/`), Vite + React (`client/`), Drizzle, `.replit`. Deployed and serving at
  https://djzs.ai (v2.1.0, healthy). It has **NO Cloudflare config yet.**
- Remote: `https://github.com/UsernameDAOEth/djzs-AI.git`.

## What the migration IS (and is NOT)
- **IS:** ADD Cloudflare deployment **in-place** on a branch, alongside the existing
  Express backend, without removing or breaking it.
- **IS NOT:** scaffolding a second folder, replacing Express, or rewriting routes.
- The Vite client builds to `dist/public` (`vite.config.ts` → `build.outDir`); root is
  `client/`.

## Hard rules (do not violate)
1. **Branch only.** Work on a migration branch (current: `migration/cloudflare-deploy`).
   **Never commit straight to the live/main branch.**
2. **Never `git add .`** — stage by explicit path only. The repo has pre-existing
   uncommitted changes in `server/` that are NOT ours; do not touch or stage them.
3. **No real secrets in source.** `.env*` stays gitignored; `.env.example` is fine.
   Never inline tokens/keys. Stub Worker bindings as `// BINDINGS: TBD`.
4. **Do NOT change `server/index.ts` behavior.** Leave the Express runtime intact.
5. **Do NOT migrate the XMTP agent** yet.
6. **Do not break current hosting** (Replit/Node deploy must keep working throughout).
7. **Propose a plan before writing.** Restate goal, list exact files, get explicit
   approval. `approvals.mode: manual` only prompts on dangerous commands, not every write —
   so this rule is what stages the work.
8. **One step at a time.** Finish + get sign-off on the current step before proposing the next.
9. **Production is live and costs real money** (`djzs.ai/api/audit/*` = USDC via x402 on
   Base). Never trigger a paid audit, deploy, or on-chain write without per-action approval.
10. **Stay on the `local` terminal backend** so dangerous-command checks remain active.

## Migration step plan (high level — execute one at a time, on approval)
- **Step 1:** Cloudflare Pages for the Vite client (`dist/public`) + a Hono Worker shell
  exposing `/health`, `/version`, `/api/status`. No route migration. Bindings stubbed.
- **Later steps (not yet scoped):** progressively front/route through the Worker, edge
  config, then (only if decided) `estimateModelProb()` via Workers AI with Venice fallback.
  XMTP agent stays on the existing stack until explicitly migrated.

## When the premise doesn't match disk/chain
STOP and ask. Do not fabricate a source, folder, or service that isn't verifiably present.
