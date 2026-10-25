# Perp gate dogfood — run log (fill at run time; runbook: 2026-10-perp-dogfood-runbook-r1.md)

// SYS_ID        djzs-perp-dogfood-01
// RUN_DATE      <YYYY-MM-DD, PT>
// OPERATOR      DJ (shell + MetaMask Agent Wallet; server wallet, Guard)
// STATUS        NOT RUN

## Readiness (step 2)
| probe | expected | observed |
|---|---|---|
| GET /health/x402 | facilitator_configured true, eip155:8453 | |
| GET /health/writer | authorized_on_contract true | |
| POST /x402/verify_perp_trade (unpaid) | 402 | |
| 402 body: network / extra.name / amount / asset | eip155:8453 / "USD Coin" / 2000000 / 0x8335...2913 | |
| 402 body: payTo == repo X402_RECIPIENT | match | |
| mm init show | server wallet, Guard | |
| Agent Wallet USDC | >= 6.00 | |

## Memos and manual ticket (step 3)
| memo | file | sha256 (before payment) |
|---|---|---|
| A, designed HALT (no stop) | memo-a.txt | |
| B, bounded thesis | memo-b.txt | |

## Call 1: memo A (step 4)
| field | value |
|---|---|
| endpoint used | |
| agent_address passed | no |
| verdict / action | |
| risk_score / flags / unknown_fields | |
| verdict_hash | |
| certificate id (Irys) | |
| settlement tx (source: _meta or chain) | |
| mm perps positions after | expected: none |
| mm wallet history after | expected: one 2.000000 USDC transfer to payTo |
| G3 outcome (WAIT or FAIL on an unbounded memo) | |

## Call 2: memo B (step 5)
| field | value |
|---|---|
| endpoint used | |
| agent_address passed | yes: <mm wallet address> |
| verdict / action / skill decision | |
| risk_score / flags / unknown_fields | |
| verdict_hash | |
| certificate id (Irys) | |
| settlement tx | |
| trust write (tx, totalAudits after) | |
| executed? | expected: no (G5) |

## Verification (step 6)
| check | observed |
|---|---|
| query_pol_certificates: both certs present | |
| query_agent_trust(<mm address>): INSUFFICIENT_HISTORY, totalAudits 1 | |
| Bazaar: verify_perp_trade re-indexed (lastUpdated) | |
| balance reconciliation: outbound USDC vs payTo constant | |
| 0.00 USDC look-alike transfers observed (poisoning, not payments) | |

## Result (step 7)
- PASS criteria met: 1 [ ] 2 [ ] 3 [ ] 4 [ ]
- Stop conditions hit: none / <which>
- Follow-ups opened: <discovery-surfaces.ts:102 truth pass if call 1 returned WAIT>; <CLAUDE.md s16 addendum after merge>
