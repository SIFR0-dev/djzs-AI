# Codex Local Runbook

This repo is now usable from a Codex-first local workflow. Replit can remain a deployment target, but day-to-day development should use the GitHub repo and this local checkout.

## Source Of Truth

- GitHub: `https://github.com/UsernameDAOEth/djzs-AI`
- Local Codex checkout: `~/Documents/Codex/2026-06-02/djzs-AI`

## Setup

```bash
cd ~/Documents/Codex/2026-06-02/djzs-AI
npm ci
cp .env.example .env
```

Do not commit `.env` or private keys. Add production secrets only in the deployment provider.

## Local Development

Port `5000` may already be occupied by another local service. Use the Codex-local script:

```bash
npm run dev:local
```

Then verify:

```bash
npm run smoke:local
```

Default local URL:

```text
http://localhost:5050
```

## Verification

```bash
npm run check
npm run build
```

## Optional Services

The app runs locally without secrets, but these features stay disabled until configured:

- `DATABASE_URL` for persistence
- `VENICE_API_KEY` or `ANTHROPIC_API_KEY` for AI audits
- `IRYS_PRIVATE_KEY` for Datachain uploads
- `XMTP_*` env values for the XMTP agent
- `CF_STREAM_*` env values for video audits
- `SETTLEMENT_PRIVATE_KEY` and contract addresses for on-chain writes

## Migration Notes

- Public discovery metadata should point at `https://djzs.ai`, not a Replit URL.
- `.replit` is optional infrastructure metadata, not the local development source of truth.
- Use GitHub branches and pull requests for changes that should leave Codex.
