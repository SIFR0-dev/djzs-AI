// basis-gate.mjs — GATE 0.5 of the refusal agent: the basis receipt.
// ───────────────────────────────────────────────────────────────────────────
// CLAUDE.md §14 records the engine's honesty limit: M03 checks that a probability
// basis is STATED, not that it is TRUE. Entry 002 returned PASS / risk 0 on a
// fabricated basis. This gate moves one rung: when the intent names the page its
// basis rests on (`basis_url`) and the verbatim span on that page (`basis_quote`),
// the page is fetched LIVE through LCR by the committed capture script
// (tests/q3/source-capture.ts, SCAN_SPEC §13) and the quote must be ONE contiguous
// span of it. The receipt (content-addressed, self-hashed) is written to
// agent/receipts/ and its hash rides in the refusal log. Existence and
// attribution, not truth: a page can still be wrong.
//
// What the gate does NOT do: it never touches the wire. `renderWire` is frozen and
// `basis_url` / `basis_quote` are not in it, so intent_sha256 and every verdict hash
// are exactly what they were. The engine stays pure (no network); this runs in the
// operator's shell, where LCR_API_KEY lives.
//
// Statuses (fixed vocabulary; the log carries the word, never raw error text):
//   verified      receipt written, quote found on the live page
//   blocked_host  LCR 451 class (.gov, .mil, polymarket, kalshi, banks): no request sent.
//                 A venue basis is the NORM for a PM intent and the venue number comes
//                 from the venue API (SCAN_SPEC rule), so this is recorded and the run
//                 PROCEEDS. The market's own odds are never fetched through LCR.
//   not_on_page   the page was fetched and the quote is not on it → REFUSE. This is the
//                 operator's own citation failing; a paid run must not spend on it.
//   unreachable   LCR/upstream failure, cache served, empty page → REFUSE in dry mode
//                 (fix the URL or retry); an explicit --skip-basis records
//                 `skipped_by_operator` instead and proceeds.
//   unchecked     the intent names no basis_url. Allowed today; recorded as such.
//   stale         paid mode only: the receipt found for this url+quote is older than
//                 RECEIPT_MAX_AGE_MS → REFUSE, re-run the dry gate (which captures anew).
//
// Dry mode captures. Paid mode does NOT capture again (a second fetch at a later time
// is a different page): it REQUIRES a fresh receipt from the dry run for the same
// url+quote, so the ticket (--expect-sha) and the receipt describe the same moment.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECEIPTS_DIR = join(HERE, "receipts");
export const CAPTURE_SCRIPT = resolve(HERE, "..", "..", "tests", "q3", "source-capture.ts");
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BASIS_STATUSES = ["verified", "blocked_host", "not_on_page", "unreachable", "unchecked", "stale", "skipped_by_operator"];

const norm = (s) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/** The log-bearing summary of a receipt: the hashes and the time, never the page text. */
export function summarizeReceipt(status, receipt, extra = {}) {
  const r = receipt ?? null;
  return {
    status,
    url: r?.url ?? extra.url ?? null,
    captured_at: r?.captured_at ?? null,
    receipt_sha256: r?.receipt_sha256 ?? null,
    html_sha256: r?.html_sha256 ?? null,
    quote_sha256: r?.quote?.sha256 ?? null,
    fetcher: r ? `${r.fetcher.provider}:${r.fetcher.source}:${r.fetcher.country_code}` : null,
    ...extra,
  };
}

/** Pure: given the capture script's JSON result, decide what the gate does. */
export function evaluateCapture(result, { skip = false } = {}) {
  const st = result?.status;
  if (st === "verified" && result.receipt?.quote?.found_at != null) {
    return { proceed: true, summary: summarizeReceipt("verified", result.receipt) };
  }
  if (st === "verified") {
    // A receipt without a quote check is provenance for the page, not for the basis. Treat as unreachable-for-
    // this-purpose: the gate was asked for a quote and none was checked.
    return { proceed: false, summary: summarizeReceipt("not_on_page", result.receipt), reason: "receipt carries no quote check" };
  }
  if (st === "blocked_host") return { proceed: true, summary: summarizeReceipt("blocked_host", null, { url: result.url ?? null }) };
  if (st === "not_on_page") return { proceed: false, summary: summarizeReceipt("not_on_page", null, { url: result.url ?? null }), reason: "basis_quote is not a contiguous span of the live page" };
  if (skip) return { proceed: true, summary: summarizeReceipt("skipped_by_operator", null, { url: result?.url ?? null }) };
  return { proceed: false, summary: summarizeReceipt("unreachable", null, { url: result?.url ?? null }), reason: st === "usage" ? "LCR_API_KEY missing or bad flags (the capture script said so)" : "page unreachable through LCR" };
}

