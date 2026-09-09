# Q3 SCAN_SPEC — operating rules for the scan instance

`PROTOCOL.md` is the pre-registered protocol and is amended only by numbered versions. This file is the **operating spec**: how the scan instance executes the protocol day to day. It never overrides the protocol; when they disagree, the protocol wins and this file is corrected. Rule references below are to `PROTOCOL.md`.

## 1. §3 coverage pool — category implementation (v1.5 rules 1–2)

v1.5 rule 1: the pool is top-N (N = 5) by 24h volume **within the scan's categories — economics, rates and central banks, crypto, domestic politics, geopolitics — per venue**; sports, esports, entertainment and weather are excluded. Rule 2: the exact venue labels are committed in code, so the mapping is inspectable and re-executable. The committed label sets are:

| venue | field | INCLUDE (any) | EXCLUDE (wins over include) | committed in |
|---|---|---|---|---|
| Polymarket | `polymarket_polygon.market_details.tags` (Dune) = Gamma event tags, several per market | `Politics` · `Elections` · `Geopolitics` · `World` · `Economy` · `Fed` · `Finance` · `Crypto` | `Sports` · `Esports` · `Culture` · `entertainment` · `Weather` | `queries/polymarket_pool.sql` header (the source of truth) · `tape/discover.ts` (same regexes) · `dune-publish.ts` (same regexes, publish check) |
| Kalshi | `event.category` (public API, one per event; markets inherit) | `Economics` · `Financials` · `Crypto` · `Politics` · `Elections` · `World` | every other label — observed open on 2026-09-09: `Sports` · `Entertainment` · `Climate and Weather` · `Companies` · `Science and Technology` · `Mentions` · `Health` · `Social` · `AI` · `Transportation` · `Business` | `tape/discover.ts` (`KALSHI_POOL_CATEGORIES`) |
| Surf (tape only) | Surf category enum | `economics` · `financials` · `crypto` · `politics` | `sports` · `culture` · `stem` | `tape/config.json` |

Mapping decisions, recorded:
- **Matching rule (Polymarket).** Labels are matched as whole words, case-insensitive, on the tag string: `(^|[^a-z0-9])(label|…)([^a-z0-9]|$)`. This is the same whether Dune stores `tags` as a JSON array text or a delimited list, keeps `Esports` from matching `Sports`, and lets `Fed Rates` / `World Elections` match `Fed` / `World`. A market carrying any EXCLUDE label is out even if it also carries an INCLUDE label (a sports market tagged `Politics` is still sports). `World Series` / `World Cup` markets carry `Sports` and are out by that rule.
- **Unclassifiable = out.** A Polymarket market with no `market_details` row yet (the API snapshot lags chain) has no tags; it is not in the pool until the snapshot catches up. Showing it as in-category would be an assertion, which rule 2 forbids.
- **Financials.** Index/equity contracts (`Financials` on Kalshi, `Finance` on Polymarket) are admitted: `tape/config.json` already maps Surf's `financials` into the pool and `index-bind.ts` treats Kalshi index contracts as bindable. Rates/central-bank contracts sit under `Economics`/`Economy`/`Fed` on both venues (verified live: KXFED, KXCPI → `Economics`; the Fed Decision event → `Fed`, `Economy`).
- **Geopolitics.** Kalshi has no geopolitics label; its `World` and `Politics` categories carry it. Polymarket has `Geopolitics` and `World`.
- **Kalshi combos.** Multivariate combo/parlay markets (`mve_collection_ticker` set, or `market_type` other than `binary`) are not pool markets; only `status: active` binary markets rank.
- **Changing a label** is a rule-2 event: change it in every "committed in" cell in the same commit, and put the exact strings in the commit message.

## 2. Ranking metric, disclosed per venue

| venue | record-bearing pool read | 24h volume unit |
|---|---|---|
| Polymarket | public Dune query `dune.json.pool_query_id` (8601185), `exclude` = condition ids already in the book | USDC, single-counted taker legs (`SUM(amount)` on `is_taker_side`) |
| Kalshi | venue-direct read in `tape/discover.ts` (public API, no key) | **contracts** (`volume_24h_fp`) — the public API does not expose 24h USD volume; the Dune `kalshi.market_trades` USD ranking in `queries/kalshi_pool.sql` is plan-gated (v1.3.1) |

The Polymarket venue-direct read (Gamma `volume24hr`, USD) is the day's candidate print only; the pool that enters a record is confirmed by re-running the Dune query. When the two disagree on membership, the Dune query decides and the discrepancy goes in the day's journal note.

## 3. A pool day

1. `npx tsx tests/q3/tape/discover.ts` — venue-direct pool for both venues always runs (0 credits, works in a remote container); Surf candidates, news and the macro-chain scan run only where the `surf` CLI is on PATH (`--venue-direct` skips Surf deliberately). Output: `tests/q3/discovery/YYYY-MM-DD.json` with the label sets used, the book exclusions applied, counts scanned, the top-5 and the next-5.
2. Polymarket confirmation: run query 8601185 with `n=5`, `exclude=<condition ids already in the book>` (needs `DUNE_API_KEY`; or re-run the public query in the Dune UI). Every returned row carries its `tags`; a row whose tags do not satisfy §1 is a bug in the SQL, not a pool member.
3. The pool for the day is the top-5 per venue after book exclusions. A pool market enters the book only as an `origin: pool` record under the protocol's normal Phase A/B; rule 3 keeps scan bindings outside the categories admissible.
4. Log the day: one journal row in `tests/q3/tape-journal.md` (Surf credits, or `0` for a venue-direct-only day) with the top-5 tickers/condition ids per venue in `notes`, and commit the discovery JSON.
5. Sports records, if ever logged, carry `inclusion_note: "sports stratum"` and never enter the primary (v1.5 rule 4).

