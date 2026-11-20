/**
 * source-check.ts — DJZS-SRC-v0.1: does the source a thesis cites actually say what the thesis says?
 *
 * The engine can only tell whether a basis is STATED. "Per Reuters, odds are 70%" reads as a sourced
 * probability whether or not the linked page says anything of the kind. This module reads each URL the
 * intent cites and reports, per source, whether the page carries the claim.
 *
 * DOCTRINE — LLM detects, TypeScript decides:
 *   - URLs are found by a regex over the intent text. No model decides what was cited.
 *   - Firecrawl fetches the page (maxAge 0: never a cached copy) as markdown, and its `highlights`
 *     format (an LLM step) proposes the passage most relevant to the claim. That proposal is a HINT.
 *   - TypeScript decides. A proposed passage counts only if it appears verbatim (after whitespace and
 *     markdown normalization) in the fetched page. Every figure in the claim is looked up in the page
 *     text by exact numeric value. No model output reaches a status without passing those checks.
 *   - source_sha256 is the sha256 of the fetched markdown, so anyone holding the page bytes can confirm
 *     what the gate read.
 *
 * NOT SCORED (v0.1). The block rides beside the verdict like the perp `mechanics` block: it never enters
 * the extraction input, risk_score, the verdict, verdict_hash, the PoL certificate or the EAS attestation.
 * Letting a status move the verdict is a versioned taxonomy change and goes through the Q2 acceptance bar
 * first. Every failure here is fail-soft: the audit is never blocked, delayed past the budget, or altered.
 *
 * Statuses, in precedence order (first that applies):
 *   unreachable           the page could not be read (fetch error, non-2xx page, empty body, timeout)
 *   figure_not_in_source  the page was read and at least one figure in the claim appears nowhere on it
 *   span_figure_mismatch  a verbatim passage was found, but a claim figure is not in that passage
 *                         (the source says something else, e.g. "4 credits" where the claim says 9)
 *   supported             a verbatim passage was found and every claim figure appears inside it
 *   no_supporting_span    the page was read but no verbatim passage for the claim could be confirmed
 *   not_checked           no FIRECRAWL_API_KEY, or the citation is past the per-audit cap
 */
import { sha256Hex } from "../../server/engine-v2/hash"

export const SOURCE_CHECK_CONTRACT = "DJZS-SRC-v0.1" as const
export const MAX_SOURCES = 3
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"
const PER_SOURCE_TIMEOUT_MS = 25_000
const MIN_SPAN_CHARS = 24
const MAX_SPAN_CHARS = 280 // a short evidence excerpt, never a reproduction of the page
const MAX_CLAIM_CHARS = 1_000

export type SourceStatus =
  | "unreachable"
  | "figure_not_in_source"
  | "span_figure_mismatch"
  | "supported"
  | "no_supporting_span"
  | "not_checked"

export interface SourceCheck {
  url: string
  status: SourceStatus
  /** The sentence of the intent that cites this URL, URL removed. */
  claim: string
  /** Figures found in the claim, canonicalized (commas and % stripped). */
  claim_figures: string[]
  /** Claim figures missing from the page (figure_not_in_source) or from the confirmed passage (span_figure_mismatch). */
  figures_missing: string[]
  /** A verbatim passage from the page that the highlight step proposed and TypeScript confirmed. */
  span: string | null
  /** sha256 of the fetched markdown; null when nothing was read. */
  source_sha256: string | null
  /** HTTP status the target page returned, as Firecrawl reports it. */
  page_status: number | null
  /** Fixed code when status is unreachable or not_checked. Never raw error text. */
  reason?: string
}

export interface SourcesBlock {
  contract: typeof SOURCE_CHECK_CONTRACT
  scored: false
  status: "checked" | "no_citations" | "not_configured" | "error"
  provider: "firecrawl"
  checks: SourceCheck[]
  summary: Record<SourceStatus, number>
  rule: string
}

