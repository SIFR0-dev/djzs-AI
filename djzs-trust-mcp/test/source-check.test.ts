/**
 * DJZS-SRC-v0.2 — offline test. Stub fetcher, no key, no network.
 *
 * Pins: citation extraction, claim binding, every status and its precedence, the verbatim gate on
 * proposed passages (a highlight that is not on the page never counts), exact-value figure matching,
 * fixed failure codes, and NON-SCORING: attaching the block through the x402 adapter leaves the
 * verdict, risk_score, flags and verdict_hash byte-identical.
 */
import {
  extractCitations, claimFor, figuresIn, confirmSpan, decideSource, runSourceCheck,
  buildFirecrawlFetcher, MAX_SOURCES, type FetchedPage, type PageFetcher,
  typedCallFor, renderRecord, decideTyped, buildFirecrawlTypedFetcher, SOURCE_CHECK_CONTRACT,
  type TypedFetcher, type TypedResult,
} from "../src/source-check"
import { createEngineAdapter } from "../src/engine-adapter"
import { sha256Hex } from "../../server/engine-v2/hash"

let ok = true
const check = (label: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  ok &&= pass
  console.log(`${pass ? "ok " : "BAD"} ${label}${pass ? "" : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`)
}

// ── citations ──────────────────────────────────────────────────────────────
check("extracts URLs in order, strips trailing punctuation, dedupes",
  extractCitations("Per https://a.example.com/x. Also (https://b.example.org/y?z=1), and https://a.example.com/x again."),
  ["https://a.example.com/x", "https://b.example.org/y?z=1"])
check("refuses loopback, bare IP and local hosts",
  extractCitations("http://localhost/a http://127.0.0.1/b http://printer.local/c https://ok.example.com/d"),
  ["https://ok.example.com/d"])
check("no URLs → none", extractCitations("Fed cuts in December, odds 70%."), [])

// ── claim binding ──────────────────────────────────────────────────────────
const INTENT = "Buy YES on the December cut. CME FedWatch shows 70% odds per https://news.example.com/fed-odds. Size $500. Out if CPI prints above 3.1%."
check("claim = the citing sentence, URL removed, dots inside the URL ignored",
  claimFor(INTENT, "https://news.example.com/fed-odds"), "CME FedWatch shows 70% odds per.")
check("URL alone on its line cites the whole intent",
  claimFor("Thesis: the cut is priced at 70%.\nhttps://news.example.com/x", "https://news.example.com/x"),
  "Thesis: the cut is priced at 70%.")

// ── figures ────────────────────────────────────────────────────────────────
check("figures: percent, thousands, decimals, small ints kept; bare years skipped",
  figuresIn("70% of 3 desks, $1,250,000 at 3.1 percent in 2026, 12 bps").map((f) => f.canonical),
  ["70%", "3", "1250000", "3.1%", "12"])

// ── verbatim span gate ─────────────────────────────────────────────────────
const PAGE = "# Fed odds\n\nTraders now see a **70%** probability of a December cut, according to [CME FedWatch](https://cme.example)."
check("a proposed passage on the page is confirmed",
  confirmSpan(PAGE, "Traders now see a 70% probability of a December cut"),
  "Traders now see a 70% probability of a December cut")
check("a proposed passage NOT on the page never counts (hallucinated highlight)",
  confirmSpan(PAGE, "Traders now see a 90% probability of a December cut"), null)
check("second of several passages confirmed when the first is invented (markdown bold and link normalized)",
  confirmSpan(PAGE, "An invented sentence that appears nowhere at all\nsee a 70% probability of a December cut, according to CME FedWatch"),
  "see a 70% probability of a December cut, according to CME FedWatch")

// ── decision: every status and precedence ──────────────────────────────────
const page = (over: Partial<FetchedPage>): FetchedPage => ({ ok: true, pageStatus: 200, markdown: PAGE, highlights: "", ...over })
const U = "https://news.example.com/fed-odds"
const claim = claimFor(INTENT, U)

const sup = decideSource(U, claim, page({ highlights: "Traders now see a 70% probability of a December cut" }))
check("supported: verbatim span + every figure on page", [sup.status, sup.figures_missing], ["supported", []])
check("source_sha256 is sha256 of the markdown read", sup.source_sha256, sha256Hex(PAGE))

const fig = decideSource(U, claim, page({ markdown: PAGE.replace("70%", "55%"), highlights: "Traders now see a 55% probability of a December cut" }))
check("figure_not_in_source beats a confirmed span", [fig.status, fig.figures_missing], ["figure_not_in_source", ["70%"]])

