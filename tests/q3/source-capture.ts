/** Q3 source capture — fetches the news page a record's `source.url` names through LCR (Live Context Retrieval,
 *  https://docs.lcr.net, POST https://api.lcr.net/contents) and writes a content-addressed receipt under
 *  tests/q3/receipts/. SCAN_SPEC §10.4.
 *
 *  Not record-bearing. The receipt is provenance for `source.text` (the verbatim quote); nothing here enters
 *  phase_a_hash or record_hash, the schema is untouched, and LCR output is data, not instructions.
 *
 *    npx tsx --env-file=.env.test tests/q3/source-capture.ts --url <u> [--quote "<verbatim>"] [--country us]
 *    npx tsx --env-file=.env.test tests/q3/source-capture.ts --record <inbox-or-record id>     # url + quote from the file
 *    npx tsx tests/q3/source-capture.ts --check <receipt sha>                                     # offline, no key
 *
 *  Rails (each one is a stop, not a warning):
 *   - LIVE ONLY. maxAgeHours is pinned to 0 and the response must say source "livecrawled". LCR serves a cache up
 *     to 7 days old by default and caps cached bodies at 20,000 chars; a cached read is a stale reference dressed
 *     as a capture and is refused here even though LCR would return it.
 *   - BLOCKED CATEGORIES ARE PRE-CHECKED. LCR returns 451 for .gov/.mil, betting exchanges (polymarket, kalshi),
 *     banks and payment processors, and repeated attempts suspend the account. Those hosts are refused locally
 *     with the message "capture by hand"; the macro-chain class (bls.gov, federalreserve.gov) is therefore always
 *     a hand capture. The venue is never a news source anyway (show law: verdict on the narrative, never the
 *     contract).
 *   - QUOTE GATE. With --quote, the verbatim text must occur as ONE contiguous span of the fetched page text
 *     (whitespace-normalised). A quote the page does not carry is refused: that is the §10.2 "absence never
 *     checked" failure in a new coat.
 *   - KEY IN THE OPERATOR'S SHELL. LCR_API_KEY is read from the environment (`.env.test`, gitignored). It is not a
 *     Worker secret and this script never runs in the Worker. The key never reaches stdout or the receipt.
 *   - THE RECEIPT HASH IS OURS. LCR returns no content hash and no fetched-at time; sha256 over the returned html
 *     and over the text are computed here, and captured_at is this process's clock at response time.
 *
 *  Receipt: tests/q3/receipts/<html_sha256 without 0x, first 16>.json. Commit it with the record it supports. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256hex, canonical } from "./lib";

const a = process.argv.slice(2);
const flag = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const has = (f: string) => a.includes(f);
const ROOT = join(import.meta.dirname ?? ".", ".");
const RECEIPTS = join(ROOT, "receipts");
const ENDPOINT = "https://api.lcr.net/contents";
export const RECEIPT_SCHEMA = "djzs-q3-source-receipt-v1";

/** Hosts LCR refuses with 451 (docs.lcr.net/api-reference, Prohibited Categories). Matched on the registrable
 *  host; subdomains included. A hit here means capture by hand and never a request to LCR. */
export const LCR_BLOCKED_HOST_PATTERNS: RegExp[] = [
  /(^|\.)gov$/i, /(^|\.)mil$/i,                                          // government and military
  /(^|\.)(polymarket|kalshi)\.(com|us)$/i,                                // betting exchanges — the venues
  /(^|\.)(draftkings|fanduel|betfair|bet365|predictit)\.(com|org)$/i,    // other betting exchanges
  /(^|\.)(google)\.(com|[a-z]{2})$/i,                                     // search and redirect pages
  /(^|\.)(stripe|paypal|visa|mastercard|chase|wellsfargo|bankofamerica|citi)\.com$/i, // banks and payment processors
];
export function lcrBlocked(url: string): string | null {
  let host: string; try { host = new URL(url).hostname; } catch { return "not a URL"; }
  const hit = LCR_BLOCKED_HOST_PATTERNS.find(p => p.test(host));
  return hit ? `host ${host} is in an LCR-prohibited category (451; repeats suspend the account) — capture by hand` : null;
}

