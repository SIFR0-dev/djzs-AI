# Q3 SCAN_SPEC — operating rules for the scan instance

`PROTOCOL.md` is the pre-registered protocol and is amended only by numbered versions. This file is the **operating spec**: how the scan instance executes the protocol day to day. It never overrides the protocol; when they disagree, the protocol wins and this file is corrected. Rule references below are to `PROTOCOL.md`.

## 1. §3 coverage pool — category implementation (v1.5 rules 1–2, v1.8)

v1.5 rule 1: the pool is top-N (N = 5) by 24h volume **within the scan's categories — economics, rates and central banks, crypto, domestic politics, geopolitics — per venue**; sports, esports, entertainment and weather are excluded. Rule 2: the exact venue labels are committed in code, so the mapping is inspectable and re-executable. The committed label sets are:

| venue | field | INCLUDE (any) | EXCLUDE (wins over include) | committed in |
|---|---|---|---|---|
| Polymarket | `polymarket_polygon.market_details.tags` (Dune) = Gamma event tags, 3–7 per market | `Politics` · `Elections` · `Geopolitics` · `World` · `Economy` · `Fed` · `Finance` · `Crypto` | v1.5: `Sports` · `Esports` · `Culture` · `entertainment` · `Weather` — v1.8: `Recurring` · `Up` · `Down` · `5M` · `15M` · `1H` · `4H` | `lib.ts` (`POOL_TAGS_INCLUDE` / `POOL_TAGS_EXCLUDE` + `poolTagsAdmit`, the single definition) · `queries/polymarket_pool.sql` header (same strings, same matching rule) · `tape/discover.ts` and `dune-publish.ts` (both call the shared matcher) |
| Kalshi | `event.category` (public API, one per event; markets inherit) | `Economics` · `Financials` · `Crypto` · `Politics` · `Elections` · `World` | every other label — observed open on 2026-09-09: `Sports` · `Entertainment` · `Climate and Weather` · `Companies` · `Science and Technology` · `Mentions` · `Health` · `Social` · `AI` · `Transportation` · `Business` | `tape/discover.ts` (`KALSHI_POOL_CATEGORIES`) |
| Surf (tape only) | Surf category enum | `economics` · `financials` · `crypto` · `politics` | `sports` · `culture` · `stem` | `tape/config.json` |

Mapping decisions, recorded:
- **Matching rule (Polymarket): array containment on whole tags, both sides lower-cased.** Never a substring or word-boundary regex. The tag set is non-positional, mixed case, 3–7 per market, and carries non-ASCII, and v1.8's exclusions include the bare tags `Up`, `Down` and `1H` — a boundary regex fires on those inside unrelated text (`Blow Up`), while containment matches only the whole tag. Tags reach the tooling three ways (a real array from Gamma, a JSON-array string, a comma-delimited string from Dune) and `normalizeTags` folds all three to lower-cased whole tags, so the match holds under any stored form. A market carrying any EXCLUDE tag is out even if it also carries an INCLUDE tag: a sports market tagged `Politics` is still sports.
- **Unclassifiable = out.** A Polymarket market with no `market_details` row yet (the API snapshot lags chain) has no tags; it is not in the pool until the snapshot catches up. Showing it as in-category would be an assertion, which rule 2 forbids.
- **v1.8 — venue-native recurrence is out of the pool.** `Recurring`, `Up`, `Down` and the interval tags `5M` `15M` `1H` `4H` reject a candidate. The ground is a precondition of the study rather than a preference: a contract that opens and resolves inside minutes admits no public narrative to audit before the outcome is known. It is checkable from the venue's own tags, so the excluder never judges a market's content. Scan bindings are unaffected — a narrator who does state a thesis on such a contract may still bind it.
- **v1.8 has no Kalshi mechanism, and that is a gap worth naming.** The amendment is written against a tag set; Kalshi publishes categories, not tags, so nothing in the Kalshi read implements it. Hourly and 15-minute strike ladders (`KXBTCD-…`, `KXBTC15M-…`) therefore remain poolable on Kalshi while their Polymarket equivalents are excluded. Closing it would mean matching ticker patterns, which is exactly the content judgement v1.8 avoids, so it is left open for a ruling rather than invented here.
- **Financials.** Index/equity contracts (`Financials` on Kalshi, `Finance` on Polymarket) are admitted: `tape/config.json` already maps Surf's `financials` into the pool and `index-bind.ts` treats Kalshi index contracts as bindable. Rates/central-bank contracts sit under `Economics`/`Economy`/`Fed` on both venues (verified live: KXFED, KXCPI → `Economics`; the Fed Decision event → `Fed`, `Economy`).
- **Geopolitics.** Kalshi has no geopolitics label; its `World` and `Politics` categories carry it. Polymarket has `Geopolitics` and `World`.
- **Kalshi combos.** Multivariate combo/parlay markets (`mve_collection_ticker` set, or `market_type` other than `binary`) are not pool markets; only `status: active` binary markets rank.
- **A semantically conjunctive market stays in the pool (operator ruling, 2026-09-09).** `KXBALANCEPOWERCOMBO-27FEB-RR` ("House Control Republican **AND** Senate Control Republican") reached rank 5 of that day's Kalshi pool. It carries no `mve_collection_ticker` and is `market_type: binary`, so the combo rule above admits it. **Ruled: it stays.** Pool membership is mechanical per PROTOCOL §3 — top-N by 24h volume within the categories — and no semantic conjunction filter is added. The combo rule above is the whole test; it screens the venue's multivariate instruments, not the English of a question. Reading conjunctions out of the pool by hand would make membership a judgement call, which is exactly what §3 removes. Do not add such a filter without a numbered PROTOCOL amendment.
- **The two tables join on normalized hex, and trades are aggregated first.** `market_trades.condition_id` is VARBINARY; `market_details.condition_id` is a `0x`-prefixed lowercase hex VARCHAR, so the only correct comparison is `lower(md.condition_id) = '0x' || lower(to_hex(t.condition_id))`. `market_details` is one row per outcome token per snapshot, so joining trades to it directly fans every trade ×2 on a binary and ×N on a multi-outcome market — inflating pool volume in proportion to outcome count, which is a selection bias, not a rounding error. The pool query therefore aggregates trades to one row per condition before any join, and collapses `market_details` to one row per condition (`max_by` on `last_changed_at`) before joining, so both sides are one row per market by construction.
- **Changing a label** is a rule-2 event: change it in `lib.ts` and the SQL header in the same commit, and put the exact strings in the commit message.

