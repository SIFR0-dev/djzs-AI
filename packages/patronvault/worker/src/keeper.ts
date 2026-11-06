/**
 * The keeper's decisions, as pure functions so they are testable without a chain.
 *
 * Policy: a member is settled once per period, on their own anniversary, not every run. `funded` (and so
 * `isPatron`) is only as fresh as the last settle, and a settle that finds less yield than the time since the
 * last one is owed forgives the difference and clears `funded`. Settling a member every few hours would turn the
 * source's rounding (one share kept back per settle) and the first hours of a period, when little yield has
 * accrued, into forgiven amounts. One settle per full period pays the creator the whole period at once.
 */

export type Address = `0x${string}`

export interface MemberSnapshot {
  address: Address
  principal: bigint
  lastSettled: bigint
}

export interface RunPlan {
  /** members to settle this run, in registry order */
  due: Address[]
  /** `due` cut into settleMany calls */
  batches: Address[][]
  /** registry entries with no principal: left, never to be scanned again unless they rejoin (a new Joined event) */
  prune: Address[]
  /** members kept in the registry after pruning */
  keep: Address[]
}

/** True when a full period has passed since the member's last settle. */
export function isDue(m: MemberSnapshot, now: bigint, period: bigint): boolean {
  return m.principal > 0n && now - m.lastSettled >= period
}

/** [from, to] inclusive ranges of at most `chunk` blocks covering from..to; empty when from > to. */
export function blockRanges(from: bigint, to: bigint, chunk: bigint): Array<{ from: bigint; to: bigint }> {
  if (chunk <= 0n) throw new Error("chunk must be positive")
  const out: Array<{ from: bigint; to: bigint }> = []
  for (let a = from; a <= to; a += chunk) {
    const b = a + chunk - 1n < to ? a + chunk - 1n : to
    out.push({ from: a, to: b })
  }
  return out
}

export function batches<T>(xs: T[], size: number): T[][] {
  if (size <= 0) throw new Error("batch size must be positive")
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Lower-cased, de-duplicated, sorted union of the registry and newly seen members. */
export function mergeRegistry(existing: string[], seen: string[]): Address[] {
  const set = new Set<string>()
  for (const a of [...existing, ...seen]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue
    set.add(a.toLowerCase())
  }
  return [...set].sort() as Address[]
}

export function planRun(input: { members: MemberSnapshot[]; now: bigint; period: bigint; batchSize: number }): RunPlan {
  const due: Address[] = []
  const prune: Address[] = []
  const keep: Address[] = []
  for (const m of input.members) {
    if (m.principal === 0n) {
      prune.push(m.address)
      continue
    }
    keep.push(m.address)
    if (isDue(m, input.now, input.period)) due.push(m.address)
  }
  return { due, batches: batches(due, input.batchSize), prune, keep }
}
