/**
 * src/safe-error.ts: the shape rules every caller-facing error value passes through.
 * Offline, no keys. Run from djzs-trust-mcp/:   npx tsx test/safe-error.test.mjs
 */
import { reasonCode, addressOnly, hash32Only, scrub, logFault, FAULTS } from "../src/safe-error.ts"
import { buildTrustWriter } from "../src/trust-writer.ts"
import { breakevenMechanics } from "../src/verify-perp-trade.ts"

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 200)}` : ""}`) }
}

console.log("reasonCode: admits every real x402 reason, rejects what could carry text or a key")
for (const real of [
  "invalid_exact_evm_payload_authorization_valid_after", "invalid_exact_evm_payload_signature", "insufficient_funds",
  "settlement_pending", "unknown", "INVALID_PAYMENT", "PAYMENT_REQUIRED", "SETTLEMENT_FAILED", "PRICE_COMPUTE_FAILED",
]) check(`admits ${real}`, reasonCode(real) === real, reasonCode(real))

const junk = [
  ["a URL", "https://rpc.sentinel.invalid/v2/KEYSENTINEL0123456789abcdef"],
  ["free text", "rejected: insufficient funds for 0xabc"],
  ["a 64-char lowercase hex string (a key or a tx hash without 0x)", "ab".repeat(32)],
  ["a 64-char hex string with digits", "0123456789abcdef".repeat(4)],
  ["a mixed-case token", "Qk3_x9Zp-aLmN0vR7tYh2WcE5uBdJ8sGfK1oXiVyP4zA6nMq"],
  ["a 61-char mixed-case key", "KEYSENTINEL0123456789abcdef0123456789abcdef0123456789abcdef01"],
  ["a 0x-prefixed hash", "0x" + "ab".repeat(32)],
  ["an empty string", ""],
  ["a word over 20 characters", "a".repeat(21)],
  ["more than 8 words", "a_b_c_d_e_f_g_h_i"],
  ["a short URL (under the length cap, no spaces)", "https://x.invalid/k"],
  ["a path-like string", "a/b/c"],
  ["a vendor-key-shaped string (47 chars, hyphens)", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["a number", 42],
  ["an object", { reason: "x" }],
  ["null", null],
]
for (const [what, v] of junk) check(`rejects ${what} -> fallback`, reasonCode(v) === "unknown" && reasonCode(v, "FALLBACK") === "FALLBACK", String(reasonCode(v)))

console.log("addressOnly / hash32Only")
check("an address passes", addressOnly("0x" + "1".repeat(40)) === "0x" + "1".repeat(40))
check("a 39-hex address, a non-string, free text are dropped", addressOnly("0x" + "1".repeat(39)) === undefined && addressOnly(7) === undefined && addressOnly("see https://x") === undefined)
check("a 32-byte hash passes", hash32Only("0x" + "cd".repeat(32)) === "0x" + "cd".repeat(32))
check("a 20-byte value, a URL, an object are dropped for a hash", hash32Only("0x" + "cd".repeat(20)) === undefined && hash32Only("https://x") === undefined && hash32Only({}) === undefined)

console.log("scrub: keeps what the operator needs, redacts what could be a key")
check("a URL becomes [url]", scrub("fetch failed at https://rpc.sentinel.invalid/v2/KEYSENTINEL0123456789abcdef now") === "fetch failed at [url] now")
check("a 0x hex run becomes [hex] (a 32-byte value could be a private key)", scrub("tx 0x" + "ab".repeat(32) + " reverted") === "tx [hex] reverted")
check("a long snake_case facilitator reason is KEPT", scrub("invalid_exact_evm_payload_authorization_valid_after: expired") === "invalid_exact_evm_payload_authorization_valid_after: expired")
check("a long mixed-case token is redacted", scrub("key KEYSENTINEL0123456789abcdef0123456789abcdef rejected") === "key [token] rejected")
check("a long base64-ish token with digits is redacted", scrub("secret Qk3_x9Zp-aLmN0vR7tYh2WcE5uBdJ8sGfK1oXiVyP4zA6nMq ok") === "secret [token] ok")
check("output is capped at 300 characters", scrub("x ".repeat(500)).length <= 300)

console.log("logFault: never becomes a second failure, only logs public reconciliation values in their shape")
{
  const lines = []
  const real = console.error
  console.error = (...a) => { lines.push(a.map(String).join(" ")) }
  try {
    logFault("t.a", new Error("boom https://rpc.sentinel.invalid/KEYSENTINEL0123456789abcdef"), { payer: "0x" + "1".repeat(40), intent_hash: "0x" + "2".repeat(64), transaction: "https://not-a-hash" })
    logFault("t.b", Object.create(null))
    logFault("t.c", { get message() { throw new Error("hostile getter") } })
    logFault("t.d", null)
    logFault("t.e", "a bare string", { payer: "https://x", transaction: 5 })
  } catch (e) {
    check("logFault threw on an exotic thrown value", false, e)
  } finally {
    console.error = real
  }
  check("logFault survived four exotic thrown values", lines.length === 5, `${lines.length} lines`)
  check("the cause is scrubbed (no URL, no key)", !lines.some((l) => l.includes("sentinel.invalid") || l.includes("KEYSENTINEL")), lines[0])
  check("a valid payer / hash are logged; a non-hash transaction is dashed", lines[0].includes("payer=0x" + "1".repeat(40)) && lines[0].includes("intent_hash=0x" + "2".repeat(64)) && lines[0].endsWith("tx=-"), lines[0])
  check("junk context values are dashed, not logged", lines[4].includes("payer=-") && lines[4].includes("tx=-"), lines[4])
}

console.log("the app's error handler (index.ts): the same fixed answer as Hono's default, logged through logFault")
{
  const { app } = await import("../src/index.ts")
  const lines = []
  const real = console.error
  console.error = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(" ")) }
  let res
  try {
    // A writer key at the curve order's floor makes describeWriterKey throw from /health/writer.
    res = await app.request("http://worker.invalid/health/writer", {}, { DJZS_WRITER_KEY: "0x" + "00".repeat(32) })
  } finally {
    console.error = real
  }
  const text = await res.text()
  check("500 with the fixed text", res.status === 500 && text === "Internal Server Error", `${res.status} ${text}`)
  check("one scrubbed log line ([fault] route.unhandled), not the raw error object with its stack", lines.length === 1 && lines[0].startsWith("[fault] route.unhandled") && !/\n\s+at /.test(lines[0]), lines.join(" | ").slice(0, 240))
}

