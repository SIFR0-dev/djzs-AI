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
- **A semantically conjunctive market stays in the pool (operator ruling, 2026-09-09).** `KXBALANCEPOWERCOMBO-27FEB-RR` ("House Control Republican **AND** Senate Control Republican") reached rank 5 of that day's Kalshi pool. It carries no `mve_collection_ticker` and is `market_type: binary`, so the combo rule above admits it. **Ruled: it stays.** Pool membership is mechanical per PROTOCOL §3 — top-N by 24h volume within the categories — and no semantic conjunction filter is added. The combo rule above is the whole test; it screens the venue's multivariate instruments, not the English of a question. Reading conjunctions out of the pool by hand would make membership a judgement call, which is exactly what §3 removes. Do not add such a filter without a numbered PROTOCOL amendment.
- **Changing a label** is a rule-2 event: change it in every "committed in" cell in the same commit, and put the exact strings in the commit message.

### 1.1 Book exclusion — which records exclude which markets

PROTOCOL §3 words the pool as "the top-N markets by 24h volume **that have no existing record**". Two operating rules narrow what counts as an existing record. Both live in `tape/discover.ts` (`bookExclusions`), and every run prints them and writes them to the day's JSON under `book_exclusion`.

1. **Market level only.** Only a market's own id is ever compared; no event-level id is. On Kalshi that is the record's `market.ticker`. On Polymarket it is the Gamma **market slug** carried in `market.ticker` (optionally `polymarket:`-prefixed — `q3-log.ts` Phase A and `q3-grade.ts` both resolve it with `/markets?slug=`, and PROTOCOL pre-registers that a venue ticker must resolve in Phase A), plus a `condition_id` alias if a hand-written record carries one. The pool reader ranks Polymarket on `conditionId`, so it compares **both** the candidate's condition id and its market slug — the event slug is never compared. A record whose ticker names a parent **event** therefore drops only a market of that exact id, never the event's other strikes: the pilot `q3-2026-09-02-N5` carries `KXFEDDECISION-26SEP`, an event ticker whose corrected market ticker PROTOCOL's v1.3.1 finding gives as `KXFEDDECISION-26SEP-H25`, and it drops no strike.
2. **Primary-eligible sources only.** Only a record with `deviated` absent or `false` excludes anything; a deviated record excludes nothing. It sits outside the primary analysis (PROTOCOL §8, "Pilot records"), so the market it names has contributed nothing the pool would duplicate. Absence means eligible because §3 says "deviations require `inclusion_note` and set `deviated: true`" and the field is optional in `record.schema.json`. A `deviated` value that is present but **not a boolean** (a hand-edited `"true"`) counts as deviated and raises a `WARN`: `q3-verify.ts` classifies with bare truthiness, and the two tools must not disagree about which records are pilots.

Consequences, stated rather than left implicit:

- **This narrows the protocol's literal wording, and that is a live question.** §3 says "no existing record"; these rules read it as "no existing *primary-eligible* record", so a market named only by a deviated record is poolable. The justification is that the pool exists to produce primary-analysis records and a deviated one is excluded from that analysis by §8. If that reading is judged wrong, the correction is a numbered PROTOCOL amendment (v1.6) — never a line in this file, which never overrides the protocol. Nothing is foreclosed while it is open: zero `origin: pool` records exist, exactly as when v1.5 was pre-registered.
- **A re-audit still excludes.** Rule 2 keys on deviation, not on first-audit status, so a record carrying `supersedes` still contributes its id: the market it names has genuinely been audited. Only `deviated` suppresses an exclusion.
- **A pool record on a market some deviated record names is a first audit of a different narrative,** not a re-audit: PROTOCOL §2 binds one record to one *narrative* on one market, and the pool binds its own. It carries no `supersedes`. Should the pool ever surface the exact market **and** narrative of an existing record, that is a re-audit, `supersedes` is set, and §2 keeps it out of the primary regardless of this rule.
- **Venue records only.** A `venue: "series"` record (a Coinbase close) names no venue market and excludes nothing on either venue.
- **The Dune exclude parameter is narrower than the venue read.** Query 8601185's `exclude` takes condition ids; a slug means nothing to it. The day's JSON therefore carries `pool.polymarket.dune_exclude_condition_ids` — the subset of the exclusion set that is a `0x`+64-hex condition id — and that, not `excluded_from_book`, is what goes into the Dune run. A Polymarket record holding only a slug raises a `WARN` naming the gap: resolve the slug at `gamma-api.polymarket.com/markets?slug=…` before the Dune confirmation, or that market will not be excluded there.
- **Provenance both ways.** Top-level `book_exclusion` in each day's JSON carries `sources` (which record produced each excluded id), `records_excluding_nothing` (which records were skipped, and why), and `warnings`, so a reader sees the rule operating instead of taking it on assertion.

## 2. Ranking metric, disclosed per venue