### 1.1 Book exclusion — which records exclude which markets

**PROTOCOL v1.6 settles what counts as an existing record.** §3 words the pool as "the top-N markets by 24h volume **that have no existing record**"; v1.6 reads that exclusion as primary-eligible records only, fixes it at market level, and fixes how identifiers are compared. This section is the *implementation* of v1.6, not a reading of §3 — where the two could differ, the amendment governs. Both rules live in `tape/discover.ts` (`bookExclusions`), and every run prints them and writes them to the day's JSON under `book_exclusion`.

1. **Market level only.** Only a market's own id is ever compared; no event-level id is. On Kalshi that is the record's `market.ticker`. On Polymarket it is the Gamma **market slug** carried in `market.ticker` (optionally `polymarket:`-prefixed — `q3-log.ts` Phase A and `q3-grade.ts` both resolve it with `/markets?slug=`, and PROTOCOL pre-registers that a venue ticker must resolve in Phase A), plus a `condition_id` alias if a hand-written record carries one. The pool reader ranks Polymarket on `conditionId`, so it compares **both** the candidate's condition id and its market slug — the event slug is never compared. A record whose ticker names a parent **event** therefore drops only a market of that exact id, never the event's other strikes: the pilot `q3-2026-09-02-N5` carries `KXFEDDECISION-26SEP`, an event ticker whose corrected market ticker PROTOCOL's v1.3.1 finding gives as `KXFEDDECISION-26SEP-H25`, and it drops no strike.
2. **Primary-eligible sources only.** Only a record with `deviated` absent or `false` excludes anything; a deviated record excludes nothing. It sits outside the primary analysis (PROTOCOL §8, "Pilot records"), so the market it names has contributed nothing the pool would duplicate. Absence means eligible because §3 says "deviations require `inclusion_note` and set `deviated: true`" and the field is optional in `record.schema.json`. A `deviated` value that is present but **not a boolean** (a hand-edited `"true"`) counts as deviated and raises a `WARN`: `q3-verify.ts` classifies with bare truthiness, and the two tools must not disagree about which records are pilots.

Consequences, stated rather than left implicit:

