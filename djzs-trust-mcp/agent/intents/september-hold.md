---
claim: The September hike is dead after the July payrolls print; the Fed holds, as circulated.
falsifier: the September FOMC decision itself; intermediate falsifier, the August 12 CPI print repricing the ladder materially back toward the hike
residual: two CPI prints and Jackson Hole sit before the meeting; a hot print reprices the ladder 15-25 points against the collect; three sitting dissenters preferred a hike at 9-3
probability_basis: Kalshi KXFEDDECISION-26SEP-H0 hold mid 64.5c (bid 64c / ask 65c, last 65c) against H25 25bp-hike mid 33.5c (bid 33c / ask 34c, last 33c), OI ~1.28M/677K contracts; Polymarket hike-by-Sep-2026 YES 35.5% on ~$737K volume; both retrieved 2026-08-09T20:53Z; CME FedWatch not used, it blocks automated access
---

# september-hold

Routed from sweep 011. The street form of this claim pre-screened FAIL 45
(S11-N01: M01 + M04). This intent is the well-formed mirror: same claim,
stated basis, named falsifier. The divergence between the two is the
demonstration. The pre-screen flags the crowd, the engine demands a defect.

The symmetry is the point. Entry 007 audited the opposite claim on this same
event ("three dissents lock the hike," PASS 0/100), and its named residual band
executed the next morning: minus 16.0 points on this venue after the payrolls
print. The gate now audits the reversal at the same 2.00 toll, with the same
codes, on the same book.

## The gap is the point

| Venue | Contract | Implied |
|---|---|---|
| Kalshi | KXFEDDECISION-26SEP-H0 (hold at the Sep meeting) | 64.5c (bid 64 / ask 65) |
| Kalshi | KXFEDDECISION-26SEP-H25 (25bp hike) | 33.5c (bid 33 / ask 34) |
| Polymarket | Fed Rate Hike by September 2026 Meeting? | 35.5% YES |

Full ladder, retrieved 2026-08-09T20:53Z:

| Outcome | Mid | Open interest |
|---|---|---|
| Hike 0bps (hold) | 0.645 | 1,275,657 |
| Hike 25bps | 0.335 | 677,017 |
| Hike >25bps | 0.005 | 593,021 |
| Cut 25bps | 0.015 | 863,177 |
| Cut >25bps | 0.005 | 291,038 |

"Dead" describes a market still paying 33.5 cents for the corpse. Hold is
favored roughly 2-to-1, not resolved. Whatever the payrolls print means, the
book has not priced the hike to zero: a third of the deep money disagrees with
the eulogy.

## The premise is sourced; the inference is what is under audit

Per the operator's record, multi-source verified: July payrolls printed
minus 23,000 against a consensus near plus 83,000, with a combined 103,000 in
downward revisions. The July 29 decision was 9-3, dissenting Hammack, Kashkari,
and Logan, all preferring a 25bp hike. Operator-supplied provenance, not
re-derived in this file.

The object under audit is not the print. It is the inference from one labor
report to "dead," and that inference is what the ladder disputes: 64.5 against
33.5 is a favorite, not a funeral. Two CPI prints and Jackson Hole sit between
this file and the decision.

## Source note

CME FedWatch was the requested primary and returns HTTP 403 with an explicit
anti-automation notice, so it was not used. Kalshi and Polymarket are the
machine-pulled equivalents, no human-relayed numbers.

The two venues measure different things: Kalshi prices the decision at the
September meeting, Polymarket a hike by September. They continue to coincide
because no earlier hike occurred for "by" to absorb.

## What the engine will not catch

The field gate passes and the engine checks that a probability basis is
stated, not that the claim agrees with it. A PASS here says the reasoning is
well-formed, never that the narrative is true.