| venue | record-bearing pool read | 24h volume unit |
|---|---|---|
| Polymarket | public Dune query `dune.json.pool_query_id` (8601185), `exclude` = `pool.polymarket.dune_exclude_condition_ids` from the day's JSON (§1.1) | USDC, single-counted taker legs (`SUM(amount)` on `is_taker_side`) |
| Kalshi | venue-direct read in `tape/discover.ts` (public API, no key) | **contracts** (`volume_24h_fp`) — the public API does not expose 24h USD volume; the Dune `kalshi.market_trades` USD ranking in `queries/kalshi_pool.sql` is plan-gated (v1.3.1) |

The Polymarket venue-direct read pages the top **1,000 open events by 24h volume** and stops there — a page cap, not the full open-event population, and the JSON flags it (`events_scanned_hit_cap`). Ranking by volume makes the cap harmless for a top-5, but it is a cap and is reported as one. The Kalshi read enumerates every open event. The Polymarket read (Gamma `volume24hr`, USD) is the day's candidate print only; the pool that enters a record is confirmed by re-running the Dune query. When the two disagree on membership, the Dune query decides and the discrepancy goes in the day's journal note.

## 3. A pool day

1. `npx tsx tests/q3/tape/discover.ts` — venue-direct pool for both venues always runs (0 credits, works in a remote container); Surf candidates, news and the macro-chain scan run only where the `surf` CLI is on PATH (`--venue-direct` skips Surf deliberately). Output: `tests/q3/discovery/YYYY-MM-DD.json` with the label sets used, the §1.1 exclusion set plus both provenance lists (`exclusion_sources`, `records_excluding_nothing`), counts scanned, the top-5 and the next-5.
2. Polymarket confirmation: run query 8601185 with `n=5` and `exclude` set to the day's `pool.polymarket.dune_exclude_condition_ids` (§1.1; empty while no primary-eligible Polymarket record exists). Needs `DUNE_API_KEY`, or re-run the public query in the Dune UI. Heed any `WARN` about a slug-only record first. Every returned row carries its `tags`; a row whose tags do not satisfy §1 is a bug in the SQL, not a pool member.
3. The pool for the day is the top-5 per venue after the §1.1 book exclusions. A pool market enters the book only as an `origin: pool` record under the protocol's normal Phase A/B; rule 3 keeps scan bindings outside the categories admissible.
4. Log the day: one journal row in `tests/q3/tape-journal.md` (Surf credits, or `0` for a venue-direct-only day) with the top-5 tickers/condition ids per venue in `notes`, and commit the discovery JSON.
5. Sports records, if ever logged, carry `inclusion_note: "sports stratum"` and never enter the primary (v1.5 rule 4).

## 4. Republishing the Polymarket pool query

`npx tsx tests/q3/dune-publish.ts --update` PATCHes the committed SQL onto 8601185, verifies the published text equals the file, and runs the contract checks: five rows, seven columns (`tags` added in v1.5), decimal token ids, the exclude path, and — new — **every row's `tags` satisfies §1**. Needs `DUNE_API_KEY` (Analyst plan). The first republish after the v1.5 SQL also confirms the stored format of `market_details.tags` (documented by Dune only as "Market category tags from the API"); the whole-word match was written to hold under either format, and the check is what proves it.

## 5. First pool day log

See the log appended below by the scan instance on the day the pool is first run.

### 2026-09-09 — first pool day (venue-direct; Surf not run — no CLI in this container). Discovery JSON: `tests/q3/discovery/2026-09-09.json`