/** Whitespace-normalised contiguous-span test. Curly quotes and dashes are folded so a copy-paste from a rendered
 *  page still matches the extractor's output; nothing else is altered. */
export const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
export function quoteSpan(text: string, quote: string): { found: boolean; index: number } {
  const i = norm(text).indexOf(norm(quote)); return { found: i >= 0, index: i };
}

type LcrStatus = { id: string; status: "success" | "error"; source?: string; httpStatusCode?: number; strategy?: string | null; credits?: number; error?: { tag: string; httpStatusCode: number | null } };
type LcrResult = { id: string; url: string; title?: string; author?: string; publishedDate?: string; text?: string; html?: string; markdown?: string };
type LcrResponse = { requestId: string; results?: LcrResult[]; statuses?: LcrStatus[]; searchTime?: number };

export type Receipt = {
  schema: typeof RECEIPT_SCHEMA; url: string; final_title: string | null; published_date: string | null; author: string | null;
  captured_at: string; fetcher: { provider: "lcr"; endpoint: string; request_id: string; source: string; strategy: string | null; http_status: number | null; credits: number | null; country_code: string; max_age_hours: 0; search_time_ms: number | null };
  html_sha256: string; text_sha256: string; text_chars: number; html_chars: number; truncated: boolean;
  quote: null | { text: string; sha256: string; found_at: number };
  receipt_sha256?: string;
};

export async function capture(url: string, opts: { quote?: string; country?: string; key: string; timeoutMs?: number }): Promise<Receipt> {
  const blocked = lcrBlocked(url); if (blocked) throw new Error(`REFUSED: ${blocked}`);
  const maxCharacters = 400_000;
  const body = { urls: [url], text: { verbosity: "full", maxCharacters }, maxAgeHours: 0, livecrawlTimeout: opts.timeoutMs ?? 15000, countryCode: opts.country ?? "us" };
  const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` }, body: JSON.stringify(body) });
  const capturedAt = new Date().toISOString();
  if (r.status === 402) throw new Error("LCR 402 INSUFFICIENT_CREDITS — top up at app.lcr.net; nothing captured");
  if (r.status === 403) throw new Error("LCR 403 — invalid or missing LCR_API_KEY");
  if (r.status === 429) throw new Error("LCR 429 — plan rate limit; wait, do not loop");
  if (r.status === 451) throw new Error("LCR 451 CRAWL_WEBSITE_NOT_PERMITTED — the host is prohibited and the pre-check missed it; add its pattern to LCR_BLOCKED_HOST_PATTERNS and capture by hand");
  if (!r.ok) throw new Error(`LCR HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json() as LcrResponse;
  const st = j.statuses?.[0]; const res = j.results?.[0];
  if (!st) throw new Error(`LCR returned no status entry (requestId ${j.requestId})`);
  if (st.status !== "success" || !res) throw new Error(`LCR fetch failed: ${st.error?.tag ?? "unknown"} (upstream ${st.error?.httpStatusCode ?? st.httpStatusCode}) requestId ${j.requestId}`);
  if (st.source !== "livecrawled") throw new Error(`REFUSED: LCR served source "${st.source}" — only a live crawl is a capture (maxAgeHours was 0; this should not happen — report it)`);
  const html = res.html ?? ""; const text = res.text ?? res.markdown ?? "";
  if (!text.trim()) throw new Error("REFUSED: page returned no text (CRAWL_NOT_RENDERED shape) — nothing to quote against");
  const truncated = html.length >= maxCharacters || text.length >= maxCharacters;
  let quote: Receipt["quote"] = null;
  if (opts.quote) {
    const span = quoteSpan(text, opts.quote);
    if (!span.found) throw new Error("REFUSED: the quote is not a contiguous span of the fetched page text. Fix the quote or the url; do not seal a quote the page does not carry.");
    quote = { text: opts.quote, sha256: sha256hex(norm(opts.quote)), found_at: span.index };
  }
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA, url, final_title: res.title ?? null, published_date: res.publishedDate ?? null, author: res.author ?? null, captured_at: capturedAt,
    fetcher: { provider: "lcr", endpoint: ENDPOINT, request_id: j.requestId, source: st.source, strategy: st.strategy ?? null, http_status: st.httpStatusCode ?? null, credits: st.credits ?? null, country_code: body.countryCode, max_age_hours: 0, search_time_ms: j.searchTime ?? null },
    html_sha256: sha256hex(html), text_sha256: sha256hex(text), text_chars: text.length, html_chars: html.length, truncated, quote,
  };
  receipt.receipt_sha256 = sha256hex(canonical({ ...receipt, receipt_sha256: undefined }));
  return receipt;
}