/** What the module needs from a page fetch. The offline seam: tests pass a stub, production uses Firecrawl. */
export interface FetchedPage {
  ok: boolean
  /** The target page's own HTTP status (metadata.statusCode). */
  pageStatus: number | null
  markdown: string
  /** Firecrawl's `highlights` output: a string of proposed passages. */
  highlights: string
  /** Fixed failure code when ok is false. */
  reason?: string
}
export type PageFetcher = (url: string, highlightQuery: string) => Promise<FetchedPage>

const RULE =
  "Not scored: never enters risk_score, the verdict, verdict_hash or the attestation. " +
  "A passage counts only if it appears verbatim on the fetched page; every figure in the claim is looked up on the page by exact value. " +
  "figure_not_in_source = a stated figure is nowhere on the page; span_figure_mismatch = the confirmed passage carries different figures. source_sha256 = sha256 of the markdown the gate read."

// ─── Citation extraction (deterministic) ────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g
const TRAILING_PUNCT = /[.,;:!?]+$/

/** Hosts a citation may not name: loopback, link-local, private ranges, bare IPs, local names. */
function isPublicHost(host: string): boolean {
  const h = host.toLowerCase()
  if (!h.includes(".")) return false
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false // bare IPv4
  if (h.startsWith("[")) return false // bare IPv6
  return true
}