- **A market named only by a deviated record is poolable, and that is protocol.** v1.6 states it directly: "records with deviated: true exclude nothing, since a deviated record never enters the primary." This file no longer argues the point; it implements it. The amendment was appended with the guard it names checked at append time — zero `origin: pool` records existed, exactly as when v1.5 was pre-registered.
- **A re-audit still excludes.** Rule 2 keys on deviation, not on first-audit status, so a record carrying `supersedes` still contributes its id: the market it names has genuinely been audited. Only `deviated` suppresses an exclusion.
- **A pool record on a market some deviated record names is a first audit of a different narrative,** not a re-audit: PROTOCOL §2 binds one record to one *narrative* on one market, and the pool binds its own. It carries no `supersedes`. Should the pool ever surface the exact market **and** narrative of an existing record, that is a re-audit, `supersedes` is set, and §2 keeps it out of the primary regardless of this rule.
- **Venue records only.** A `venue: "series"` record (a Coinbase close) names no venue market and excludes nothing on either venue.
- **The Dune exclude parameter is narrower than the venue read.** Query 8601185's `exclude` takes condition ids; a slug means nothing to it. The day's JSON therefore carries `pool.polymarket.dune_exclude_condition_ids` — the subset of the exclusion set that is a `0x`+64-hex condition id — and that, not `excluded_from_book`, is what goes into the Dune run. A Polymarket record holding only a slug raises a `WARN` naming the gap: resolve the slug at `gamma-api.polymarket.com/markets?slug=…` before the Dune confirmation, or that market will not be excluded there.
- **Provenance both ways.** Top-level `book_exclusion` in each day's JSON carries `sources` (which record produced each excluded id), `records_excluding_nothing` (which records were skipped, and why), and `warnings`, so a reader sees the rule operating instead of taking it on assertion.

## 2. Ranking metric, disclosed per venue

| venue | record-bearing pool read | 24h volume unit |
|---|---|---|
| Polymarket | public Dune query `dune.json.pool_query_id` (8601185), `exclude` = `pool.polymarket.dune_exclude_condition_ids` from the day's JSON (§1.1) | **`SUM(shares)`** over single-counted taker legs — $1 of notional per share, the same convention §5 fixes for the record fields and the one Gamma publishes. Was `SUM(amount)` (premium) until v1.8; the output column keeps the name `volume_24h_usdc` for contract stability |
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

## 5. Liquidity at audit — v1.7(a) unit convention, sources, and schedules

v1.7(a) puts the bound market's traded volume on every record sealed after the amendment, alongside `price_at_audit`: `volume_24h` (traded USD notional in the 24 hours ending at `posted_at`) and `volume_total` (cumulative traded USD notional to `posted_at`). Both come from the same trade data and the same source tier as the VWAP, so a verifier reproduces them exactly as it reproduces the price.

### The unit, stated explicitly: $1 of notional per contract or share

**One convention on both venues.** A Kalshi contract and a Polymarket share each settle at $1, so the count of contracts or shares traded **is** the traded USD notional. Kalshi fixes this itself — the market object carries `notional_value_dollars: "1.0000"`. This is the number both venues publish as their volume, and it is the number the §3 pool ranks on, which matters because v1.7(b) calibrates its 25,000 USD threshold by observing that the pool "has sat entirely above it".

**It is not premium.** Premium, Σ(price × size), is a different quantity: it is the cash that changed hands, and it scales with the price level. Measured 2026-09-10 against each venue's own published figure:

| venue | our number | venue-published | ratio |
|---|---|---|---|
| Kalshi `KXFEDDECISION-26SEP-H26` (YES 0.01) | 244,200 | `volume_24h_fp` 244,311 | 1.000 |
| Kalshi `KXFEDDECISION-26SEP-H0` (near even) | 891,898 | `volume_24h_fp` 889,400 | 1.003 |
| Polymarket Fed +50bps (YES 0.007) | Σ(size) 1,110,705 | `volume24hr` 1,110,705 | 1.000 |
| Polymarket Fed no-change (YES 0.46) | Σ(size) 1,394,891 | `volume24hr` 1,362,945 | 1.023 |
| Polymarket LAPTOP FDV (YES 0.32) | Σ(size) 1,088,898 | `volume24hr` 1,093,041 | 0.996 |

Σ(price × size) on the same three Polymarket markets came to ratios of 0.027, 0.494 and 0.391 against the published figure — it tracks the price, as a premium measure does, and is not what either venue means by volume. Two further reasons the notional convention is the right one here: a premium number is monotone in price level, so v1.7(b)'s thin stratum would be partly a restatement of the quote it exists to control for; and a premium number would put a lopsided strike below the threshold purely because its quote is a penny, while the venue reports it as deep.

