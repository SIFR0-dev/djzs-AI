/**
 * money: USDC amounts are integers end to end. Offline, no key, no network.
 *
 * Pins:
 *   - a decimal string becomes the exact integer count of micro-USDC, with no float in between;
 *   - anything that is not plainly a positive decimal with at most 6 places is INVALID, never
 *     rounded or repaired (symbols, separators, exponents, 7 places, negatives, zero);
 *   - a JSON number is accepted only when it prints as a clean decimal: 0.1 + 0.2 does not;
 *   - blank is ABSENT, which is a different answer from INVALID;
 *   - formatting never produces a float and round-trips through the parser;
 *   - a mistyped [vars] limit reads as 0, the tightest value, never as "no limit".
 *
 * Run: npx tsx test/money.test.mjs
 */
import { MAX_MICRO, formatUsdc, microToNumber, numberToMicro, parseMicroVar, parseUsdc } from "../src/money.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}
const present = (raw, micro) => { const p = parseUsdc(raw); return p.state === "present" && p.micro === micro }
const state = (raw) => parseUsdc(raw).state

// 1. exact parsing
check(1, "\"1\" is 1000000 micro", present("1", 1_000_000n))
check(2, "\"1.00\" is 1000000 micro", present("1.00", 1_000_000n))
check(3, "\"0.000001\" is 1 micro (the smallest amount)", present("0.000001", 1n))
check(4, "\"0.1\" is 100000 micro, exactly", present("0.1", 100_000n))
check(5, "\"0.30\" is 300000 micro (no 0.1 + 0.2 drift is possible)", present("0.30", 300_000n))
check(6, "\"9999999.999999\" is the maximum", present("9999999.999999", MAX_MICRO))
check(7, "surrounding whitespace is trimmed", present("  2.5  ", 2_500_000n))
check(8, "leading zeros are allowed", present("007.50", 7_500_000n))

// 2. invalid, never repaired
for (const [i, raw] of ["$1.00", "1,000", "1e3", "1.0000001", "-1", "+1", "1.", ".5", "0", "0.000000", "1 USDC", "one", "0x10", "10000000", "1.2.3", "NaN", "Infinity"].entries()) {
  check(`9.${i + 1}`, `${JSON.stringify(raw)} is invalid`, state(raw) === "invalid", state(raw))
}

// 3. JSON numbers
check(10, "number 1.5 is accepted through its own rendering", present(1.5, 1_500_000n))
check(11, "number 2 is accepted", present(2, 2_000_000n))
check(12, "0.1 + 0.2 is invalid (it prints 17 places)", state(0.1 + 0.2) === "invalid")
check(13, "1e-7 is invalid (it prints as an exponent)", state(1e-7) === "invalid")
check(14, "1e21 is invalid", state(1e21) === "invalid")
check(15, "NaN and Infinity are invalid", state(NaN) === "invalid" && state(Infinity) === "invalid")
check(16, "negative and zero numbers are invalid", state(-1) === "invalid" && state(0) === "invalid")

// 4. absent is not invalid
check(17, "undefined, null and blank are absent", state(undefined) === "absent" && state(null) === "absent" && state("") === "absent" && state("   ") === "absent")
check(18, "an object, an array or a boolean is invalid, not absent", state({}) === "invalid" && state([]) === "invalid" && state(true) === "invalid")

// 5. formatting
check(19, "1000000 formats as 1.00", formatUsdc(1_000_000n) === "1.00")
check(20, "1500000 formats as 1.50", formatUsdc(1_500_000n) === "1.50")
check(21, "1 formats as 0.000001", formatUsdc(1n) === "0.000001")
check(22, "1234567 formats as 1.234567", formatUsdc(1_234_567n) === "1.234567")
check(23, "0 formats as 0.00", formatUsdc(0n) === "0.00")
let roundTrip = true
for (const m of [1n, 10n, 999_999n, 1_000_000n, 1_000_001n, 123_456_789n, MAX_MICRO]) {
  const back = parseUsdc(formatUsdc(m))
  if (back.state !== "present" || back.micro !== m) roundTrip = false
}
check(24, "format then parse returns the same integer", roundTrip)

// 6. limits from [vars]
check(25, "\"1000000\" reads as 1000000", parseMicroVar("1000000") === 1_000_000n)
check(26, "a missing limit reads as 0", parseMicroVar(undefined) === 0n)
check(27, "a mistyped limit reads as 0, never as unlimited", parseMicroVar("1.5") === 0n && parseMicroVar("1e6") === 0n && parseMicroVar("-1") === 0n && parseMicroVar("lots") === 0n)
check(28, "a limit above the maximum reads as 0", parseMicroVar("99999999999999") === 0n)

// 7. the D1 boundary
check(29, "micro to number and back is exact at the maximum", numberToMicro(microToNumber(MAX_MICRO)) === MAX_MICRO && Number.isSafeInteger(microToNumber(MAX_MICRO)))
let threw = 0
for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 2, "1", null]) { try { numberToMicro(bad) } catch { threw++ } }
check(30, "a stored amount that is not a safe non-negative integer is refused", threw === 5, `threw ${threw}/5`)

console.log(failures.length ? `\nMONEY: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nMONEY: PASS (${pass} checks)`)
process.exit(failures.length ? 1 : 0)