**Re-logged after the §1.1 book-exclusion change** (market level only; primary-eligible sources only). This supersedes the print of this same day committed at `772b392` (PR #148), which was taken under the previous rule — book tickers matched at **event** level, and deviated records excluding. Earlier uncommitted prints of the day exist only in this session's history and are not retained. **None was acted on: no Phase A record was created from any of them,** and `tests/q3/records/` is unchanged since #148.

**Book exclusion this run: none, on either venue.** All three records in the book excluded nothing, each for a reason the JSON records:

| record | venue | ticker | why it excluded nothing |
|---|---|---|---|
| `q3-2026-09-02-N5` | kalshi | `KXFEDDECISION-26SEP` | `deviated: true` — not primary-eligible (rule 2). Its ticker is an event ticker, so rule 1 would drop no strike either. |
| `q3-2026-09-02-N2` | series | `COINBASE:BTC-USD monthly close` | `deviated: true`; `series` is also not a pooled venue |
| `q3-2026-09-04-N1` | series | `COINBASE:BTC-USD` | primary-eligible, but `series` is not a pooled venue |

The visible effect on the Kalshi pool: the September Fed-decision event has **five** strikes, and under the previous rule the pilot's event ticker dropped all five. Two are now in the top five, at ranks 1 and 4, and two more (`KXFEDDECISION-26SEP-C25`, `KXFEDDECISION-26SEP-H26`) sit at ranks 9 and 10.

Because both rules are exercised by no record in the book today, they were proven against the live reader with a temporary synthetic Polymarket record naming the rank-1 market by slug: marked `deviated: false` it dropped that market and rank 1 moved to `0x2e4b58fc…`; marked `deviated: true` it dropped nothing and rank 1 returned. The synthetic record was deleted; `tests/q3/records/` holds only the two real files.

Kalshi — 13,166 open events enumerated, 32,932 in-category active binary markets. Ranking metric: 24h contracts.

| # | ticker | category | 24h volume | last | market |
|---|---|---|---|---|---|
| 1 | `KXFEDDECISION-26SEP-H0` | Economics | 901,313 contracts | 0.45 | Will the Federal Reserve Hike rates by 0bps at their September 2026 meeting? |
| 2 | `CONTROLH-2026-D` | Elections | 608,009 contracts | 0.85 | Will Democrats win the House in 2026? |
| 3 | `SENATEME-26-D` | Elections | 573,690 contracts | 0.68 | Will Democratics win the Senate race in Maine? |
| 4 | `KXFEDDECISION-26SEP-H25` | Economics | 560,311 contracts | 0.56 | Will the Federal Reserve Hike rates by 25bps at their September 2026 meeting? |
| 5 | `KXBALANCEPOWERCOMBO-27FEB-RR` | Elections | 439,668 contracts | 0.17 | Will House Control be Republican AND Senate Control be Republican for Feb 2027? |

Next five: `KXGOVRINOMD-26-DMCK` (Elections, 367,670) · `CONTROLH-2026-R` (Elections, 327,976) · `SENATETX-26-R` (Elections, 319,368) · `KXFEDDECISION-26SEP-C25` (Economics, 278,489) · `KXFEDDECISION-26SEP-H26` (Economics, 228,073).

Polymarket (Gamma candidate print; Dune 8601185 decides membership once republished) — top **1,000** open events by 24h volume read, which is the page cap and was hit, so this is not the full open-event population; 3,470 in-category active markets among them.

| # | condition_id | tags (first three) | 24h volume | last YES | market |
|---|---|---|---|---|---|
| 1 | `0xa3b36b2d6104d34af4e6c6215fc818e43352e78a748fbfb0b85e3a35f71dec9a` | fomc, Economic Policy, Fed Rates | 1,284,318 USD | 0.465 | Will there be no change in Fed interest rates after the September 2026 meeting? |
| 2 | `0x2e4b58fc18dbffd74d5275d89fb076943f21992763c45dcadd81391b83bde13c` | fomc, Economic Policy, Fed Rates | 1,056,971 USD | 0.0065 | Will the Fed increase interest rates by 50+ bps after the September 2026 meeting? |
| 3 | `0x320a0116959f7573f87212ce61e323438862689cdb4dc5e38b3a9f0fbd1cbed4` | FDV, Biden, Crypto | 956,860 USD | 0.5 | LAPTOP FDV above $1B one day after launch? |
| 4 | `0x876506d8b2bd7a0d3fa4fe18c024eee6e1dd81ee24c26795dadd6cfe4a7b5d0d` | fomc, Economic Policy, Fed Rates | 793,631 USD | 0.525 | Will the Fed increase interest rates by 25 bps after the September 2026 meeting? |
| 5 | `0xac02cbb049e46d6a3627c0fdf52fa554982a9025d45968207b362acb6ca4b830` | fomc, Economic Policy, Fed Rates | 667,876 USD | 0.0035 | Will the Fed decrease interest rates by 25 bps after the September 2026 meeting? |

Next five: `0xa526fc83…` (FDV, 521,109) · `0x5c79dfde…` (Politics, 363,265) · `0x5e464d85…` (fomc, 342,174) · `0x42b633e7…` (Iran, 329,916) · `0x607ecc84…` (FDV, 302,614).

Four of the five Polymarket rows are strikes of one event (Fed Decision in September?); §3 ranks markets, not events, so this is the pool as written. Every sports, tennis, soccer and esports market that topped the unfiltered ranking on 2026-09-05 — the case v1.5 was written against — is absent from both tables.

**Surfaced as an open question, and ruled the same day.** Kalshi rank 5, `KXBALANCEPOWERCOMBO-27FEB-RR` ("House Control Republican **AND** Senate Control Republican"), is a conjunction that §1's operational combo rule admits: no `mve_collection_ticker`, `market_type: binary`. **The operator ruled that it stays in the pool** — membership is mechanical per PROTOCOL §3 and no semantic conjunction filter is added. The ruling is recorded as a decision in §1; nothing in the code changed, because the code was already correct.

**Not done, deliberately: no Phase A record was created from this pool.** Standing instruction — pool records wait until Dune is confirmed to have budget, because a venue record needs `price_at_audit` from the priced path and v1.3.1 prohibits an operator-typed price. The Dune republish of query 8601185 (§4) is also still owed, so Polymarket membership above is the Gamma print, not the confirmed pool.