### Sources per venue

| venue | source | computed as | reproduced by |
|---|---|---|---|
| Polymarket | the **same** execution of the price query that returns the VWAP — v1.7(a) adds no additional Dune executions | `SUM(shares)` over taker legs on the market's `condition_id`, resolved from `token_id` through `market_details` | re-running the public query with the record's `price_source.query_params` |
| Kalshi | the public trades endpoint, the same per-fill history the VWAP is computed from (`kalshiVolumes` in `kalshi-client.ts`) | Σ(`count_fp`) over fills | re-fetching the same ticker and window and recomputing |
| series | none — a series binding names no venue market | `null`, per v1.7(a) | n/a |

### Two schedules, on purpose

- **`volume_24h` keeps the price's schedule.** It rides the price re-fetch: the Dune column arrives with the price execution, and the Kalshi 24-hour window is one page.
- **`volume_total` is checked at seal and on its first weekly pass only.** Its window ends at `posted_at` over settled trades, so it is immutable once `posted_at` is past, and it is sealed in `record_hash`. Re-running it weekly re-answers a settled question. The check fires on the commit that adds the record (records changed, so the re-verification is forced) and then once more on the first weekly full pass, bounded by an 8-day window — the weekly cadence plus a margin, so exactly one scheduled run catches a given record and none after it. On Kalshi this skips the full-history page walk outright: measured on a live market, 25 pages and 24,915 fills drop to 1 page and 886 fills, with `volume_24h` unchanged. On Dune the column rides the price execution either way, so the saving there is nil and the rule is applied only so there is one rule rather than two.

### Decisions this implementation makes

- **Scope is the market, not the audited side.** Polymarket sums both outcome tokens by resolving `token_id` to its `condition_id`; Kalshi sums every fill on the ticker. The notional convention is price- and side-neutral by construction, so two records on opposite sides of one market carry the same volume, which is what "the bound market's traded volume" means.
- **A number is never fabricated to fill the field, and a zero that cannot be true is treated as a missing one.** Phase B *refuses to seal* rather than write a wrong or ambiguous volume. On Polymarket that covers a token `market_details` cannot resolve (the query returns NULL, not 0) and a market-wide total of zero while the audited token just traded, which can only mean the `condition_id` join matched nothing. On Kalshi it covers a truncated page walk, an empty fill history, a fill whose size cannot be read, and a total that sums to zero — the price gate has already proven fills exist in a window inside the same range, so zero is not a possible true answer. Every refusal names its cause and leaves the record unsealed for a rerun. `null` stays reserved for series bindings and for records sealed before v1.7.
- **Absence is not a verification failure, but a null on a post-amendment record is.** Records sealed before the amendment carry neither field, and sealed records are immutable, so `q3-verify` skips them. A record that *does* carry the keys is held to v1.7(a) categorically: a sealed venue record must have both non-null, a sealed series record must have both null. On re-check, a numeric disagreement fails; a recomputation that returns NULL warns, on the outage-is-not-mismatch rule the price side uses; and a query that no longer returns the column at all fails, because that is a contract break rather than a known unknown.
- **Hashing.** The two fields are sealed at Phase B, so they sit inside `record_hash` and are excluded from `phase_a_hash` exactly as `price_at_audit` is. Adding their names to `PHASE_A_EXCLUDE` cannot disturb an existing hash: `strip()` removes keys by name, and a record that never carried the key canonicalises identically either way.
- **An invariant worth asserting.** `volume_total >= volume_24h` always, since the total is cumulative to the same instant the 24-hour window ends at. The verifier and the publish check both assert it.

**No volume filter exists anywhere, and none may be added here.** v1.7 is explicit: liquidity is recorded and stratified, never filtered; §3's coverage pool is unchanged and scan bindings stay unconstrained by volume. The 25,000 USD threshold in v1.7(b) is an **analysis** stratum for §6 of the protocol, not a selection rule — nothing in `discover.ts`, the pool query, or Phase A reads it. A filter added mid-study would change what the study covers, and coverage was pre-registered.

**Settled, not owed.** The pool query previously ranked on `SUM(amount)`; it now ranks on `SUM(shares)`, so the pool's selection metric, the record's `volume_24h` and Gamma's published `volume24hr` are one measure. That matters because v1.7(b)'s calibration is stated against the pool's own selection metric. The `amount`-versus-`shares` divergence was confirmed row by row at 0.44–0.62 as well as in aggregate.

## 6. First pool day log

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
