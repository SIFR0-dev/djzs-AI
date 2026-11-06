# Perp gate dogfood via MetaMask Agent Wallet — runbook r1 (2026-10-20)

// SYS_ID        djzs-perp-dogfood-01
// PATH          MetaMask Agent Wallet (server wallet, Guard) -> djzs-audit-gate skill -> POST https://mcp.djzs.ai/x402/verify_perp_trade -> HALT or EXECUTE -> (no mm command on HALT)
// SPEND         2 paid audits, 4.00 USDC on Base mainnet, 0 ETH (x402 exact: the facilitator submits the transfer)
// RUNS FROM     DJ's shell only (payer key, agent wallet, mm login). The container prepared this and stops here.
// STATUS        READY TO RUN AFTER G1-G2 BELOW ARE ACKNOWLEDGED

## 0. What this run proves, and what it does not

Proves
- The perp gate path end to end from a real agent wallet: 402 challenge, paid settlement, verdict, anchored certificate, and the invariant that a HALT leaves no `mm perps open` behind.
- A settlement on `verify_perp_trade`, which puts the tool back in CDP's Bazaar index (resources idle 30 days are dropped; it has never settled a non-DJ call and was unindexed on 2026-09-27).
- The first trust record for the Agent Wallet address, if agent_address is passed on call 2.

Does not prove
- The scoreboard. The Agent Wallet is DJ's wallet. "3 distinct non-DJ paying wallets by 2026-10-27" does not move. This is dogfood, not a customer.
- Perp discrimination. DJZS-LF-v1.2 has 4 of 11 codes live, and the 2026-09-08 harness returned WAIT 5/5 on all four FAIL-designed perp cases (fields arriving as unknown). Expect the bad memo to HALT by WAIT, not by FAIL. HALT is HALT; the invariant holds either way. Record which one fired.

## 1. Gaps found in the container (fix or accept before paying)

G1. The audit-gate skill does not name the perp endpoint. `references/gate.md` lists `/mcp` and `/x402/verify` with `verify_pm_trade` as the paid tool. The perp route exists on the Worker (`src/index.ts:1500`, `POST /x402/verify_perp_trade`, and the MCP tool `verify_perp_trade` on `/mcp`) and in `openapi.json`, but an agent following the skill as written sends a perp memo to `/x402/verify`, which is PM-only and refuses it free with no verdict. A skill update that adds the endpoint is proposed alongside this runbook (review card). Until it is saved, instruct the agent explicitly: perp memos go to `/x402/verify_perp_trade` or the MCP tool `verify_perp_trade`.

G2. The refusal agent was PM-only. `agent/refusal-agent.mjs` hardcoded `verify_pm_trade` with PM-shaped required fields, so its rails (4.00 USDC floor, 2 paid runs per UTC day, `--expect-sha` ticket) did not cover the perp tool. PR #187 adds `--tool perp` with a perp field gate and a second frozen render. The dogfood itself goes through the MetaMask skill path, not the reference agent, so this run's ticket is still the manual sha in step 3; routine paid perp testing afterwards goes through `--tool perp` and gets the rails.

G3. Discovery copy overstates. `discovery-surfaces.ts:102` tells Bazaar "A position stated with no thesis FAILS (DJZS-S01); an unbounded position FAILS (DJZS-X01)". The 09-08 harness says those memos come back WAIT. Call 1 of this run is the live test. If it returns WAIT, the discovery line is a truth-pass item (change the copy, not the engine).

G4. The HTTP route takes a structured body, not free text. Bazaar schema: `{"intent":{"instrument","side","thesis","leverage","entry","stop_loss","take_profit","invalidation","size_usd","venue","data_sources"}}`, with instrument, side and thesis required. The MCP tool takes `intent` as one string. Read the live 402 challenge; it carries the exact schema and is authoritative over this file.

