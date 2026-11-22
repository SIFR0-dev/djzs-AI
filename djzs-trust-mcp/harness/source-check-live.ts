/**
 * Live probe for the source check (DJZS-SRC-v0.2). DJ-terminal tool.
 *
 * Runs the same module the Worker runs (src/source-check.ts) straight against Firecrawl with your key.
 * No Worker, no payment, no extraction key, nothing anchored. It answers the questions the offline test
 * cannot: does the typed request go through with THIS key, are data providers enabled for its team, and
 * what do a redirecting page and an X post come back as.
 *
 * Each typed probe reads the record first, then builds a claim from a number the record itself shows,
 * so "supported" is expected whatever the market or the series says today. A second, false claim must
 * read figure_not_in_source.
 *
 * Run from djzs-trust-mcp/ (.dev.vars needs FIRECRAWL_API_KEY; the key is never printed):
 *   npx tsx --env-file=.dev.vars harness/source-check-live.ts
 *   npx tsx --env-file=.dev.vars harness/source-check-live.ts --pm-url https://polymarket.com/event/<slug>
 *   npx tsx --env-file=.dev.vars harness/source-check-live.ts --typed-only
 * Cost: about 2 Firecrawl credits with --typed-only, about 25 for the full run.
 * Exit: 0 every required probe as expected; 2 no key; 3 a required probe failed; 1 unexpected.
 *
 * REQUIRED: fred typed, polymarket typed, one plain page.
 * REPORTED ONLY (never fail the run): the redirect probe and the X post probe, because both depend on
 * things outside this repo (a venue's URL layout; whether the Firecrawl team has X enrichment on).
 */
import {
  buildFirecrawlFetcher, buildFirecrawlTypedFetcher, renderRecord, runSourceCheck, typedCallFor,
  SOURCE_CHECK_CONTRACT, type SourceCheck, type TypedCall, type TypedFetcher, type TypedResult,
} from "../src/source-check"

const DEFAULT_PM_URL = "https://polymarket.com/event/fed-decision-in-december-20260729232808632"
const FRED_URL = "https://fred.stlouisfed.org/series/UNRATE"
const PAGE_URL = "https://www.bls.gov/news.release/cpi.nr0.htm"
const REDIRECT_URL = "https://kalshi.com/markets/kxfed"
const X_URL = "https://x.com/jack/status/20"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const key = process.env.FIRECRAWL_API_KEY
if (!key) {
  console.error("FIRECRAWL_API_KEY is not set. Run with --env-file=.dev.vars (see the header of this file).")
  process.exit(2)
}

// One provider call per source: the probe reads the record to build its claim, then the check reuses it.
const live = buildFirecrawlTypedFetcher(key)
const seen = new Map<string, Promise<TypedResult>>()
const typed: TypedFetcher = (call) => {
  const k = JSON.stringify([call.provider, call.capability, call.options])
  if (!seen.has(k)) seen.set(k, live(call))
  return seen.get(k)!
}
const page = buildFirecrawlFetcher(key)

let failed = 0
const line = (tag: "PASS" | "FAIL" | "INFO", label: string, detail: string) => {
  if (tag === "FAIL") failed++
  console.log(`${tag}  ${label}\n      ${detail}`)
}
const show = (c: SourceCheck) =>
  `route=${c.route} status=${c.status}` +
  (c.typed_error ? ` typed_error=${c.typed_error}` : "") + (c.reason ? ` reason=${c.reason}` : "") +
  (c.served_by ? ` served_by=${c.served_by}` : "") + (c.resolved_url ? ` resolved_url=${c.resolved_url}` : "") +
  (c.fetched_at ? ` fetched_at=${c.fetched_at}` : "") + (c.span ? `\n      span: ${c.span}` : "")

async function check(intent: string): Promise<SourceCheck> {
  const block = await runSourceCheck(intent, page, typed)
  return block.checks[0]
}

/** Typed probe: true claim from the record's own number → supported; false claim → figure_not_in_source. */
async function typedProbe(label: string, url: string, pick: (values: number[]) => number | undefined, unit: string) {
  const call: TypedCall | null = typedCallFor(url)
  if (!call) return line("FAIL", label, `the URL does not map to a typed route: ${url}`)
  const res = await typed(call)
  if (!res.ok) return line("FAIL", label, `typed lookup failed: ${res.reason}. The Worker would fall back to the page read for this source.`)
  const lines = renderRecord(call, res.data)
  const value = lines.length > 0 ? pick(lines[0].values) : undefined
  if (value === undefined) return line("FAIL", label, "the provider answered, but the record has no line this module can read (shape changed?)")
  const good = await check(`The source shows ${value}${unit} per ${url}.`)
  line(good.route === call.route && good.status === "supported" ? "PASS" : "FAIL", `${label}: a figure the record shows`, show(good))
  const bad = await check(`The source shows 123456.789${unit} per ${url}.`)
  line(bad.route === call.route && bad.status === "figure_not_in_source" ? "PASS" : "FAIL", `${label}: a figure the record does not show`, show(bad))
}

async function main() {
  console.log(`source check ${SOURCE_CHECK_CONTRACT} live probe\n`)

  await typedProbe("FRED typed", FRED_URL, (v) => v[0], "%")
  // values per outcome are [price, percent, displayed percent]: claim the displayed percent.
  await typedProbe("Polymarket typed", arg("pm-url") ?? DEFAULT_PM_URL, (v) => v[2], "%")

  if (!flag("typed-only")) {
    const plain = await check(`The index for shelter rose in the latest release per ${PAGE_URL}.`)
    line(plain.route === "page" && plain.status !== "unreachable" && plain.status !== "not_checked" && plain.source_sha256 ? "PASS" : "FAIL",
      "Plain page (.gov) is read and hashed", show(plain))

    const moved = await check(`The December market prices a hike per ${REDIRECT_URL}.`)
    line("INFO", "Redirecting page records where it ended up",
      show(moved) + (moved.resolved_url ? "" : "\n      note: no resolved_url came back (no redirect today, or the page was unreachable)"))

    const post = await check(`He wrote that he was just setting up his account per ${X_URL}.`)
    line("INFO", "X post",
      show(post) + (post.status === "unreachable" ? "\n      note: X posts are served by a Firecrawl data provider; unreachable here usually means that is not enabled for this key's team" : ""))
  }

  console.log(failed === 0 ? "\nALL REQUIRED PROBES PASS" : `\n${failed} REQUIRED PROBE(S) FAILED`)
  process.exit(failed === 0 ? 0 : 3)
}

main().catch(() => {
  console.error("unexpected failure (details withheld: an error here can carry request text)")
  process.exit(1)
})