console.log("a REAL trust-score write failing: the response and the log carry codes, never the RPC URL (viem begins its error with it)")
{
  const realFetch = globalThis.fetch
  const SENT = "https://rpc.sentinel.invalid/v2/KEYSENTINEL0123456789abcdef"
  globalThis.fetch = async () => new Response(`rpc said no ${SENT}`, { status: 500 })
  const lines = []
  const realErr = console.error, realLog = console.log
  console.error = (...a) => { lines.push(a.map(String).join(" ")) }
  console.log = (...a) => { lines.push(a.map(String).join(" ")) }
  let out
  try {
    const write = buildTrustWriter("0x" + "22".repeat(32), SENT)
    out = await write({ agentAddress: "0x" + "1".repeat(40), riskScore: 10, verdict: "PASS", flags: [], irysTxId: "B".repeat(43) })
  } finally {
    console.error = realErr; console.log = realLog; globalThis.fetch = realFetch
  }
  const dump = JSON.stringify(out)
  check("status error, detail is the fixed code trust_write_failed, error_class from the closed vocabulary", out.status === "error" && out.detail === "trust_write_failed" && /^(rate_limited|insufficient_gas_funds|nonce_conflict|reverted|timeout|unauthorized_writer|network|unknown)$/.test(out.error_class), dump.slice(0, 200))
  check("NO part of the RPC URL in the result", !dump.includes("sentinel.invalid") && !dump.includes("KEYSENTINEL"), dump.slice(0, 200))
  check("the cause IS in the log (the [trust-writer] WRITE FAILED line) ...", lines.some((l) => l.includes("[trust-writer] WRITE FAILED")), lines.join(" | ").slice(0, 200))
  check("... scrubbed: no part of the RPC URL in any log line", !lines.some((l) => l.includes("sentinel.invalid") || l.includes("KEYSENTINEL")), lines.join(" | ").slice(0, 300))
  // viem's fallback transport surfaces the LAST transport's error (a public RPC), so the sentinel itself cannot appear here;
  // the proof that scrub() ran on this line is that the request body's addresses (0x + 40 hex) are redacted too.
  const failedLine = lines.find((l) => l.includes("[trust-writer] WRITE FAILED")) ?? ""
  check("... and the WRITE FAILED line went through scrub(): no 0x-run survives in it, no URL either", failedLine.length > 0 && !/0x[0-9a-fA-F]{16,}/.test(failedLine) && !/https?:\/\//.test(failedLine), failedLine.slice(0, 240))
}

console.log("mechanics.breakeven.reason: a known validation sentence is relayed, anything else is bracket_invalid")
{
  const bad = breakevenMechanics({ side: "long", entry: 100, stop: 110, target: 120, taker_fee_bps: 1 })
  check("a backwards long relays its own sentence", bad.status === "invalid" && bad.reason === "a long needs stop < entry < target", JSON.stringify(bad))
  const nan = breakevenMechanics({ side: "short", entry: Number.NaN, stop: 1, target: 1, taker_fee_bps: 1 })
  check("non-positive prices relay theirs", nan.status === "invalid" && nan.reason === "entry, stop and target must be positive prices", JSON.stringify(nan))
  const odd = breakevenMechanics({ side: "flat", entry: 100, stop: 100, target: 120, taker_fee_bps: 1 })
  check("an error outside the known sentences (floorDiv's own) becomes bracket_invalid, never its text", odd.status === "invalid" && odd.reason === "bracket_invalid", JSON.stringify(odd))
}

console.log("FAULTS")
check("the vocabulary has no duplicates and every code is snake_case", new Set(FAULTS).size === FAULTS.length && FAULTS.every((f) => /^[a-z][a-z0-9_]*$/.test(f)))

if (failures.length) {
  console.error(`\nSAFE-ERROR: FAIL (${failures.length} of ${checks} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nSAFE-ERROR: PASS (${checks} checks)`)
