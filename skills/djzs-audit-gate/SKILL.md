---
name: djzs-audit-gate
description: Use BEFORE executing any capital-deploying MetaMask Agent Wallet action — a swap, bridge, perpetual open/modify, prediction-market order, or a transfer that moves value. Audits the trade thesis with the DJZS adversarial logic auditor and returns EXECUTE or HALT before the `mm` command runs. This is the upstream gate; MetaMask's own simulation/Blockaid/Smart-Transactions pipeline is the downstream one. Audit-before-act.
license: MIT
metadata:
  author: SIFR0-dev
  version: "1.0.1"
  product: DJZS Protocol
  pairsWith: metamask-agent-wallet
  targetsAgentWallet: "2.0.0"
---

# DJZS Audit Gate

DJZS answers **"should I take this position at all?"** It does **not** answer "is
this transaction safe to sign?" — MetaMask's mandatory pipeline (simulation →
Blockaid threat scan → Smart Transactions) owns that, downstream. Two
independent gates on two different axes. This skill is the first one.

**Invariant:** no capital-deploying action reaches the `metamask-agent-wallet`
skill until DJZS returns `EXECUTE`. On `HALT`, stop and report — do not execute.

## When this fires

Any time the user's request would result in the `metamask-agent-wallet` skill
running one of: `mm swap execute`, `mm perps open` / `modify`, `mm predict place`,
`mm transfer`, `mm wallet send-transaction`. Read-only intents (balance, price,
history, quotes without execution) do **not** require the gate.

## Decision flow

1. **Readiness** (first gated action of a session only). Confirm the environment
   is wired. See [references/readiness.md](references/readiness.md). If anything
   is missing, surface it and stop — do not improvise around a broken setup.
2. **Capture the intent.** Build the trade as: action, chain, asset(s), size,
   direction/leverage if any, the **thesis** (why), and the **exit plan / stop**.
   A trade with no articulated thesis or no stated exit is itself signal — pass
   it through as stated; never invent an exit the user did not give.
3. **Audit.** Send the composed memo to the DJZS oracle. See
   [references/gate.md](references/gate.md) for the exact call and payment.
   **There is one path, and it is paid.** Every in-scope audit costs 2.00 USDC
   over x402 on Base mainnet and mints a permanent ProofOfLogic certificate.
   There is no unpaid dry-run route on the Worker — see the safety rule below
   for what to do instead when you are still iterating.
4. **Gate on the verdict.**
   - `EXECUTE` ⟺ verdict is `PASS` **and** zero `CRITICAL` flags. Hand off to
     `metamask-agent-wallet` with the original intent.
   - Otherwise `HALT`. Report the verdict, risk score, and fired flag codes.
     Do not execute. Do not soften or re-frame a HALT into a partial action.
5. **Carry the proof.** On a production audit, attach the returned Irys
   certificate URL and logic hash to the action record, so the executed trade is
   backed by a permanent, public audit.

A returned `EXECUTE` is necessary but **not sufficient** for the trade to land:
MetaMask's Guard policy may still pause it for 2FA (out-of-allowlist, outflow
limit). Treat MetaMask's `AWAITING_MFA` / `pollingId` as a normal pending state,
not a DJZS failure.

## Safety rule (non-negotiable)

Every audit is a paid call: it spends real USDC over x402 on Base mainnet.
**Never trigger an audit without explicit, per-action user approval.** State the
price (2.00 USDC) and get a clear yes, then call.

**There is no free path to fall back to.** Earlier versions of this skill told
you to "default to the dry-run for anything exploratory". That route does not
exist and never did — the Worker serves `/mcp` and `/x402/verify`, both paid,
plus free registry and health tools that do not audit. Telling a user you will
"just dry-run it" promises something the system cannot do.

What to do while iterating, instead:
- **Sharpen the memo before spending, not after.** Most HALTs are the taxonomy
  finding a missing falsification condition or an unsourced probability. You can
  see those in the memo yourself; fix them first and pay once.
- **An out-of-scope submission is refused without charge.** That is a scope
  refusal, not a dry run, and it returns no verdict — never use it as a probe.
- If payment is not configured, **say so and stop.** Do not retry, do not
  improvise a free route, and do not present a HALT you did not obtain.

**The certificate is permanent.** A paid audit anchors an immutable record. Get
the memo right before you spend — see Correction Record 001 in
[references/gate.md](references/gate.md) for what a careless field costs.

## Routing

| Intent | Action | Reference |
| --- | --- | --- |
| Verify the gate environment is ready | `mm doctor` + oracle health | [readiness.md](references/readiness.md) |
| Audit a prediction-market order (`mm predict place`) | DJZS-M path, fully live, 2.00 USDC | [gate.md](references/gate.md) |
| Audit a perp / swap / transfer | DJZS-LF path, partially live, 2.00 USDC | [gate.md](references/gate.md) |
| Hand off an approved trade | defer to `metamask-agent-wallet` skill | (that skill's routing) |

Prediction markets run against the complete live taxonomy. The other verticals
run against a partially-activated one — fewer codes fire, so a PASS carries
less discrimination. Report that distinction; never present a thin PASS as a
thorough one.

## What this skill does not do

- It does not run `mm` commands. After `EXECUTE`, the `metamask-agent-wallet`
  skill constructs and runs the command.
- It does not replicate MetaMask's threat scan, simulation, or policy. Those run
  downstream regardless.
- It does not change MetaMask wallet policy. Policy (allowlists, outflow limits)
  is who/where/how-much; DJZS audits why. Different axes.

## Changelog

### 1.0.1 — 2026-09-13

- **Removed the dry-run path.** v1.0.0 described a "dry-run (unpaid signal)"
  and told you to default to it while iterating. **That route does not exist
  and never did** — the Worker serves `/mcp` and `/x402/verify`, both paid,
  plus free registry and health tools that never audit. Replaced with what to
  actually do while iterating, and an explicit instruction to stop rather than
  improvise a free route.
- **Added the two reference files.** `references/gate.md` and
  `references/readiness.md` were linked from v1.0.0 but did not exist.
- **Priced the routing table.** 2.00 USDC, stated where the decision is made.
- **Added the permanence warning and Correction Record 001**, so the cost of a
  careless field on an immutable certificate is on the page that tells you to
  spend.