## 4. Republishing the Polymarket pool query

`npx tsx tests/q3/dune-publish.ts --update` PATCHes the committed SQL onto 8601185, verifies the published text equals the file, and runs the contract checks: five rows, seven columns (`tags` added in v1.5), decimal token ids, the exclude path, and — new — **every row's `tags` satisfies §1**. Needs `DUNE_API_KEY` (Analyst plan). The first republish after the v1.5 SQL also confirms the stored format of `market_details.tags` (documented by Dune only as "Market category tags from the API"); the whole-word match was written to hold under either format, and the check is what proves it.

## 5. First pool day log

See the log appended below by the scan instance on the day the pool is first run.

### 2026-09-09 — first pool day (venue-direct, remote container, Surf not run; discovery JSON: `tests/q3/discovery/2026-09-09.json`)

Kalshi — 13,047 open events scanned, 30,015 in-category active binary markets, book exclusion `KXFEDDECISION-26SEP` (pilot N5, event-level) dropped 5 markets (KXFEDDECISION-26SEP-C26, KXFEDDECISION-26SEP-C25, KXFEDDECISION-26SEP-H0, KXFEDDECISION-26SEP-H25, KXFEDDECISION-26SEP-H26). Ranking metric: 24h contracts.

| # | ticker | category | 24h volume | last | market |
|---|---|---|---|---|---|
| 1 | `CONTROLH-2026-D` | Elections | 615,619 contracts | 0.85 | Will Democrats win the House in 2026? |
| 2 | `KXBALANCEPOWERCOMBO-27FEB-RR` | Elections | 462,403 contracts | 0.16 | Will House Control be Republican AND Senate Control be Republican for Feb 2027? |
| 3 | `KXGOVRINOMD-26-DMCK` | Elections | 336,879 contracts | 0.022 | Will Dan McKee be the Democratic nominee for Governor in Rhode Island? |
| 4 | `CONTROLH-2026-R` | Elections | 326,156 contracts | 0.16 | Will Republicans win the House in 2026? |
| 5 | `SENATEME-26-D` | Elections | 289,657 contracts | 0.67 | Will Democratics win the Senate race in Maine? |

Next five, for the record: `SENATETX-26-R` (Elections, 287,587) · `KXBTCD-26SEP0917-T78999.99` (Crypto, 239,836) · `KXGOVRINOMD-26-HFOU` (Elections, 185,098) · `KXBTC15M-26SEP091515-15` (Crypto, 166,445) · `KXBTCD-26SEP0917-T78499.99` (Crypto, 161,403). Crypto (KXBTCD/KXBTC15M hourly strikes) enters at rank 7; no Economics contract survives the book exclusion today.

Polymarket (Gamma candidate print; Dune 8601185 decides once republished) — 1,000 open events scanned, 3,395 in-category active markets, no book exclusions.

| # | condition_id | tags (first three) | 24h volume | last YES | market |
|---|---|---|---|---|---|
| 1 | `0xa3b36b2d6104d34af4e6c6215fc818e43352e78a748fbfb0b85e3a35f71dec9a` | fomc, Economic Policy, Fed Rates | 1,123,813 USD | 0.465 | Will there be no change in Fed interest rates after the September 2026 meeting? |
| 2 | `0x320a0116959f7573f87212ce61e323438862689cdb4dc5e38b3a9f0fbd1cbed4` | FDV, Biden, Crypto | 919,154 USD | 0.235 | LAPTOP FDV above $1B one day after launch? |
| 3 | `0x876506d8b2bd7a0d3fa4fe18c024eee6e1dd81ee24c26795dadd6cfe4a7b5d0d` | fomc, Economic Policy, Fed Rates | 736,773 USD | 0.535 | Will the Fed increase interest rates by 25 bps after the September 2026 meeting? |
| 4 | `0xac02cbb049e46d6a3627c0fdf52fa554982a9025d45968207b362acb6ca4b830` | fomc, Economic Policy, Fed Rates | 655,251 USD | 0.0035 | Will the Fed decrease interest rates by 25 bps after the September 2026 meeting? |
| 5 | `0x2e4b58fc18dbffd74d5275d89fb076943f21992763c45dcadd81391b83bde13c` | fomc, Economic Policy, Fed Rates | 517,399 USD | 0.0075 | Will the Fed increase interest rates by 50+ bps after the September 2026 meeting? |

Four of five are strikes of one event (Fed Decision in September?); the protocol ranks markets, not events, so this is the pool as written. Every sports/tennis/soccer/esports market that led the unfiltered ranking (the v1.5 motivation case) is out. Dune confirmation of the Polymarket five is owed: the republish needs `DUNE_API_KEY`, absent in this container.
