---
name: djzs-trade-audit
description: Use before a user or agent places, sizes or adds to a prediction-market bet (Kalshi, Polymarket) or a perpetual or spot trade, or when they ask whether a trade thesis is sound, falsifiable or properly sourced. Runs the DJZS pre-execution audit through this server's tools, free or paid, and turns PASS, WAIT or FAIL into a plain next step.
license: MIT
metadata:
  author: SIFR0-dev
  version: "1.0.0"
  product: DJZS Protocol
  served-by: mcp.djzs.ai
---

# DJZS Trade Audit

DJZS checks the reasoning under a trade before the order goes out. Is there a stated
reason? Is there a condition that would prove it wrong? Is the risk bounded? It answers
PASS, WAIT or FAIL with the reasons. It does not predict prices, pick a side or place
orders.

## Pick the tool

| Situation | Tool | Cost |
| --- | --- | --- |
| Check a thesis with no wallet, or before deciding to pay | `check_thesis` | Free. Shared daily limit. No receipt. |
| Prediction-market bet, and the user wants a receipt | `verify_pm_trade` | 2.00 USDC |
| Perpetual or spot trade, and the user wants a receipt | `verify_perp_trade` | 2.00 USDC |
| Collect an audit the user paid for in the browser | `get_paid_audit` | Free |
| Read an agent's audit history before trusting it | `query_agent_trust`, `query_pol_certificates` | Free |

## Three rules

1. **Send the user's own words.** Do not rewrite, complete or improve the thesis. The
   audit judges what was written, and a thesis you repaired is no longer the user's. If
   something is missing, ask the user and send their answer.
2. **Ask before paying.** A paid audit costs 2.00 USDC on Base and anchors a permanent
   certificate. State the price, get a clear yes, then call. Every payment needs its own yes.
3. **Use the right tool for the market.** A thesis sent to the wrong paid tool is refused
   without charge, and the refusal carries no verdict.

## Paying from a chat

When the client cannot pay x402 itself, a paid tool answers with a payment requirement
and a pay link (`_meta["ai.djzs/pay"]`, also in the text).

1. Give the user the link and the price: 2.00 USDC on Base, paid from their own browser
   wallet. Say when the link expires.
2. Wait until the user says they paid. Do not call the paid tool again to pay.
3. Call `get_paid_audit` with the `pay_session` from that answer, and act on `status`:
   - `PAID`: the verdict and the receipt are in `audit`.
   - `PENDING`: payment is not done. Give the link again.
   - `PROCESSING`: the payment is being settled. Wait a few seconds and call again.
   - `REFUSED_SCOPE`: sent to the wrong tool. Nothing was charged.
   - `UNCERTAIN`: tell the user to check whether 2.00 USDC left their wallet before paying
     again, and to contact support with the `pay_session`.
   - `EXPIRED`: run the paid tool again for a new link.

A client with its own x402 wallet skips the link: it attaches the payment and gets the
verdict in one call.

## Reading the verdict

- **PASS** (action PROCEED): the thesis states a reason, a falsification condition and a
  bounded risk. It does not mean the trade will win.
- **WAIT** (action HALT): the fields in `halt_reason` and `unknown_fields` could not be
  resolved from the text. Ask the user for exactly those, then audit again.
- **FAIL**: do not execute as stated. Name each flag in plain words and what would fix it.

Report the `verdict_hash`, and for a paid audit the certificate, so the result can be
checked later.

## What a verdict is not

- It checks that a source for the odds is stated, not that the source is true.
  Provenance stays with the user.
- Prediction markets run the full live ruleset. Perpetual and spot trades run a narrower
  one, with fewer checks live, so a perp PASS carries less weight. Say so.
- It is not financial advice.
