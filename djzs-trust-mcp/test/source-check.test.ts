/**
 * DJZS-SRC-v0.1 — offline test. Stub fetcher, no key, no network.
 *
 * Pins: citation extraction, claim binding, every status and its precedence, the verbatim gate on
 * proposed passages (a highlight that is not on the page never counts), exact-value figure matching,
 * fixed failure codes, and NON-SCORING: attaching the block through the x402 adapter leaves the
 * verdict, risk_score, flags and verdict_hash byte-identical.
 */
import {
  extractCitations, claimFor, figuresIn, confirmSpan, decideSource, runSourceCheck,
  buildFirecrawlFetcher, MAX_SOURCES, type FetchedPage, type PageFetcher,
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
