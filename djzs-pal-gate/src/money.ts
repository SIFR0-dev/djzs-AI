/**
 * money.ts - USDC amounts as integers, end to end.
 *
 * USDC has 6 decimals. Every amount on the money path is a bigint count of micro-USDC. No float is
 * parsed, produced or compared anywhere in this Worker: a decimal string is split on its point and
 * each half is read as an integer. (deterministic-signal's schema v0.2 rule, applied here: REAL
 * appears nowhere on the money path.)
 *
 * The parser is STRICT on purpose. The value arrives from a language model's tool call, so
 * anything that is not plainly a positive decimal with at most 6 places is `invalid`, never
 * "probably 1.00": no currency symbols, no thousands separators, no exponents, no rounding.
 */

export const USDC_DECIMALS = 6
const MICRO_PER_USDC = 1_000_000n

/**
 * Upper bound on any amount: 9,999,999.999999 USDC. It keeps every amount inside JavaScript's safe
 * integer range, so the value D1 hands back as a number is exactly the value that was stored.
 */
export const MAX_MICRO = 9_999_999_999_999n

/** At most 7 integer digits and at most 6 decimal places. Leading zeros are allowed ("0.50", "007"). */
const AMOUNT_RE = /^(\d{1,7})(?:\.(\d{1,6}))?$/

export type AmountParse = { state: "absent" } | { state: "invalid" } | { state: "present"; micro: bigint }

/**
 * Tool argument -> micro-USDC.
 *
 *   absent   undefined, null, or a blank string
 *   invalid  anything else that is not a positive decimal with at most 6 places
 *   present  the exact integer amount
 *
 * A JSON number is accepted only through its own decimal rendering. String(1.5) is "1.5", which
 * parses; String(1e-7) is "1e-7" and String(0.1 + 0.2) is "0.30000000000000004", which do not.
 * That is the point: a number that does not print as a clean decimal was never a clean amount.
 */
export function parseUsdc(raw: unknown): AmountParse {
  if (raw === undefined || raw === null) return { state: "absent" }
  let s: string
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { state: "invalid" }
    s = String(raw)
  } else if (typeof raw === "string") {
    s = raw.trim()
    if (s === "") return { state: "absent" }
  } else {
    return { state: "invalid" }
  }
  const m = AMOUNT_RE.exec(s)
  if (!m) return { state: "invalid" }
  const whole = BigInt(m[1] as string)
  const frac = BigInt(((m[2] ?? "") + "000000").slice(0, USDC_DECIMALS))
  const micro = whole * MICRO_PER_USDC + frac
  if (micro <= 0n || micro > MAX_MICRO) return { state: "invalid" }
  return { state: "present", micro }
}

/** micro-USDC -> "1.50", "0.000001", "12.00". At least two places, never more than six, no float. */
export function formatUsdc(micro: bigint): string {
  const neg = micro < 0n
  const abs = neg ? -micro : micro
  const whole = abs / MICRO_PER_USDC
  let frac = (abs % MICRO_PER_USDC).toString().padStart(USDC_DECIMALS, "0")
  frac = frac.replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`
}

/**
 * A [vars] limit ("1000000") -> bigint micro-USDC. Anything that is not a plain non-negative
 * integer within range reads as 0, which makes the limit as tight as it can be: a mistyped limit
 * closes the gate's own authority, it never widens it.
 */
export function parseMicroVar(raw: string | undefined): bigint {
  if (typeof raw !== "string" || !/^\d{1,13}$/.test(raw.trim())) return 0n
  const v = BigInt(raw.trim())
  return v > MAX_MICRO ? 0n : v
}

/** bigint micro -> number for D1. Safe by construction (MAX_MICRO), checked anyway. */
export function microToNumber(micro: bigint): number {
  if (micro < 0n || micro > MAX_MICRO) throw new Error("amount out of range")
  return Number(micro)
}

/** D1 number -> bigint micro. Refuses anything that is not a safe non-negative integer. */
export function numberToMicro(n: unknown): bigint {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("stored amount is not a safe integer")
  return BigInt(n)
}
