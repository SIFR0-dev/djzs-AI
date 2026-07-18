# Support

DJZS is a deterministic pre-execution audit for autonomous agents. If something's wrong or unclear:

- **Bug or unexpected verdict** — open a [bug report](https://github.com/SIFR0-dev/djzs-AI/issues/new?template=bug_report.yml). Include the `verdict_hash` if you have one; the engine is deterministic, so a hash plus the intent usually reproduces it exactly.
- **How to connect or pay** — see the [guide](https://djzs.ai/guide.html): one-line MCP install, the tool reference, and the proven x402 payer recipe.
- **General questions or updates** — [@Djzs_ai on X](https://x.com/Djzs_ai).

## Before you file

- Don't paste private keys, seed phrases, or wallet secrets. In-scope audits anchor a public on-chain certificate — treat any intent you submit as public.
- Check the endpoint is live: `https://mcp.djzs.ai/health/x402` returns the payment/health JSON.
- The source of truth for every claim is this repository; where docs and tree disagree, the tree wins.

Audit before act.
