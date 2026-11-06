import { test } from "node:test"
import assert from "node:assert/strict"
import { batches, blockRanges, isDue, mergeRegistry, planRun, type MemberSnapshot } from "../src/keeper"

const PERIOD = 2_592_000n // 30 days
const A = "0x00000000000000000000000000000000000000a1" as const
const B = "0x00000000000000000000000000000000000000b2" as const
const C = "0x00000000000000000000000000000000000000c3" as const

test("isDue: a member is due exactly when a full period has passed since their last settle, and never with no principal", () => {
  const m: MemberSnapshot = { address: A, principal: 3_500_000_000n, lastSettled: 1_000n }
  assert.equal(isDue(m, 1_000n + PERIOD - 1n, PERIOD), false)
  assert.equal(isDue(m, 1_000n + PERIOD, PERIOD), true)
  assert.equal(isDue(m, 1_000n + 10n * PERIOD, PERIOD), true)
  assert.equal(isDue({ ...m, principal: 0n }, 1_000n + 10n * PERIOD, PERIOD), false)
})

test("blockRanges: inclusive chunks that cover from..to exactly once, empty when nothing to scan", () => {
  assert.deepEqual(blockRanges(10n, 9n, 5n), [])
  assert.deepEqual(blockRanges(10n, 10n, 5n), [{ from: 10n, to: 10n }])
  assert.deepEqual(blockRanges(10n, 24n, 5n), [
    { from: 10n, to: 14n },
    { from: 15n, to: 19n },
    { from: 20n, to: 24n },
  ])
  assert.deepEqual(blockRanges(10n, 22n, 5n), [
    { from: 10n, to: 14n },
    { from: 15n, to: 19n },
    { from: 20n, to: 22n },
  ])
  assert.throws(() => blockRanges(1n, 2n, 0n))
})

test("batches: settleMany calls of at most the batch size", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(batches([], 2), [])
  assert.throws(() => batches([1], 0))
})

test("mergeRegistry: lower-cased, de-duplicated, sorted; junk dropped", () => {
  const r = mergeRegistry([B, "0x00000000000000000000000000000000000000A1"], [A, "not-an-address", C])
  assert.deepEqual(r, [A, B, C])
})

test("planRun: due members batched in order, left members pruned, the rest kept", () => {
  const now = 100_000n + PERIOD
  const members: MemberSnapshot[] = [
    { address: A, principal: 3_500_000_000n, lastSettled: 100_000n }, // due
    { address: B, principal: 0n, lastSettled: 100_000n }, // left: prune
    { address: C, principal: 3_500_000_000n, lastSettled: 100_001n }, // one second short: not due
  ]
  const plan = planRun({ members, now, period: PERIOD, batchSize: 10 })
  assert.deepEqual(plan.due, [A])
  assert.deepEqual(plan.batches, [[A]])
  assert.deepEqual(plan.prune, [B])
  assert.deepEqual(plan.keep, [A, C])
})
