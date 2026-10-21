# Readiness

Run once, on the first gated action of a session. If anything here is missing,
**surface it and stop** — do not improvise around a broken setup, and do not
substitute a route that does not exist (there is no unpaid audit path; see
[gate.md](gate.md)).

## 1. The oracle answers

```
curl -s https://mcp.djzs.ai/health/x402
```

Expect `facilitator_configured: true` and the advertised network
`eip155:8453` (Base mainnet).

**Stop gate:** a 402 challenge (`accepts[0]`) showing `eip155:84532` or USDC
signing name `"USDC"` means a testnet override has leaked into production. The
gate applies to the challenge, not to `advertised_networks` in this health
output, which always lists testnets. Base mainnet USDC signs
under `"USD Coin"`; Base Sepolia under `"USDC"`. Report it and stop — do not pay
into it.

## 2. The paywall is actually up

Probe both paid routes:

```
for route in verify_pm_trade verify_perp_trade; do curl -s -o /dev/null -w "$route %{http_code}\n" -X POST "https://mcp.djzs.ai/x402/$route" -H 'content-type: application/json' --data '{"intent":"readiness probe"}'; done
```

Expect **402** from each. A 200 means the gate is not charging and the
deployment is wrong; a 404 on the canonical host with the workers.dev alias
answering is a known edge-cache lag, not a failure — re-probe before reporting.

Python clients reach the gate (checked 2026-10-18: 200 on health, 402 on the
paid route), and MetaMask's x402 helper is a Python script.

## 3. The wallet can pay

```
mm doctor
```

Confirm: a funded Base-mainnet payer, USDC balance (`mm wallet balance`) **≥ 2.00**
plus headroom, and ETH for gas on any follow-on transaction.

An underfunded payer fails at the facilitator's `verify`, which simulates the
transfer — you get `INVALID_PAYMENT`, not a partial charge. Check the balance
before the call rather than reading the failure afterwards.

Then check the x402 helper. Find the `metamask-agent-wallet` skill folder that
contains `scripts/x402_pay.py`, and confirm `python3` is available:

```
python3 --version
test -f "<metamask-agent-wallet skill dir>/scripts/x402_pay.py" && echo present
```

If the helper is missing or `python3` is not available, surface it and stop.

## 4. Know your rollback

Before any action that moves value, know what "undo" means — and for the audit
itself, know that it does not exist. **The certificate is permanent.** There is
no retraction, only a Correction Record.

## What readiness does NOT establish

- That a PASS will be correct. The engine checks a thesis is *stated* and
  *bounded*, not that it is *true*.
- That MetaMask will execute. Guard policy may still pause for 2FA;
  `AWAITING_MFA` / `pollingId` is a normal pending state, not a DJZS failure.
- That the trade is safe to sign. MetaMask's simulation → Blockaid →
  Smart Transactions pipeline owns that, downstream and independently.
