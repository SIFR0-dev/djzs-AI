# Q3 tape journal — Surf (Data API via `surf` CLI)

Governed by `PROTOCOL.md` v1.4. Append-only; one row per scan day on which Surf was called. Nothing in this file enters a record — it is the credit log and the discovery trail, not a source.

Columns: `scan_day` (UTC) · `credits_used` (from the CLI's own accounting for that day) · `over_ceiling` (`yes` once the day's total passes the v1.4 rule 5 ceiling; Surf calls stop at that point) · `commands` (bare commands run, no output) · `notes` (pool candidates surfaced and where the venue listing confirmed or refused them; narratives surfaced; articles that could not be fetched and were skipped).

| scan_day | credits_used | over_ceiling | commands | notes |
|---|---|---|---|---|
| 2026-09-09 | 0 | no | `npx tsx tests/q3/tape/discover.ts --venue-direct` (re-run after the SCAN_SPEC §1.1 book-exclusion change) | First pool day, v1.5 rule 1, venue-direct. **Supersedes the print committed at 772b392** (event-level ticker matching, deviated records excluding); earlier uncommitted prints of this day are not retained, and none was acted on — no Phase A record exists. Book exclusions: NONE on either venue; all three records excluded nothing (N5, N2 deviated; N1 `venue: series`). Kalshi top-5: KXFEDDECISION-26SEP-H0, CONTROLH-2026-D, SENATEME-26-D, KXFEDDECISION-26SEP-H25, KXBALANCEPOWERCOMBO-27FEB-RR. Polymarket top-5 (Gamma print, top-1000-events page cap, Dune 8601185 confirmation owed): 0xa3b36b2d…, 0x2e4b58fc…, 0x320a0116…, 0x876506d8…, 0xac02cbb0…. No Surf call (CLI absent in the remote container). |
| 2026-09-14 | 0 | no | `npx tsx tests/q3/tape/discover.ts --venue-direct` · `npx tsx tests/q3/dune-publish.ts --test` (Dune 8601185 confirmation) · `npx tsx tests/q3/tape/sibling-search.ts` (§7.4) · `npx tsx tests/q3/tape/market-ids.ts` | **First pool day on which `origin: pool` records were sealed — ten, `q3-2026-09-14-001`…`-010`.** Both venues' top five moved materially vs 09-10 and were reported before sealing; sealing resumed on three operator rulings (PROTOCOL v1.13 for the combination market; keys for the combo and the Clarity Act; confirmation of the day's composition). Kalshi top-5: KXFEDDECISION-26SEP-H0, -H26, -H25, -C25, KXBALANCEPOWERCOMBO-27FEB-RR — all three Senate markets from 09-10 drained out of the top ten (SENATEME-26-D 568,978 → 2,977 contracts). Polymarket top-5: 0xa3b36b2d…, 0xac02cbb0…, 0x876506d8…, 0x2e4b58fc…, 0x9cb23d04… (Clarity Act, new); Dune 8601185 returned the same five ids in the same order as the Gamma read. Clustering: 10 records over 4 events, 11 memberships (the v1.13 combo joins two); 8 of 10 on FOMC-2026-09-16. Five of ten are v1.12 no_public_case. No Surf call (venue-direct; nothing from Surf enters a record). |

## Tape toolkit
See tests/q3/tape/README.md. Credit lines below are appended by the tools.
- 2026-09-06T20:19Z · shadow-mark · credits today so far: 1/100
- 2026-09-07T20:32Z · shadow-mark · credits today so far: 1/100
- 2026-09-14T17:36Z · shadow-mark · credits today so far: 1/100
