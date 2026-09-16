// Exact decimal-string fixed point. The 2026 Kalshi API serves prices as
// dollar strings ("0.6100", 4dp — sub-cent capable) and quantities as
// fractional-contract strings ("400.00", 2dp). No floats anywhere on the
// money path: parse to scaled integers or throw.

/** "0.6100" with scale 4 -> 6100. Throws on junk or precision overflow. */
export function parseFixed(s: string, scale: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal string: ${JSON.stringify(s)}`);
  const [, sign, whole, fracRaw] = m;
  const frac = fracRaw ?? "";
  if (frac.length > scale && !/^0*$/.test(frac.slice(scale))) {
    throw new Error(`precision beyond scale ${scale}: ${s}`);
  }
  const fracPadded = frac.slice(0, scale).padEnd(scale, "0");
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fracPadded || "0");
  const signed = sign === "-" ? -units : units;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`overflow at scale ${scale}: ${s}`);
  }
  return Number(signed);
}

export function formatFixed(units: number, scale: number): string {
  if (!Number.isSafeInteger(units)) throw new Error(`not an integer: ${units}`);
  const sign = units < 0 ? "-" : "";
  const abs = Math.abs(units);
  const base = 10 ** scale;
  const whole = Math.floor(abs / base);
  const frac = String(abs % base).padStart(scale, "0");
  return scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/** Price: integer units of $0.0001 (e4). "0.6100" -> 6100. */
export const parsePriceE4 = (s: string): number => parseFixed(s, 4);
/** Quantity: integer units of 0.01 contracts (e2). "400.00" -> 40000. */
export const parseQtyE2 = (s: string): number => parseFixed(s, 2);
export const formatPriceE4 = (u: number): string => formatFixed(u, 4);
export const formatQtyE2 = (u: number): string => formatFixed(u, 2);