// The first live run (2026-11-20): a 519 KB page where "9" appears somewhere, but the passage says 4.
const LONG = "Each scrape consumes 1 credit. JSON mode costs 4 additional credits per page.\n" + "Step 9 of the guide. ".repeat(50)
const mm = decideSource(U, "Each scrape consumes 1 credit and JSON mode costs 9 additional credits per page.",
  page({ markdown: LONG, highlights: "Each scrape consumes 1 credit. JSON mode costs 4 additional credits per page." }))
check("span_figure_mismatch: figure is on the page but not in the passage the claim rests on", [mm.status, mm.figures_missing], ["span_figure_mismatch", ["9"]])
check("same page, true figure -> supported",
  decideSource(U, "Each scrape consumes 1 credit and JSON mode costs 4 additional credits per page.",
    page({ markdown: LONG, highlights: "Each scrape consumes 1 credit. JSON mode costs 4 additional credits per page." })).status, "supported")

check("percent matches its fraction on the page (70% ↔ 0.7)",
  decideSource(U, claim, page({ markdown: "Implied probability 0.7 for a cut in December per the model." })).status, "no_supporting_span")

check("no_supporting_span: page read, highlight not verbatim",
  decideSource(U, claim, page({ highlights: "something the page never said about the Fed at all" })).status, "no_supporting_span")

const dead = decideSource(U, claim, page({ pageStatus: 404 }))
check("unreachable on a 404 page, with a fixed code and no hash", [dead.status, dead.reason, dead.source_sha256], ["unreachable", "page_status_404", null])
check("unreachable on provider failure keeps the fixed code",
  decideSource(U, claim, { ok: false, pageStatus: null, markdown: "", highlights: "", reason: "timeout" }).reason, "timeout")
check("unreachable on an empty body",
  decideSource(U, claim, page({ markdown: "   " })).reason, "empty_page")

// ── orchestration ──────────────────────────────────────────────────────────
const stub = (fn: (url: string) => FetchedPage): PageFetcher => async (url) => fn(url)
const noCite = await runSourceCheck("Fed cuts in December, odds 70%, no link.", stub(() => page({})))
check("no citations → status no_citations, empty checks", [noCite.status, noCite.checks.length, noCite.scored], ["no_citations", 0, false])

const noKey = await runSourceCheck(INTENT, null)
check("no key → not_configured, each citation not_checked", [noKey.status, noKey.checks.map((c) => c.status)], ["not_configured", ["not_checked"]])

const many = Array.from({ length: MAX_SOURCES + 2 }, (_, i) => `Claim ${"ABCDEFGH"[i]} is 42% per https://s${i}.example.com/p.`).join(" ")
const capped = await runSourceCheck(many, stub(() => page({ markdown: "The figure is 42% on this page." })))
check("cap: first MAX_SOURCES checked, rest over_cap",
  capped.checks.map((c) => c.reason ?? c.status),
  [...Array(MAX_SOURCES).fill("no_supporting_span"), "over_cap", "over_cap"])

const throwing: PageFetcher = async () => { throw new Error("secret-bearing raw error text") }
const err = await runSourceCheck(INTENT, throwing)
check("a throwing fetcher never throws out, never leaks text", [err.status, JSON.stringify(err).includes("secret-bearing")], ["error", false])

// ── Firecrawl fetcher: request shape and fixed codes (fake fetch) ───────────
let sent: Record<string, unknown> = {}
const fakeFetch = (async (_u: string, init: RequestInit) => {
  sent = JSON.parse(String(init.body))
  return new Response(JSON.stringify({ success: true, data: { markdown: PAGE, highlights: "x", metadata: { statusCode: 200 } } }), { status: 200 })
}) as unknown as typeof fetch
const fetched = await buildFirecrawlFetcher("fc-test", fakeFetch)(U, "q")
check("fetcher: maxAge 0 (never cached), not stored, markdown + highlights",
  [sent.maxAge, sent.storeInCache, (sent.formats as unknown[])[0], ((sent.formats as Record<string, unknown>[])[1]).type],
  [0, false, "markdown", "highlights"])
check("fetcher: parses page status and body", [fetched.ok, fetched.pageStatus, fetched.markdown === PAGE], [true, 200, true])
const http402 = await buildFirecrawlFetcher("fc-test", (async () => new Response("no credits: key fc-test", { status: 402 })) as unknown as typeof fetch)(U, "q")
check("fetcher: provider HTTP error → fixed code, no body text", [http402.ok, http402.reason], [false, "provider_http_402"])