/** Pure: paid-mode lookup. Finds the newest receipt in `dir` for this url+quote; stale or missing refuses. */
export function findFreshReceipt(dir, url, quote, now = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS) {
  if (!existsSync(dir)) return { proceed: false, summary: summarizeReceipt("stale", null, { url }), reason: "no receipt directory; run --mode dry first" };
  const wantQuote = norm(quote);
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let r; try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (r?.url !== url) continue;
    if (!r?.quote || norm(r.quote.text) !== wantQuote) continue;
    if (r.fetcher?.source !== "livecrawled" || r.fetcher?.max_age_hours !== 0) continue;
    const t = Date.parse(r.captured_at);
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.t) best = { t, r };
  }
  if (!best) return { proceed: false, summary: summarizeReceipt("stale", null, { url }), reason: "no receipt for this basis_url + basis_quote; run --mode dry first" };
  if (now - best.t > maxAgeMs) return { proceed: false, summary: summarizeReceipt("stale", best.r), reason: `receipt is ${Math.round((now - best.t) / 3600000)}h old, limit ${maxAgeMs / 3600000}h; re-run --mode dry` };
  return { proceed: true, summary: summarizeReceipt("verified", best.r) };
}

/** Runs the committed capture script in --json mode. Inherits the shell env (LCR_API_KEY stays in the shell). */
export function runCapture(url, quote, { outDir = RECEIPTS_DIR, script = CAPTURE_SCRIPT, cwd = resolve(HERE, "..", "..") } = {}) {
  mkdirSync(outDir, { recursive: true });
  const res = spawnSync("npx", ["tsx", script, "--url", url, "--quote", quote, "--json", "--out", outDir], { cwd, encoding: "utf8", env: process.env, timeout: 90_000 });
  if (res.error) return { status: "unreachable", url, error: String(res.error.message) };
  const line = String(res.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return { status: "unreachable", url, error: `capture script gave no JSON (exit ${res.status})` }; }
}

/** The whole gate for the agent. `fields` is the parsed frontmatter. */
export function basisGate(fields, { mode, skip = false, now = Date.now(), receiptsDir = RECEIPTS_DIR, capture = runCapture }) {
  const url = fields.basis_url, quote = fields.basis_quote;
  if (!url) return { proceed: true, summary: summarizeReceipt("unchecked", null), note: "intent names no basis_url" };
  if (!quote) return { proceed: false, summary: summarizeReceipt("not_on_page", null, { url }), reason: "basis_url given without basis_quote: nothing to check the page against" };
  if (mode === "paid") {
    // Paid never fetches. A prohibited host never had a receipt, so it mirrors the dry result without a request;
    // everything else needs a fresh receipt from the dry run.
    if (blockedHost(url)) return { proceed: true, summary: summarizeReceipt("blocked_host", null, { url }) };
    return findFreshReceipt(receiptsDir, url, quote, now);
  }
  const result = capture(url, quote);
  return evaluateCapture(result, { skip });
}

// Same pattern list as tests/q3/source-capture.ts LCR_BLOCKED_HOST_PATTERNS; duplicated here because this file is
// plain Node (.mjs) and that one is TypeScript. If one changes, change both (the test pins them equal).
export const BLOCKED_HOST_PATTERNS = [
  /(^|\.)gov$/i, /(^|\.)mil$/i,
  /(^|\.)(polymarket|kalshi)\.(com|us)$/i,
  /(^|\.)(draftkings|fanduel|betfair|bet365|predictit)\.(com|org)$/i,
  /(^|\.)(google)\.(com|[a-z]{2})$/i,
  /(^|\.)(stripe|paypal|visa|mastercard|chase|wellsfargo|bankofamerica|citi)\.com$/i,
];
export function blockedHost(url) {
  let host; try { host = new URL(url).hostname; } catch { return "not a URL"; }
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(host)) ? host : null;
}
