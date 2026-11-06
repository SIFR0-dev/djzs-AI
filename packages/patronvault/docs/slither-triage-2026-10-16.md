# Slither triage, 2026-10-16

Slither 0.11.6 against `src/PatronVault.sol` at main `545eef7` (solc 0.8.28, forge build), paths `lib/`, `test/` and `script/` excluded, informational and optimization detectors excluded. 49 results, none High. No code change is needed; every finding is either the design working as specified or a pattern the reentrancy guard already covers.

Command:

```
slither . --filter-paths "lib/|test/|script/" --exclude-informational --exclude-optimization
```

| Detector | Impact | Count | Where | Verdict |
| --- | --- | --- | --- | --- |
| divide-before-multiply | Medium | 1 | `_distribute`: `o = c / period`, then `carry - o * period` | Intended. `o * period` is exactly the part of the accrual paid out; the subtraction leaves the sub-unit remainder in `carry`. That is the exact-accrual mechanism, tested by `test_settle_frequentSettlesLoseNothingToRounding`. |
| incorrect-equality | Medium | 3 | `owed == 0`, `o == 0` in `previewSettle`, `_settle`, `_distribute` | Comparisons of computed sums with zero, not balance equalities against external state. Accepted. |
| reentrancy-no-eth | Medium | 6 | `_join`, `deposit`, `withdraw`, `leave`, `_leave`, `_settle` write state after calling the source | Every external entry point is `nonReentrant`; the source and the token are called only from guarded paths. The ordering is kept because the share counts written come from the calls' return values. Accepted. |
| uninitialized-local | Medium | 2 | `weight` in `_forwardYield`, `held` in `_claimable` | Accumulators that start at Solidity's default of zero. Accepted. |
| calls-loop | Low | 23 | `_distribute` over a member's routes, `_forwardYield`, `settleMany` | Bounded by `MAX_ROUTES` = 16 per member and by the keeper's own batch size. A failing call inside the loop is caught (`_pay`, `_forwardTo`) so one creator address cannot block the rest. Accepted. |
| reentrancy-benign | Low | 6 | `creatorPaid`, `feeShares`, `memberCount` written after the call | Same guard as above. Accepted. |
| timestamp | Low | 7 | accrual, `joinDeadline` | Accrual is per second by design; a validator's few seconds of timestamp drift moves a route by fractions of a cent and the exact-accrual carry absorbs it. Accepted. |
| missing-zero-check | Low | 1 | `feeRecipient_` may be zero | Zero is allowed only when `feeBps_` is zero; the constructor enforces the pair. Accepted. |

Still owed from the pilot checklist after this: the fork run against the chosen source (`script/Screen.s.sol`) and the independent review.