// ── v0.2: page provenance ───────────────────────────────────────────────────
check("contract is v0.2", SOURCE_CHECK_CONTRACT, "DJZS-SRC-v0.2")
const moved = decideSource(U, claim, page({ highlights: "Traders now see a 70% probability of a December cut", finalUrl: "https://news.example.com/fed-odds/dec", servedBy: null, fetchedAt: "2026-11-22T21:00:00.000Z" }))
check("page route records the redirect target and the fetch time",
  [moved.route, moved.resolved_url, moved.fetched_at], ["page", "https://news.example.com/fed-odds/dec", "2026-11-22T21:00:00.000Z"])
check("no redirect → resolved_url null", decideSource(U, claim, page({ finalUrl: U })).resolved_url, null)
check("a provider-served page (X post) names its provider",
  decideSource("https://x.com/a/status/1", "per.", page({ servedBy: "x-com" })).served_by, "x-com")
let sentMeta: FetchedPage | null = null
sentMeta = await buildFirecrawlFetcher("fc-test", (async () => new Response(JSON.stringify({ success: true, data: { markdown: PAGE, metadata: { statusCode: 200, url: "https://final.example.com/p", provider: { id: "x-com" } } } }), { status: 200 })) as unknown as typeof fetch)(U, "q")
check("fetcher: reads metadata.url and metadata.provider.id, stamps fetchedAt",
  [sentMeta.finalUrl, sentMeta.servedBy, typeof sentMeta.fetchedAt], ["https://final.example.com/p", "x-com", "string"])

// ── v0.2: typed routes — URL → lookup (pure) ────────────────────────────────
const PM_URL = "https://polymarket.com/event/fed-decision-in-december-20260729232808632"
const PM_HIKE = "will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636"
check("polymarket event URL → events/by-slug",
  typedCallFor(PM_URL), { route: "typed:polymarket", provider: "polymarket", capability: "events/by-slug", options: { slug: "fed-decision-in-december-20260729232808632" } })
check("polymarket URL naming one market keeps the market slug", typedCallFor(`https://www.polymarket.com/event/fed-x/${PM_HIKE}?tid=1`)?.marketSlug, PM_HIKE)
check("fred series URL → series/observations, id upper-cased, newest first",
  typedCallFor("https://fred.stlouisfed.org/series/unrate"), { route: "typed:fred", provider: "fred", capability: "series/observations", options: { series_id: "UNRATE", sort_order: "desc", limit: 60 } })
check("everything else takes the page route",
  ["https://polymarket.com/", "https://polymarket.com/predictions/fed", "https://fred.stlouisfed.org/graph/?g=1", "https://kalshi.com/markets/kxfed", "https://evil.example.com/event/x", "not a url"].map(typedCallFor),
  [null, null, null, null, null, null])

// Record shapes as the providers returned them live on 2026-11-22 (fields trimmed, values unchanged).
const PM_EVENT = {
  title: "Fed Decision in December?",
  markets: [
    { slug: "no-change", groupItemTitle: "No change", question: "Will there be no change?", outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"0.0645\", \"0.9355\"]" },
    { slug: PM_HIKE, groupItemTitle: "25 bps increase", question: "Will the Fed increase by 25 bps?", outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"0.905\", \"0.095\"]" },
  ],
}
const FRED_OBS = { observations: [{ date: "2026-10-01", value: "4.1" }, { date: "2026-09-01", value: "4.2" }, { date: "2026-08-01", value: "." }] }
const pmCall = typedCallFor(PM_URL)!
const fredCall = typedCallFor("https://fred.stlouisfed.org/series/UNRATE")!
const good = (data: unknown): TypedResult => ({ ok: true, data, upstreamStatus: 200, fetchedAt: "2026-11-22T21:51:00.000Z" })

check("polymarket record renders one line per market: exact percent, raw price, and the venue's rounded display",
  renderRecord(pmCall, PM_EVENT).map((l) => l.text),
  ["Polymarket | Fed Decision in December? | No change: Yes 6.45% (price 0.0645, shown as 6%), No 93.55% (price 0.9355, shown as 94%)",
   "Polymarket | Fed Decision in December? | 25 bps increase: Yes 90.5% (price 0.905, shown as 91%), No 9.5% (price 0.095, shown as 10%)"])
check("a URL naming one market renders only that market",
  renderRecord({ ...pmCall, marketSlug: PM_HIKE }, PM_EVENT).length, 1)
check("fred: missing observation '.' is skipped, never read as zero",
  renderRecord(fredCall, FRED_OBS).map((l) => l.text), ["FRED UNRATE observation 2026-10-01: 4.1", "FRED UNRATE observation 2026-09-01: 4.2"])