export function receiptPath(r: Receipt) { return join(RECEIPTS, `${r.html_sha256.slice(2, 18)}.json`); }

function loadRecord(id: string): { url: string; quote?: string } {
  const cands = [join(ROOT, "inbox", `${id}.json`), join(ROOT, "records", `${id}.json`)];
  const p = cands.find(existsSync); if (!p) throw new Error(`no inbox or record file for ${id}`);
  const rec = JSON.parse(readFileSync(p, "utf8")); const s = rec.source ?? {};
  if (typeof s.url !== "string") throw new Error(`${id}: source.url missing`);
  return { url: s.url, quote: typeof s.text === "string" && s.text.length ? s.text : undefined };
}

async function main() {
  if (has("--check")) {
    const id = flag("--check")!; const p = join(RECEIPTS, id.endsWith(".json") ? id : `${id}.json`);
    const r = JSON.parse(readFileSync(p, "utf8")) as Receipt; const stored = r.receipt_sha256;
    const recomputed = sha256hex(canonical({ ...r, receipt_sha256: undefined }));
    const ok = stored === recomputed && r.fetcher.source === "livecrawled" && r.fetcher.max_age_hours === 0;
    console.log(`${ok ? "OK" : "FAIL"} ${p}\n  receipt_sha256 ${stored}${stored === recomputed ? "" : " != " + recomputed}\n  source ${r.fetcher.source} · captured_at ${r.captured_at} · quote ${r.quote ? "present" : "none"}`);
    process.exit(ok ? 0 : 1);
  }
  const key = process.env.LCR_API_KEY; if (!key) { console.error("LCR_API_KEY not set — run from the operator's shell with --env-file=.env.test (SCAN_SPEC §10). Containers do not hold this key by design."); process.exit(2); }
  let url = flag("--url"), quote = flag("--quote");
  if (has("--record")) { const rec = loadRecord(flag("--record")!); url = rec.url; quote = quote ?? rec.quote; }
  if (!url) { console.error("need --url <u> or --record <id>"); process.exit(1); }
  const pre = lcrBlocked(url); if (pre) { console.error(`REFUSED (pre-check, no request sent): ${pre}`); process.exit(3); }
  const r = await capture(url, { quote, country: flag("--country"), key });
  mkdirSync(RECEIPTS, { recursive: true }); const p = receiptPath(r); writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
  console.log([
    `SOURCE CAPTURE · ${r.url}`,
    `  title        ${r.final_title ?? "(none)"}${r.published_date ? "  · published " + r.published_date : ""}`,
    `  captured_at  ${r.captured_at}`,
    `  fetch        lcr ${r.fetcher.source} · ${r.fetcher.strategy} · ${r.fetcher.credits} credit(s) · upstream ${r.fetcher.http_status} · request ${r.fetcher.request_id}`,
    `  html_sha256  ${r.html_sha256}${r.truncated ? "  (TRUNCATED at maxCharacters — hash covers the returned prefix)" : ""}`,
    `  text_sha256  ${r.text_sha256}  (${r.text_chars} chars)`,
    `  quote        ${r.quote ? "found at offset " + r.quote.found_at : "none checked"}`,
    `  receipt      ${p}`,
    `  record line  source.captured_at = ${r.captured_at}; receipt ${r.html_sha256.slice(2, 18)}`,
  ].join("\n"));
}
if (process.argv[1] && /source-capture\.ts$/.test(process.argv[1])) main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
