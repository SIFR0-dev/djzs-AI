---
name: robinhood-audit-gate
description: Use BEFORE executing any capital-deploying Robinhood Trading MCP action on the Agentic account — a place_equity_order (buy/sell) or a single-leg option order. Enforces preview-and-confirm per order, runs the DJZS adversarial thesis check, and returns EXECUTE or HALT before place_equity_order runs. This is the upstream logic/discipline gate; Robinhood's own order preview, per-trade push approval, and activity feed are the downstream ones. Audit-before-act.
license: MIT
metadata:
  author: SIFR0-dev
  version: "0.1.0"
  product: DJZS Protocol
  pairsWith: robinhood-trading
  endpoint: https://agent.robinhood.com/mcp/trading
  writeSurface: Agentic account only
---

# Robinhood Audit Gate

The Robinhood Trading MCP ships **no policy engine**: no allowlists, no outflow
cap, no Guard-mode. Its only controls are per-trade push, an activity feed,
one-tap disconnect, and order previews — and if the standing instruction says
"act without asking," it places trades with **no confirmation at all**. Approval
mode is configured in prose, not a settings panel. **This skill is that missing
policy layer.**

DJZS answers **"should I take this position at all?"** — the logic and thesis
axis. It does **not** answer "is this order well-formed / is this fill
acceptable?" — Robinhood's own pipeline (order preview → per-trade push
approval → activity feed) owns that, downstream. Two independent gates on two
different axes. This skill is the first one.

**Invariant:** no capital-deploying action reaches the Robinhood Trading MCP
until this gate returns `EXECUTE`. On `HALT`, stop and report — do not execute.
**There is never an autonomous `place_equity_order`.** Every order is
previewed and explicitly confirmed, one at a time, regardless of any standing
instruction to the contrary.

## Coverage honesty (read this before you cite a certificate)

The DJZS **served** oracle is **prediction-market only** (`verify_pm_trade`,
scope `prediction_market`; the perpetuals taxonomy is dormant, no served
surface). It does **not** score equities or options. So for a Robinhood stock
or option order:

- The logic audit here is a **local adversarial pass** (thesis · falsification ·
  exit), **not** a certified ProofOfLogic oracle call. **Do not mint or cite a
  DJZS certificate for an equity/option trade the engine cannot score.**
- Route to the paid PM oracle **only** when the intent is genuinely a
  prediction-market-shaped position expressible to `verify_pm_trade`. An equity
  buy/sell is not. If in doubt, it is not — run the local pass and say so.

Over-claiming a verdict is worse than abstaining. Name what actually ran.

## When this fires

Any request that would call `place_equity_order` — an equity buy/sell, or a
single-leg option order — **on the Agentic account**. Read-only intents
(`get_accounts`, `get_portfolio`, position/balance/history reads, option-level
info, or a `review_equity_order` preview taken for information) do **not**
require the gate.

## Decision flow

1. **Readiness** (first gated action of a session only). Confirm the MCP is
   connected (`/mcp` shows `robinhood-trading` connected) and the **Agentic
   account** exists and is funded — writes land **only** there. If the connector
   is not connected, stop: this gate cannot front a surface that isn't wired.
   Options orders additionally require the account's option approval level; check
   `get_option_level_info` / `get_option_level_upgrade_info` before treating a
   single-leg option intent as executable.
2. **Capture the intent.** Build the order as: side (buy/sell), symbol,
   quantity/notional, order type + limit/stop if any, time-in-force, and — the
   part Robinhood never asks for — the **thesis** (why) and the **exit plan /
   stop**. A trade with no articulated thesis or no stated exit is itself
   signal; pass it through as stated, never invent an exit the user did not give.
3. **Preview.** Call `review_equity_order` and show the caller the returned
   preview (est. cost, fees, buying-power impact) verbatim. The preview is the
   downstream gate's artifact; surface it, do not summarize it away.
4. **Audit (logic axis).**
   - **Equity / option order:** run the **local adversarial pass** — is the
     thesis falsifiable? is there an exit? what would have to be true for this to
     be wrong? Return a plain EXECUTE/HALT with the reasoning. No certificate.
   - **PM-shaped intent only:** send the composed memo to the DJZS oracle
     (`verify_pm_trade`). Dry-run for iteration (no spend); production is a
     **paid x402 USDC** call that mints a ProofOfLogic certificate — see the
     safety rule below.
5. **Gate on the verdict.**
   - `EXECUTE` ⟺ the logic pass is clean (PM path: verdict `PASS` and zero
     `CRITICAL` flags). Proceed to the confirm step.
   - Otherwise `HALT`. Report the reasoning (PM path: verdict, risk score, fired
     flag codes). Do not execute. Do not soften a HALT into a partial order.
6. **Confirm, per order (non-negotiable).** Present the previewed order and the
   audit result and get an **explicit, per-order yes** before calling
   `place_equity_order`. One confirmation authorizes exactly one order. Never
   batch, never carry approval forward, never place on a standing "don't ask."

## Safety rules (non-negotiable)

- **Ring-fence.** Writes land **only** in the Agentic account. Read access is
  **total** — connected, the agent can see every Robinhood account: account
  numbers, all positions and balances, all transaction and order history. Fund
  walls are not data walls; the AI provider sees the whole book. Never move, or
  imply you can move, value out of any account or into a non-Agentic one.
- **No autonomous place.** A standing instruction to "trade without asking"
  does not lift the per-order confirm — it is exactly the failure this gate
  exists to prevent. Wording is load-bearing; treat "just do it" as scope for
  *this one previewed order*, never as blanket authority.
- **Paid PM audit = real money.** A production `verify_pm_trade` spends real
  USDC over x402 on Base Mainnet and mints a certificate. Never trigger it
  without explicit, per-action approval; state the price, get a clear yes, then
  call. Default to dry-run for anything exploratory. If payment is not
  configured, say so and offer dry-run — never silently fall back to a paid route.
- **Launch-surface limits.** Long equities and single-leg options only; options
  are still rolling out and require the account's option approval level. Do not
  compose multi-leg, short, or margin intents against this surface.

## What this skill does not do

- It does not call `place_equity_order`. After `EXECUTE` **and** an explicit
  per-order confirmation, the caller places exactly the previewed order.
- It does not replace Robinhood's order preview, per-trade push, or activity
  feed. Those run downstream regardless.
- It does not mint DJZS certificates for equities/options — the served oracle
  does not score them (see Coverage honesty).