check("an unknown record shape renders nothing", [renderRecord(pmCall, { markets: "x" }), renderRecord(fredCall, null), renderRecord(pmCall, [])], [[], [], []])

// ── v0.2: typed decision (pure, no model) ───────────────────────────────────
const t91 = decideTyped(PM_URL, "Polymarket has the hike at 91% per.", pmCall, good(PM_EVENT))!
check("typed supported: the venue's displayed 91% is in the record; span is the market line",
  [t91.status, t91.route, t91.served_by, t91.resolved_url, t91.fetched_at, t91.span?.includes("25 bps increase"), t91.figures_missing],
  ["supported", "typed:polymarket", "polymarket", null, "2026-11-22T21:51:00.000Z", true, []])
check("typed source_sha256 = sha256 of the rendered record lines",
  t91.source_sha256, sha256Hex(renderRecord(pmCall, PM_EVENT).map((l) => l.text).join("\n")))
const t70 = decideTyped(PM_URL, "Polymarket has the hike at 70% per.", pmCall, good(PM_EVENT))!
check("typed figure_not_in_source: no market in the record is at 70%", [t70.status, t70.figures_missing, t70.span], ["figure_not_in_source", ["70%"], null])
check("raw price and cents forms both match (0.905, 9.5c shown as 10)",
  [decideTyped(PM_URL, "YES trades at 0.905 per.", pmCall, good(PM_EVENT))!.status, decideTyped(PM_URL, "NO is 10 cents per.", pmCall, good(PM_EVENT))!.status],
  ["supported", "supported"])
check("a whole-number claim is never matched by a fractional price (1 is not 0.905 or 0.9355)",
  decideTyped(PM_URL, "I hold 1 share per.", pmCall, good(PM_EVENT))!.status, "figure_not_in_source")
check("typed with no figure in the claim confirms nothing",
  decideTyped(PM_URL, "The market agrees with me per.", pmCall, good(PM_EVENT))!.status, "no_supporting_span")
const f41 = decideTyped("https://fred.stlouisfed.org/series/UNRATE", "Unemployment is 4.1% per.", fredCall, good(FRED_OBS))!
check("fred supported: latest observation carries the figure", [f41.status, f41.span], ["supported", "FRED UNRATE observation 2026-10-01: 4.1"])
check("fred: rounds at the claim's stated precision (4% ← 4.1 and 4.2; 4.3% ← nothing)",
  [decideTyped("u", "Unemployment is about 4% per.", fredCall, good(FRED_OBS))!.status, decideTyped("u", "Unemployment is 4.3% per.", fredCall, good(FRED_OBS))!.status],
  ["supported", "figure_not_in_source"])
check("fred: the missing '.' observation never supports a 0 claim",
  decideTyped("u", "Unemployment is 0% per.", fredCall, good(FRED_OBS))!.status, "figure_not_in_source")
check("a failed or unusable typed lookup decides nothing (→ page route)",
  [decideTyped(PM_URL, "x 91% per.", pmCall, { ok: false, data: null, upstreamStatus: null, reason: "timeout" }), decideTyped(PM_URL, "x 91% per.", pmCall, good({ markets: [] }))], [null, null])

// ── v0.2: orchestration — typed first, page on any failure ──────────────────
const PM_INTENT = `Buy YES on the hike. Polymarket prices it at 91% per ${PM_URL}. Out if CPI prints under 0.2%.`
let pageCalls = 0
const countingPage = stub(() => { pageCalls++; return page({ markdown: "The hike is priced at 91% today on this page.", highlights: "The hike is priced at 91% today on this page." }) })
const typedOk: TypedFetcher = async () => good(PM_EVENT)
const viaTyped = await runSourceCheck(PM_INTENT, countingPage, typedOk)
check("typed route answers without fetching the page (no LLM step, no page credit)",
  [viaTyped.checks[0].route, viaTyped.checks[0].status, pageCalls, viaTyped.contract], ["typed:polymarket", "supported", 0, "DJZS-SRC-v0.2"])
const typedDown: TypedFetcher = async () => ({ ok: false, data: null, upstreamStatus: null, reason: "provider_http_403" })
const fellBack = await runSourceCheck(PM_INTENT, countingPage, typedDown)
check("typed failure falls back to the page and says why with a fixed code",
  [fellBack.checks[0].route, fellBack.checks[0].status, fellBack.checks[0].typed_error, pageCalls], ["page", "supported", "provider_http_403", 1])
