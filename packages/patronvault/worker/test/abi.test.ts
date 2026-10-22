import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { toFunctionSelector, toEventSelector, type AbiFunction, type AbiEvent } from "viem"
import { vaultAbi } from "../src/abi"

/** The hand-written ABI must agree with the compiled contract: every function and event here exists
 *  there with the same selector. Needs `forge build` to have run in ../ (the artifact is gitignored). */
const ARTIFACT = new URL("../../out/PatronVault.sol/PatronVault.json", import.meta.url)

test("vaultAbi selectors all exist in the compiled PatronVault artifact", { skip: !existsSync(ARTIFACT) && "run `forge build` in packages/patronvault first" }, () => {
  const compiled = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi as Array<AbiFunction | AbiEvent | { type: string }>
  const fns = new Set(compiled.filter((x): x is AbiFunction => x.type === "function").map((f) => toFunctionSelector(f)))
  const evs = new Set(compiled.filter((x): x is AbiEvent => x.type === "event").map((e) => toEventSelector(e)))
  const errs = new Set(compiled.filter((x) => x.type === "error").map((e) => (e as unknown as { name: string }).name))
  for (const item of vaultAbi) {
    if (item.type === "function") assert.ok(fns.has(toFunctionSelector(item)), `function ${item.name} is not in the artifact with this signature`)
    else if (item.type === "event") assert.ok(evs.has(toEventSelector(item)), `event ${item.name} is not in the artifact with this signature`)
    else if (item.type === "error") assert.ok(errs.has(item.name), `error ${item.name} is not in the artifact`)
  }
})
