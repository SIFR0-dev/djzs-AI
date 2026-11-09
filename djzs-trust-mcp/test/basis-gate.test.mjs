/**
 * GATE 0.5 (basis receipt) tests — offline, no LCR key, no network.
 *
 * THE ASSERTIONS THIS FILE EXISTS FOR:
 *   1. The wire is untouched: an intent with basis_url/basis_quote renders to the SAME string and the SAME
 *      intent_sha256 as the identical intent without them. If this ever fails, every logged hash has moved.
 *   2. A quote the live page does not carry REFUSES; a venue (blocked host) PROCEEDS with the status recorded;
 *      an unreachable page refuses unless the operator says --skip-basis, and then the log says so.
 *   3. Paid mode never fetches: it takes the dry run's receipt only when it is for the same url+quote,
 *      livecrawled, and under 24h old.
 *   4. The blocked-host list in basis-gate.mjs is the one in tests/q3/source-capture.ts (two files, one list).
 *   5. The capture script's --json contract: blocked host answers before the key check, with exit 3.
 *
 * Run: npx tsx test/basis-gate.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { basisGate, evaluateCapture, findFreshReceipt, BLOCKED_HOST_PATTERNS, blockedHost, CAPTURE_SCRIPT } from "../agent/basis-gate.mjs"
import { renderWire, validateIntent, sha256 } from "../agent/refusal-agent.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0
const failures = []
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${label}`) } else { failures.push(label); console.log(`  FAIL ${label}${detail ? " :: " + detail : ""}`) }
}

const base = `---
claim: The September hike is dead after the July payrolls print; the Fed holds, as circulated.
falsifier: a hot August CPI print above 3.4% y/y before the FOMC blackout
residual: one hawkish Fed speaker repricing hike odds 10-15 points against
probability_basis: Kalshi KXFEDDECISION-25SEP hold mid 93c (hike 7%), retrieved 2026-08-20T15:02Z, book depth $210K
`
const withBasis = base + `basis_url: https://www.reuters.com/markets/us/fed-hold-september-2026-08-20/
basis_quote: "traders now see a 93% chance the Fed holds in September"
---
`
const without = base + "---\n"

console.log("1. the wire and intent_sha256 do not move when basis_url/basis_quote are present")
{
  const a = validateIntent(without), b = validateIntent(withBasis)
  check("both intents clear the field gate", a.ok && b.ok, JSON.stringify([a.problems, b.problems]))
  check("renderWire is byte-identical", a.wire === b.wire)
  check("intent_sha256 is identical", sha256(a.wire) === sha256(b.wire))
  check("basis fields are parsed but NOT in the wire", b.fields.basis_url?.startsWith("https://") && !b.wire.includes("reuters"))
  check("renderWire still has the frozen shape", /^.+ Falsifier: .+\. Residual exposure: .+\. Probability basis: .+\.$/.test(renderWire(b.fields)))
}

console.log("2. dry-mode decisions from the capture result")
{
  const receipt = { url: "https://www.reuters.com/x", captured_at: "2026-11-09T20:00:00.000Z", receipt_sha256: "0xaa", html_sha256: "0xbb", quote: { text: "q", sha256: "0xcc", found_at: 120 }, fetcher: { provider: "lcr", source: "livecrawled", country_code: "us", max_age_hours: 0 } }
  const ok = evaluateCapture({ status: "verified", receipt })
  check("verified + quote found -> proceed, status verified, hashes carried", ok.proceed && ok.summary.status === "verified" && ok.summary.receipt_sha256 === "0xaa" && ok.summary.fetcher === "lcr:livecrawled:us")
  check("the summary never carries page text", !JSON.stringify(ok.summary).includes("found_at") && !("text" in ok.summary))
  const noq = evaluateCapture({ status: "verified", receipt: { ...receipt, quote: null } })
  check("a receipt without a quote check does NOT satisfy the basis gate", !noq.proceed && noq.summary.status === "not_on_page")
  const nop = evaluateCapture({ status: "not_on_page", url: "https://www.reuters.com/x" })
  check("not_on_page -> REFUSE", !nop.proceed && nop.summary.status === "not_on_page" && nop.summary.url === "https://www.reuters.com/x")
  const blk = evaluateCapture({ status: "blocked_host", url: "https://kalshi.com/m" })
  check("blocked_host (a venue) -> PROCEED, recorded", blk.proceed && blk.summary.status === "blocked_host")
  const unr = evaluateCapture({ status: "unreachable", url: "https://x.example/y" })
  check("unreachable -> REFUSE without --skip-basis", !unr.proceed && unr.summary.status === "unreachable")
  const skp = evaluateCapture({ status: "unreachable", url: "https://x.example/y" }, { skip: true })
  check("unreachable + --skip-basis -> proceed, logged as skipped_by_operator", skp.proceed && skp.summary.status === "skipped_by_operator")
  const usage = evaluateCapture({ status: "usage", error: "LCR_API_KEY not set" })
  check("no key is an unreachable refusal with the reason naming the key", !usage.proceed && /LCR_API_KEY/.test(usage.reason))
  const un = basisGate({}, { mode: "dry", capture: () => { throw new Error("must not fetch") } })
  check("no basis_url -> unchecked, proceed, no fetch", un.proceed && un.summary.status === "unchecked")
  const half = basisGate({ basis_url: "https://www.reuters.com/x" }, { mode: "dry", capture: () => { throw new Error("must not fetch") } })
  check("basis_url without basis_quote -> refuse before any fetch", !half.proceed)
}

console.log("3. paid mode: receipt lookup, never a fetch")
{
  const dir = mkdtempSync(join(tmpdir(), "djzs-receipts-"))
  const now = Date.parse("2026-11-09T20:00:00Z")
  const mk = (name, over) => writeFileSync(join(dir, name + ".json"), JSON.stringify({ url: "https://www.reuters.com/x", captured_at: new Date(now - 3600_000).toISOString(), receipt_sha256: "0x" + name, html_sha256: "0x1", quote: { text: "traders now see a 93% chance", sha256: "0x2", found_at: 5 }, fetcher: { provider: "lcr", source: "livecrawled", country_code: "us", max_age_hours: 0 }, ...over }))
  mk("fresh", {})
  mk("older", { captured_at: new Date(now - 5 * 3600_000).toISOString() })
  mk("cached", { captured_at: new Date(now - 60_000).toISOString(), fetcher: { provider: "lcr", source: "cached", country_code: "us", max_age_hours: 0 } })
  mk("otherquote", { captured_at: new Date(now - 60_000).toISOString(), quote: { text: "a different span", sha256: "0x9", found_at: 1 } })
  const fields = { basis_url: "https://www.reuters.com/x", basis_quote: "traders  now see a 93% chance" }
  const r = basisGate(fields, { mode: "paid", now, receiptsDir: dir, capture: () => { throw new Error("paid must not fetch") } })
  check("paid picks the newest LIVE receipt for the same url+quote (whitespace-normalised), ignoring cached and other-quote receipts", r.proceed && r.summary.receipt_sha256 === "0xfresh", JSON.stringify(r))
  const stale = findFreshReceipt(dir, fields.basis_url, fields.basis_quote, now + 30 * 3600_000)
  check("a receipt older than 24h is stale -> refuse", !stale.proceed && stale.summary.status === "stale" && /re-run --mode dry/.test(stale.reason))
  const none = findFreshReceipt(dir, "https://www.reuters.com/other", "q", now)
  check("no receipt for this url -> stale/refuse, points at the dry run", !none.proceed && /run --mode dry/.test(none.reason))
  const venue = basisGate({ basis_url: "https://polymarket.com/event/x", basis_quote: "84.5c" }, { mode: "paid", now, receiptsDir: dir, capture: () => { throw new Error("paid must not fetch") } })
  check("paid + venue host -> blocked_host, proceed, no receipt needed, no fetch", venue.proceed && venue.summary.status === "blocked_host")
}

console.log("4. one blocked-host list in two files")
{
  const ts = readFileSync(resolve(HERE, "..", "..", "tests", "q3", "source-capture.ts"), "utf8")
  const block = ts.slice(ts.indexOf("LCR_BLOCKED_HOST_PATTERNS: RegExp[] = ["), ts.indexOf("];", ts.indexOf("LCR_BLOCKED_HOST_PATTERNS: RegExp[] = [")))
  const tsPatterns = [...block.matchAll(/\/((?:\\.|[^\/])+)\/i/g)].map((m) => m[1])
  const mjsPatterns = BLOCKED_HOST_PATTERNS.map((p) => p.source)
  check(`same count (${tsPatterns.length})`, tsPatterns.length === mjsPatterns.length && tsPatterns.length > 0, JSON.stringify([tsPatterns.length, mjsPatterns.length]))
  check("same patterns in the same order", JSON.stringify(tsPatterns) === JSON.stringify(mjsPatterns), JSON.stringify({ tsPatterns, mjsPatterns }))
  check("bls.gov, federalreserve.gov, polymarket.com, kalshi.com blocked; reuters, sosovalue not", !!blockedHost("https://www.bls.gov/x") && !!blockedHost("https://www.federalreserve.gov/x") && !!blockedHost("https://polymarket.com/x") && !!blockedHost("https://kalshi.com/x") && !blockedHost("https://www.reuters.com/x") && !blockedHost("https://sosovalue.com/news/x"))
}

console.log("5. the capture script's --json contract, offline (blocked host answers before the key check)")
{
  const env = { ...process.env }; delete env.LCR_API_KEY
  const res = spawnSync("npx", ["tsx", CAPTURE_SCRIPT, "--url", "https://www.bls.gov/news.release/cpi.nr0.htm", "--quote", "x", "--json", "--out", mkdtempSync(join(tmpdir(), "djzs-r-"))], { encoding: "utf8", env, cwd: resolve(HERE, "..", "..") })
  let j = null; try { j = JSON.parse(String(res.stdout).trim().split("\n").pop()) } catch {}
  check("exit 3 and {status: blocked_host} with no key present", res.status === 3 && j?.status === "blocked_host", `exit ${res.status} stdout=${String(res.stdout).slice(0, 120)} stderr=${String(res.stderr).slice(0, 120)}`)
  const res2 = spawnSync("npx", ["tsx", CAPTURE_SCRIPT, "--url", "https://www.reuters.com/x", "--quote", "x", "--json"], { encoding: "utf8", env, cwd: resolve(HERE, "..", "..") })
  let j2 = null; try { j2 = JSON.parse(String(res2.stdout).trim().split("\n").pop()) } catch {}
  check("an allowed host with no key -> exit 2 {status: usage} naming LCR_API_KEY, no request made", res2.status === 2 && j2?.status === "usage" && /LCR_API_KEY/.test(j2?.error ?? ""), `exit ${res2.status} ${String(res2.stdout).slice(0, 160)}`)
  check("the agent's gate reads that as unreachable + refuse", !evaluateCapture(j2).proceed)
}

console.log(`\nBASIS-GATE: ${failures.length ? "FAIL" : "PASS"} (${pass} passed, ${failures.length} failed)`)
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1) }
