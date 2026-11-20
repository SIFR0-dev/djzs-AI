# What is measured

As of 2026-11-20. Each claim names where its numbers live.

## Same idea, same verdict: measured

The same text, replayed, gets the same verdict 95 to 100% of the time.

| Date | Contract | Corpus | Same verdict on replay | Matched the class each thesis was written for |
| --- | --- | --- | --- | --- |
| 2026-09-01 | `DJZS-X-v1.1` (prediction markets) | 15 theses, 5 replays each | 100%, 15 of 15 identical | 15 of 15 |
| 2026-09-08 | `DJZS-X-v1.1` | 16 theses, 5 replays each | 97.5%, 14 of 16 identical | 16 of 16 |
| 2026-09-08 | `DJZS-X-LF-v1.2` (perp and spot) | 14 theses, 5 replays each | 97.1%, 13 of 14 identical | 13 of 14 |

Three runs of the same prompt measured 1.000, 0.975 and 0.950, so the stability band is reported as 95% and up.

What this covers, and what it does not:

* The corpus is short first-person theses written for the test, 54 to 586 characters.
* At temperature 0 the three readings are near-identical draws, so this measures production determinism more
  than independent agreement.
* Published third-party writing is harder. Of the 8 sealed study records that carry a published thesis (6
  distinct texts, 191 to 1,569 characters), 7 had a scored fact turned `unknown` because the readings disagreed,
  and 6 of those 7 came back WAIT. Eight records is an observation, not a measurement.

Sources: the extraction entries on [djzs.ai/ruleset](https://djzs.ai/ruleset); harness and raw runs in `tests/`.

## Reads like a careful person: not yet

The gate is tuned against a bench the founder labeled: 45 cases, 41 scoreable, 20 of them prediction-market (10
that should block, 10 that should pass), in `server/engine-v2/calibration/calibration-dataset.json`. That shows
the gate agrees with its author's labels. Blind labels from anyone else: 0.

## Verdicts predict outcomes: not yet

Whether a verdict carries information about how a trade resolves is a pre-registered study,
`tests/q3/PROTOCOL.md`. Its first read is at 100 graded records that are first audits, not void and not
deviated. At that size it can only see a large effect: about 27 percentage points.

As of 2026-11-17 (protocol v1.16):

* 11 records graded, 9 of them eligible for the first read.
* All 9 eligible records were WAIT.
* 8 of the 9 are strikes on one event, the September 2026 FOMC decision, where exactly one strike could resolve
  YES. The study counts records on one event as one cluster, never as independent evidence.

No outcome claim is made until the first read. The graded records, with their evidence links, are in
`tests/q3/records/`.
