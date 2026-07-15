/**
 * Phase 3 live write rehearsal (task 22). Tests the on-chain trust-score writer
 * IN ISOLATION: no paid call, no Irys, just the real updateScore tx from the
 * dedicated writer key, then reads it back via getLatestScore. Costs only Base
 * gas (~fraction of a cent). DJ-terminal tool.
 *
 * Prereqs: DJZS_WRITER_KEY in ../.dev.vars, authorized + funded (verify-writer).
 * Run from repo root:
 *   npx tsx djzs-trust-mcp/harness/trust-write-rehearsal.ts
 * Exit: 0 written + read-back matches; 3 write failed/skipped; 4 read mismatch; 1 crash.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { createPublicClient, http } from "viem"
import { base } from "viem/chains"
import { buildTrustWriter, DJZS_TRUST_CONTRACT } from "../src/trust-writer"

const DEV_VARS = fileURLToPath(new URL("../.dev.vars", import.meta.url))
const RPC = "https://mainnet.base.org"
// A real DJ wallet used as the test agent, so getLatestScore is queryable after.
const TEST_AGENT = "0xA06090BC1AD1D969E0B043Ef9284fB5bc7F63B91"
const FIXTURE = { riskScore: 40, verdict: "FAIL", flags: ["DJZS-M03", "DJZS-M04"], irysTxId: "EybaSQYzSfHqZKEjxSnojB6nsKsofCD3rpda8hFqrhfm" }

const GET_LATEST_ABI = [{
  type: "function", name: "getLatestScore", stateMutability: "view",
  inputs: [{ name: "agent", type: "address" }],
  outputs: [
    { name: "riskScore", type: "uint256" },
    { name: "verdict", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "totalAudits", type: "uint256" },
  ],
}] as const

function fail(code: number, msg: string): never { console.error(msg); process.exit(code) }

function loadWriterKey(): string {
  const raw = readFileSync(DEV_VARS, "utf8")
  const m = raw.match(/(?:^|\n)\s*DJZS_WRITER_KEY\s*=\s*"?((?:0x)?[0-9a-fA-F]{64})"?/)
  if (!m) fail(3, "DJZS_WRITER_KEY not found in .dev.vars")
  return m[1]
}

async function main(): Promise<void> {
  const pub = createPublicClient({ chain: base, transport: http(RPC) })

  const before = (await pub.readContract({
    address: DJZS_TRUST_CONTRACT, abi: GET_LATEST_ABI, functionName: "getLatestScore", args: [TEST_AGENT],
  })) as readonly [bigint, string, bigint, bigint]
  console.log(`before: totalAudits=${before[3]} latestVerdict="${before[1]}" latestRisk=${before[0]}`)

  const writeScore = buildTrustWriter(loadWriterKey(), RPC)
  console.log(`writing score for agent ${TEST_AGENT}: risk ${FIXTURE.riskScore}, ${FIXTURE.verdict}, [${FIXTURE.flags}]...`)
  const res = await writeScore({ agentAddress: TEST_AGENT, ...FIXTURE })
  console.log("write result:", JSON.stringify(res))
  if (res.status !== "written") fail(3, `write did not succeed: ${JSON.stringify(res)}`)
  console.log(`tx: https://basescan.org/tx/${res.tx_hash}`)

  // wait for the tx to land, then read back. The public RPC is load-balanced
  // across replicas, so a read right after the receipt can hit a node still
  // behind (observed 2026-07-16); poll until the state catches up.
  const receipt = await pub.waitForTransactionReceipt({ hash: res.tx_hash as `0x${string}` })
  if (receipt.status !== "success") fail(3, `tx mined but REVERTED (status ${receipt.status})`)
  let after = before
  for (let i = 0; i < 8; i++) {
    after = (await pub.readContract({
      address: DJZS_TRUST_CONTRACT, abi: GET_LATEST_ABI, functionName: "getLatestScore", args: [TEST_AGENT],
    })) as readonly [bigint, string, bigint, bigint]
    if (after[3] === before[3] + 1n) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`after:  totalAudits=${after[3]} latestVerdict="${after[1]}" latestRisk=${after[0]}`)

  const ok =
    after[3] === before[3] + 1n &&
    after[1] === FIXTURE.verdict &&
    after[0] === BigInt(FIXTURE.riskScore)
  if (!ok) fail(4, "read-back does not match what we wrote (totalAudits+1, verdict, riskScore)")
  console.log("TRUST WRITE REHEARSAL: PASS (on-chain score written + read back matches)")
  process.exit(0)
}

main().catch((e) => { console.error("REHEARSAL CRASH:", e instanceof Error ? e.message : e); process.exit(1) })
