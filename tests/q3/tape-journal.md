# Q3 tape journal — Surf (Data API via `surf` CLI)

Governed by `PROTOCOL.md` v1.4. Append-only; one row per scan day on which Surf was called. Nothing in this file enters a record — it is the credit log and the discovery trail, not a source.

Columns: `scan_day` (UTC) · `credits_used` (from the CLI's own accounting for that day) · `over_ceiling` (`yes` once the day's total passes the v1.4 rule 5 ceiling; Surf calls stop at that point) · `commands` (bare commands run, no output) · `notes` (pool candidates surfaced and where the venue listing confirmed or refused them; narratives surfaced; articles that could not be fetched and were skipped).

| scan_day | credits_used | over_ceiling | commands | notes |
|---|---|---|---|---|

## Tape toolkit
See tests/q3/tape/README.md. Credit lines below are appended by the tools.
- 2026-09-06T20:19Z · shadow-mark · credits today so far: 1/100