/** URLs cited in the intent, in order of first appearance, deduplicated, trailing punctuation removed. */
export function extractCitations(intent: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of intent.matchAll(URL_RE)) {
    const raw = m[0].replace(TRAILING_PUNCT, "")
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    if (!isPublicHost(u.hostname)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * The claim a URL is cited for: the sentence of the intent that contains it, with the URL removed.
 * Sentence ends are `.` `!` `?` followed by whitespace, or a newline — dots inside the URL never end it.
 */
export function claimFor(intent: string, url: string): string {
  const at = intent.indexOf(url)
  if (at < 0) return collapse(intent).slice(0, MAX_CLAIM_CHARS)
  const end = at + url.length
  const isBoundary = (i: number) =>
    intent[i] === "\n" || (/[.!?]/.test(intent[i] ?? "") && (i + 1 >= intent.length || /\s/.test(intent[i + 1])))
  let start = 0
  for (let i = at - 1; i >= 0; i--) {
    if (isBoundary(i)) { start = i + 1; break }
  }
  let stop = intent.length
  for (let i = end; i < intent.length; i++) {
    if (isBoundary(i)) { stop = i + 1; break }
  }
  const sentence = collapse((intent.slice(start, at) + " " + intent.slice(end, stop)).replace(/[(\[]\s*[)\]]/g, ""))
    .replace(/\s+([.,;:!?])/g, "$1")
  // A URL standing alone on its line cites the whole intent.
  return (sentence.replace(/[^\p{L}\p{N}]/gu, "").length < 8 ? collapse(intent.replaceAll(url, "")) : sentence)
    .slice(0, MAX_CLAIM_CHARS)
}

// ─── Figures (deterministic) ────────────────────────────────────────────────

const FIGURE_RE = /\d[\d,]*(?:\.\d+)?\s*(%|percent\b|pct\b|bps\b|basis points\b)?/gi

interface Figure { value: number; percent: boolean; canonical: string }

/** Thousands separators only: "1,234,567" yes, "1,23" no. */
function parseNumber(s: string): number | null {
  if (s.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null
  const n = Number(s.replaceAll(",", ""))
  return Number.isFinite(n) ? n : null
}

/**
 * Figures in a text. Skipped as noise: four-digit years 1900-2100 with no unit (a page about an event
 * rarely repeats the year in its body). Small integers are kept: "9 credits" against a source saying 4
 * is exactly the case this check exists for (found on the first live run, 2026-11-20).
 */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = []
  for (const m of text.matchAll(FIGURE_RE)) {
    const numText = m[0].replace(/\s*(%|percent|pct|bps|basis points)$/i, "").trim()
    const value = parseNumber(numText)
    if (value === null) continue
    const unit = (m[1] ?? "").toLowerCase()
    const percent = unit === "%" || unit === "percent" || unit === "pct"
    const isInt = !numText.includes(".")
    if (!unit && isInt && value >= 1900 && value <= 2100 && numText.length === 4) continue
    out.push({ value, percent, canonical: String(value) + (percent ? "%" : "") })
  }
  return out
}

/** Is figure f stated on the page? Exact value; a percent also matches its fraction (70% ↔ 0.7). */
function figureOnPage(f: Figure, page: Figure[]): boolean {
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9
  return page.some((p) => eq(p.value, f.value) || (f.percent && eq(p.value, f.value / 100)))
}

// ─── Verbatim span confirmation (deterministic) ─────────────────────────────

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Normalization applied identically to the page and to each proposed passage before containment. */
export function normalizeForMatch(s: string): string {
  return collapse(
    s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/ /g, " ")
      .replace(/[*_`#>|]/g, " "),
  ).toLowerCase()
}

/**
 * The first proposed passage that appears verbatim on the page, or null.
 * Highlights may hold several passages; they are split on newlines and ellipses and tested one by one.
 */
export function confirmSpan(markdown: string, highlights: string): string | null {
  return confirmSpanFull(markdown, highlights)?.display ?? null
}

function confirmSpanFull(markdown: string, highlights: string): { display: string; full: string } | null {
  if (!highlights) return null
  const page = normalizeForMatch(markdown)
  const parts = highlights.split(/\n+|\s*(?:\.\.\.|…)\s*/)
  for (const part of parts) {
    const candidate = collapse(part.replace(/^["'\s-]+|["'\s]+$/g, ""))
    const norm = normalizeForMatch(candidate)
    if (norm.length < MIN_SPAN_CHARS) continue
    if (page.includes(norm)) {
      return {
        full: candidate,
        display: candidate.length > MAX_SPAN_CHARS ? candidate.slice(0, MAX_SPAN_CHARS - 1) + "\u2026" : candidate,
      }
    }
  }
  return null
}

// ─── The decision (deterministic, pure) ─────────────────────────────────────

/** Pure: (url, claim, fetched page) → one SourceCheck. No I/O. */
export function decideSource(url: string, claim: string, page: FetchedPage): SourceCheck {
  const claimFigs = figuresIn(claim)
  const claim_figures = [...new Set(claimFigs.map((f) => f.canonical))]
  const base = { url, claim, claim_figures, figures_missing: [] as string[], span: null, page_status: page.pageStatus }

  const pageOk = page.ok && page.pageStatus !== null && ((page.pageStatus >= 200 && page.pageStatus < 300) || page.pageStatus === 304)
  if (!pageOk || page.markdown.trim().length === 0) {
    const reason = !page.ok
      ? (page.reason ?? "fetch_failed")
      : page.pageStatus !== null && !(page.pageStatus >= 200 && page.pageStatus < 300) && page.pageStatus !== 304
        ? `page_status_${page.pageStatus}`
        : "empty_page"
    return { ...base, status: "unreachable", source_sha256: null, reason }
  }

  const source_sha256 = sha256Hex(page.markdown)
  const pageFigs = figuresIn(normalizeForMatch(page.markdown))
  const missing = claimFigs.filter((f) => !figureOnPage(f, pageFigs))
  const figures_missing = [...new Set(missing.map((f) => f.canonical))]
  const confirmed = confirmSpanFull(page.markdown, page.highlights)
  const span = confirmed?.display ?? null

  if (figures_missing.length > 0) return { ...base, status: "figure_not_in_source", figures_missing, span, source_sha256 }
  if (confirmed !== null) {
    // On a long page almost any number appears somewhere; the passage the claim rests on is what must carry it.
    const spanFigs = figuresIn(normalizeForMatch(confirmed.full))
    const offSpan = [...new Set(claimFigs.filter((f) => !figureOnPage(f, spanFigs)).map((f) => f.canonical))]
    if (offSpan.length > 0) return { ...base, status: "span_figure_mismatch", figures_missing: offSpan, span, source_sha256 }
    return { ...base, status: "supported", span, source_sha256 }
  }
  return { ...base, status: "no_supporting_span", source_sha256 }
}

// ─── Firecrawl fetcher (the only network I/O) ───────────────────────────────

interface FirecrawlScrapeResponse {
  success?: boolean
  data?: {
    markdown?: string
    highlights?: string | null
    metadata?: { statusCode?: number }
  }
}

/** Production fetcher. Request-scoped key, never module-scope. Errors become fixed codes. */
export function buildFirecrawlFetcher(apiKey: string, fetchImpl: typeof fetch = fetch): PageFetcher {
  return async (url, highlightQuery) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PER_SOURCE_TIMEOUT_MS)
    try {
      const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          url,
          formats: ["markdown", { type: "highlights", query: highlightQuery }],
          maxAge: 0, // never a cached copy: the gate reads the page as it stands at audit time
          storeInCache: false,
          onlyMainContent: true,
          timeout: PER_SOURCE_TIMEOUT_MS - 2_000,
        }),
      })
      if (!res.ok) return { ok: false, pageStatus: null, markdown: "", highlights: "", reason: `provider_http_${res.status}` }
      const body = (await res.json()) as FirecrawlScrapeResponse
      if (body.success !== true || !body.data) return { ok: false, pageStatus: null, markdown: "", highlights: "", reason: "provider_bad_response" }
      return {
        ok: true,
        pageStatus: typeof body.data.metadata?.statusCode === "number" ? body.data.metadata.statusCode : null,
        markdown: typeof body.data.markdown === "string" ? body.data.markdown : "",
        highlights: typeof body.data.highlights === "string" ? body.data.highlights : "",
      }
    } catch (e) {
      return { ok: false, pageStatus: null, markdown: "", highlights: "", reason: ctrl.signal.aborted ? "timeout" : "fetch_failed" }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

function summarize(checks: SourceCheck[]): Record<SourceStatus, number> {
  const s: Record<SourceStatus, number> = {
    unreachable: 0, figure_not_in_source: 0, span_figure_mismatch: 0, supported: 0, no_supporting_span: 0, not_checked: 0,
  }
  for (const c of checks) s[c.status]++
  return s
}

function highlightQuery(claim: string): string {
  return `Return the exact passage from this page that states, supports or contradicts this claim, copied verbatim: ${claim}`
}

/**
 * Check every cited source. `fetcher` null = no key configured: each citation reports not_checked.
 * Never throws.
 */
export async function runSourceCheck(intent: string, fetcher: PageFetcher | null): Promise<SourcesBlock> {
  const block = (status: SourcesBlock["status"], checks: SourceCheck[]): SourcesBlock => ({
    contract: SOURCE_CHECK_CONTRACT, scored: false, status, provider: "firecrawl", checks, summary: summarize(checks), rule: RULE,
  })
  try {
    const urls = extractCitations(intent)
    if (urls.length === 0) return block("no_citations", [])

    const notChecked = (url: string, reason: string): SourceCheck => {
      const claim = claimFor(intent, url)
      return {
        url, status: "not_checked", claim, claim_figures: [...new Set(figuresIn(claim).map((f) => f.canonical))],
        figures_missing: [], span: null, source_sha256: null, page_status: null, reason,
      }
    }
    if (!fetcher) return block("not_configured", urls.map((u) => notChecked(u, "not_configured")))

    const checked = urls.slice(0, MAX_SOURCES)
    const results = await Promise.all(
      checked.map(async (url) => {
        const claim = claimFor(intent, url)
        const page = await fetcher(url, highlightQuery(claim))
        return decideSource(url, claim, page)
      }),
    )
    const overCap = urls.slice(MAX_SOURCES).map((u) => notChecked(u, "over_cap"))
    return block("checked", [...results, ...overCap])
  } catch {
    return block("error", [])
  }
}

/** Env-driven entry point for the Worker. Starts the check; the caller awaits it beside extraction. */
export function startSourceCheck(env: { FIRECRAWL_API_KEY?: string }, intent: string): Promise<SourcesBlock> {
  return runSourceCheck(intent, env.FIRECRAWL_API_KEY ? buildFirecrawlFetcher(env.FIRECRAWL_API_KEY) : null)
}
