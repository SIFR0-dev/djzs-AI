---
claim: Three FOMC dissents lock the September hike, as circulated.
falsifier: the September FOMC decision itself; intermediate falsifier, Jackson Hole guidance Aug 27-29 repricing the ladder materially
residual: two CPI prints and Jackson Hole sit before the meeting; a cool print reprices the ladder 15-25 points against the collect
probability_basis: Kalshi KXFEDDECISION-26SEP-H25 25bp-hike mid 50.5c (bid 50c / ask 51c, last 50c) against Hike-0bps mid 48.5c, ~666K contracts; Polymarket hike-by-Sep-2026 YES 45.5% on ~$693K volume; both retrieved 2026-08-06T17:05Z; CME FedWatch not used, it blocks automated access
---

# september-hike-72

Supersedes the "collectable as near-certain" draft, whose premise the print had
already killed. The claim is now framed as a *circulating narrative* rather than
the operator's own assertion, which is the honest thing to put in front of an
auditor: here is what is being said, here is what the book says.

## The gap is the point

| Venue | Contract | Implied |
|---|---|---|
| Kalshi | `KXFEDDECISION-26SEP-H25` (25bp hike at the Sep meeting) | **50.5c** (bid 50 / ask 51) |
| Kalshi | `KXFEDDECISION-26SEP-H0` (hold) | **48.5c** |
| Polymarket | `Fed Rate Hike by September 2026 Meeting?` | **45.5%** YES |

Full ladder, retrieved 2026-08-06T17:05Z:

| Outcome | Mid | Volume (contracts) |
|---|---|---|
| Hike 25bps | 0.505 | 665,705 |
| Hike 0bps (hold) | 0.485 | 846,253 |
| Hike >25bps | 0.015 | 601,935 |
| Cut 25bps | 0.015 | 634,460 |
| Cut >25bps | 0.005 | 240,835 |

"Lock" describes a market at 50.5c against 48.5c for the opposite outcome. Hike
and hold are two points apart on the deepest contracts in the ladder. Whatever
the dissents mean, the book has not priced them as locking anything.

## The dissent count is sourced; the inference is what is under audit

Per the operator's own record, multi-source verified at sweep time: the July 29
decision was **9-3**, dissenting **Hammack, Kashkari, and Logan**, all three
preferring a 25bp hike. Recorded here as operator-supplied provenance — it was
not independently re-derived in this file.

So the factual premise is sound and the phrasing stays **as circulated** on
purpose. The object under audit is not the count. It is the *inference* from
three dissents to "locked," and that inference is what the ladder disputes:
50.5c against 48.5c is not a locked outcome, whatever the dissents signal.

## Source note

CME FedWatch was the requested primary and returns HTTP 403 with an explicit
anti-automation notice, so it was not used. Kalshi and Polymarket are the
machine-pulled equivalents, no human-relayed numbers.

The two venues measure different things: Kalshi prices a 25bp hike *at* the
September meeting, Polymarket a hike *by* September. They coincide only because
the April, June, and July markets have resolved to no hike, leaving no earlier
hike for "by" to absorb.

## What the engine will not catch

The field gate passes and the engine checks that a probability basis is *stated*,
not that the claim agrees with it. A PASS here says the reasoning is well-formed,
never that the narrative is true.