const typedThrows: TypedFetcher = async () => { throw new Error("secret-bearing raw error text") }
const threw = await runSourceCheck(PM_INTENT, countingPage, typedThrows)
check("a throwing typed fetcher falls back, never leaks text",
  [threw.checks[0].route, threw.checks[0].typed_error, JSON.stringify(threw).includes("secret-bearing")], ["page", "fetch_failed", false])
const v01 = await runSourceCheck(PM_INTENT, countingPage)
check("no typed fetcher → page route, no typed_error (v0.1 behavior)", [v01.checks[0].route, "typed_error" in v01.checks[0]], ["page", false])
check("non-typed URLs never call the typed fetcher",
  (await runSourceCheck(INTENT, stub(() => page({})), typedThrows)).checks[0].typed_error, undefined)
check("no key: a typed-eligible citation still reports its route, not_checked",
  (await runSourceCheck(PM_INTENT, null)).checks.map((c) => [c.status, c.route]), [["not_checked", "typed:polymarket"]])

// ── v0.2: typed fetcher — request shape and fixed codes (fake fetch) ────────
let typedSent: Record<string, unknown> = {}
const typedFake = (async (_u: string, init: RequestInit) => {
  typedSent = JSON.parse(String(init.body))
  return new Response(JSON.stringify({ success: true, data: { alexandria: [{ provider: "fred", capability: "series/observations", data: FRED_OBS, upstreamStatus: 200 }], creditsCost: 1 } }), { status: 200 })
}) as unknown as typeof fetch
const typedGot = await buildFirecrawlTypedFetcher("fc-test", typedFake)(fredCall)
check("typed fetcher: sends only the provider call (no url, no formats)",
  [typedSent.alexandria, "url" in typedSent, "formats" in typedSent],
  [{ provider: "fred", capability: "series/observations", options: { series_id: "UNRATE", sort_order: "desc", limit: 60 } }, false, false])
check("typed fetcher: returns the record untouched", [typedGot.ok, typedGot.upstreamStatus, JSON.stringify(typedGot.data) === JSON.stringify(FRED_OBS)], [true, 200, true])
const mk = (body: unknown, status = 200) => buildFirecrawlTypedFetcher("fc-test", (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch)(fredCall)
check("typed fetcher: every failure is a fixed code, never body text",
  [(await mk("terms required for key fc-test", 403)).reason, (await mk({ success: true, data: { alexandria: [{ error: { code: "X", message: "fc-test" } }] } })).reason,
   (await mk({ success: true, data: {} })).reason, (await mk({ success: true, data: { alexandria: [{}] } })).reason, (await mk("not json")).reason],
  ["provider_http_403", "provider_error", "provider_bad_response", "provider_no_record", "fetch_failed"])

// ── NON-SCORING through the x402 adapter: verdict path byte-identical ───────
const F = (state: string, value?: unknown, quote?: string) =>
  state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state }
const extraction = {
  audit_context: "prediction_market", agent_type: "trader", intended_action: "open", market_type: "prediction",
  resolution_engagement: F("present", "the cut decision itself"), probability_basis: F("present", "CME FedWatch 70%"),
  edge_claim: F("unknown"), invalidation_condition: F("present", "CPI above 3.1%"), data_sources: F("present", ["CME"]),
  oracle_source: F("unknown"), confidence: F("unknown"), leverage: F("unknown"), position_size: F("present", 500),
  stop_loss: F("unknown"), take_profit: F("unknown"),
}
const model = async () => JSON.stringify(extraction)
const withoutKey = await createEngineAdapter({ ANTHROPIC_API_KEY: "x" }, model).audit(INTENT)
const origFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { markdown: PAGE.replace("70%", "55%"), highlights: "", metadata: { statusCode: 200 } } }), { status: 200 })) as unknown as typeof fetch
const withKey = await createEngineAdapter({ ANTHROPIC_API_KEY: "x", FIRECRAWL_API_KEY: "fc-test" }, model).audit(INTENT)
globalThis.fetch = origFetch
const core = (r: Record<string, unknown>) => ({ v: r.verdict, s: r.risk_score, f: r.flags, h: r.verdict_hash, i: r.intent_sha256, t: r.tally })
check("adapter: verdict, risk, flags, verdict_hash, intent_sha256, tally identical with and without the source check",
  core(withKey as unknown as Record<string, unknown>), core(withoutKey as unknown as Record<string, unknown>))
check("adapter: a contradicted source is reported beside the verdict, not inside it",
  [(withKey as { sources?: { checks: { status: string }[] } }).sources?.checks.map((c) => c.status), withKey.verdict === withoutKey.verdict],
  [["figure_not_in_source"], true])

console.log(ok ? "\nALL OK" : "\nFAILURES")
process.exit(ok ? 0 : 1)