G5. Disclosure law. SCAN_SPEC s13: a position opened in a market the scan has graded (or has a grade pending) must be hashed and anchored before the trade and disclosed on camera. BTC has a pending grade (Uptober, 2026-10-31) and S&P was graded 2026-10-19. So: do not execute a BTC or index perp from this run. Stop at EXECUTE on call 2. If Gate 2 (MetaMask) must be exercised, use an instrument the scan has never graded and keep size at the venue minimum.

## 2. Readiness (once, before any money)

Per the skill's `references/readiness.md`, plus one perp-specific probe.

```
cd ~
curl -s https://mcp.djzs.ai/health/x402
curl -s https://mcp.djzs.ai/health/writer
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.djzs.ai/x402/verify_perp_trade -H 'content-type: application/json' --data '{"intent":{"instrument":"probe"}}'
curl -s -X POST https://mcp.djzs.ai/x402/verify_perp_trade -H 'content-type: application/json' --data '{"intent":{"instrument":"probe"}}'
mm doctor
mm auth status
mm init show
mm wallet address
```

Stop gates, from the 402 body
- network must be `eip155:8453`; `extra.name` must be `USD Coin`; amount `2000000`; asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- `payTo` must equal the repo constant `X402_RECIPIENT` in `djzs-trust-mcp/src/index.ts`. Compare to the constant, never to wallet history (s14 address-provenance rule; the c19...ecca decoy is live).
- `mm init show` must say server wallet and Guard. Beast mode is a stop.
- Agent Wallet USDC >= 6.00 (two audits plus headroom; the facilitator's verify simulates the transfer and returns INVALID_PAYMENT on an underfunded payer, no partial charge). No ETH needed for the audits.
- A 404 on the canonical host while `djzs-trust-mcp.easy-less-spoil.workers.dev` answers is edge-cache lag; re-probe, do not report a failure.

## 3. The two memos, and the manual ticket

Write both memos to files before anything else. The certificate is permanent (Correction Record 001), so every field is a considered statement, not a test string. Prices come from the venue at run time; never type a number you did not read.

Memo A, designed HALT (bounded by nothing). Fill the price from Hyperliquid's own mark at run time.

```
instrument: BTC-PERP
side: long
venue: Hyperliquid
leverage: 10
size_usd: 500
entry: <Hyperliquid BTC mark at run time, with timestamp>
thesis: ETF inflows accelerated this week and the 50-day average was reclaimed, so the trend resumes.
stop_loss: none
invalidation: none; holding until it tops out.
data_sources: none named
```

Expected: HALT. Engine shape: X01 EXECUTION_UNBOUND if extraction resolves the stop as absent; WAIT if it resolves it as unknown. Both are HALT. Nothing executes.

Memo B, bounded, DJ's own considered thesis. Template; every bracket must be filled with a real number and a real reason or the run does not happen.

```
instrument: <a perp the scan has never graded; not BTC, not an index; see G5>
side: <long|short>
venue: Hyperliquid
leverage: <= 3
size_usd: <venue minimum>
entry: <Hyperliquid mark at run time, with timestamp>
thesis: <one paragraph: why the price moves this way, in the next <N> days, and what evidence you read>
stop_loss: <level>, because at that level <the thesis is wrong for this stated reason>
take_profit: <level>
invalidation: <the observable condition that proves the thesis wrong, independent of price if possible>
data_sources: <where each number above came from, with timestamps>
```

Expected: PASS with risk below threshold, or WAIT if a field does not resolve. A PASS here is a thin PASS (4/11 codes) and must be reported as thin.

Manual ticket (replaces `--expect-sha`, which the refusal agent only applies to the PM tool)

```
shasum -a 256 memo-a.txt
shasum -a 256 memo-b.txt
```

Record both hashes in the run log before paying. If a memo file changes after this line, the hash changes and the run restarts at step 3. This is the s14 ticket gate done by hand.

## 4. Call 1: memo A through the agent (2.00 USDC)

- Invoke the djzs-audit-gate skill with memo A, stating the endpoint explicitly: `POST https://mcp.djzs.ai/x402/verify_perp_trade` (or MCP tool `verify_perp_trade`). Do not pass agent_address on this call (one variable at a time, s14(e) precedent).
- Approve exactly one payment of 2.00 USDC when asked. Any second approval request is a stop.
- Expected result: `verdict` WAIT or FAIL, `action` HALT. The skill must report and stop. Confirm no execution:

```
mm perps positions
mm wallet history
```

Positions: none. History: exactly one USDC transfer of 2.000000 to the payTo from step 2. Anything else is a stop and a reconciliation (s14 method, eth_getLogs on USDC Transfers, signer check on `tx.from`).

- Record: verdict, action, risk_score, flags, unknown_fields, verdict_hash, certificate id, settlement tx. On the MCP path the receipt is in `result._meta["x402/payment-response"]`, not a header. On the HTTP path, if the response carries no settlement tx, recover it from chain, do not log null.

## 5. Call 2: memo B through the agent (2.00 USDC)

- Same invocation with memo B and `agent_address = <mm wallet address>`. This writes the Agent Wallet's first trust record on Base, permanently.
- Expected: PASS, no CRITICAL flag, action PROCEED, skill returns EXECUTE. Or WAIT; then HALT and fix the memo, do not re-pay on a guess.
- On EXECUTE: stop here by default (G5). Opening the position is a separate decision; if taken, it is Gate 2's test, not Gate 1's, and it runs under Guard with `--wait`.
- Record the same fields as call 1, plus `mechanics.breakeven` if a bracket was passed (non-scoring; never in the hash).

## 6. Verification, after both calls

```
curl -s https://mcp.djzs.ai/health/writer
```

Then from the agent or any MCP client, free tools:
- `query_pol_certificates` filtered to today: both certificates present, verdict and verdict_hash matching the run log.
- `query_agent_trust(<mm wallet address>)`: `INSUFFICIENT_HISTORY` with totalAudits 1 is the correct answer below 10 scored audits. A rate is a bug.
- Bazaar: `verify_perp_trade` back in the index within CDP's refresh window (check the scheduled scan output or x402scan.com). Note the lastUpdated timestamp.

Balance reconciliation (s14): every outbound USDC transfer from the Agent Wallet since funding, matched against the repo payTo constant. Two transfers of 2.000000 expected. A 0.00 transfer to a look-alike address is the poisoning campaign, costs nothing, and goes in the log as observed, not as a payment.

## 7. Pass / stop criteria

PASS (the dogfood is discharged)
1. Call 1 HALTed and no `mm perps` command was issued.
2. Call 2 settled, certificate anchored, verdict_hash recorded, trust write landed for the Agent Wallet.
3. Both settlements went to the repo payTo; reconciliation closes to the cent.
4. `verify_perp_trade` re-indexed on Bazaar.

STOP (do not continue, report)
- 402 body shows `eip155:84532` or `USDC` as the signing name (testnet override leaked).
- payTo differs from the repo constant.
- Beast mode, or any second payment prompt on one call.
- A PASS carrying a CRITICAL flag (the skill must HALT; if it says EXECUTE, the skill is wrong, not the engine).

## 8. What gets recorded where

- Run log: a new `djzs-trust-mcp/agent/dogfood-2026-10-xx.md` on a branch (container opens the PR on request): memos verbatim, both hashes, both results, settlement txs, reconciliation, G3 outcome.
- If call 1 returned WAIT: truth-pass item for `discovery-surfaces.ts:102` ("FAILS" -> "is halted"), its own PR, no engine change.
- CLAUDE.md addendum s16 after DJ merges: perp dogfood date, outcome, and the standing instruction that perp memos route to `verify_perp_trade`.

## 9. Follow-ups this run does not need

- `refusal-agent.mjs --tool verify_perp_trade` with perp required fields, so routine paid perp testing gets the floor, the daily cap and the ticket. Small PR.
- Promote-to-front-door rule stands: the perp tool becomes a front-door surface only when one outside wallet pays for it.
