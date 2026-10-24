import { createWalletClient, http, parseAbiItem, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"
import { vaultAbi } from "./abi"
import { type Client, type Env, publicClient, vaultAddress } from "./chain"
import { blockRanges, mergeRegistry, planRun, type MemberSnapshot } from "./keeper"

const KV_MEMBERS = "members"
const KV_SCANNED_TO = "scannedTo"
const KV_LAST_RUN = "lastRun"
const MAX_RANGES_PER_RUN = 60
const BATCH_SIZE = 10
const CONFIRMATIONS_LAG = 2n
/** Gas limit for a settleMany: never the node's estimate. eth_estimateGas searches for the LOWEST gas at which the
 *  transaction does not revert, and the contract catches a failing source withdraw to hold the payment rather than
 *  trap the member, so the lowest such gas is one where the source call itself runs out of gas and the payment is
 *  silently held (seen on a Base fork 2026-10-21: ReentrancySentryOOG inside the aToken burn, CreatorUnpaid emitted,
 *  nothing paid). A budget per member plus a fixed headroom, with gas being cheap on Base, is the honest limit. */
const GAS_BASE = 2_000_000n
const GAS_PER_MEMBER = 600_000n

export interface RunSummary {
  at: string
  vault: Address | null
  dryRun: boolean
  keeper: Address | null
  keeperBalanceWei: string | null
  lowBalance: boolean
  scanned: { from: string; to: string; ranges: number; joined: number } | null
  registry: number
  pruned: number
  due: Address[]
  sent: Array<{ members: Address[]; tx: Hex; status: "success" | "reverted" }>
  skipped: Array<{ member: Address; reason: string }>
  /** parked exit buffers delivered to the sink this run */
  sinkForwarded: { tx: Hex; status: "success" | "reverted" } | null
  errors: string[]
}

const joinedEvent = parseAbiItem("event Joined(address indexed member, uint256 principal, uint256 shares, bytes32 termsHash)")

export async function readLastRun(env: Env): Promise<RunSummary | null> {
  const raw = await env.KEEPER_KV.get(KV_LAST_RUN)
  return raw ? (JSON.parse(raw) as RunSummary) : null
}

export async function readRegistry(env: Env): Promise<Address[]> {
  const raw = await env.KEEPER_KV.get(KV_MEMBERS)
  return raw ? (JSON.parse(raw) as Address[]) : []
}

/** One keeper run: scan for new members, snapshot the registry, settle whoever is due, record the summary. */
export async function runKeeper(env: Env): Promise<RunSummary> {
  const summary: RunSummary = {
    at: new Date().toISOString(),
    vault: vaultAddress(env),
    dryRun: env.DRY_RUN !== "false",
    keeper: null,
    keeperBalanceWei: null,
    lowBalance: false,
    scanned: null,
    registry: 0,
    pruned: 0,
    due: [],
    sent: [],
    skipped: [],
    sinkForwarded: null,
    errors: [],
  }
  try {
    const vault = summary.vault
    if (!vault) throw new Error("VAULT_ADDRESS is not set; nothing to keep")
    const client = publicClient(env)

    // 1. new members since the last scan
    const latest = await client.getBlockNumber()
    const to = latest - CONFIRMATIONS_LAG
    const scannedRaw = await env.KEEPER_KV.get(KV_SCANNED_TO)
    const deployBlock = BigInt(env.DEPLOY_BLOCK || "0")
    const from = scannedRaw ? BigInt(scannedRaw) + 1n : deployBlock
    const chunk = BigInt(env.SCAN_CHUNK || "2000")
    const ranges = blockRanges(from, to, chunk).slice(0, MAX_RANGES_PER_RUN)
    const seen: string[] = []
    let scannedTo = from - 1n
    for (const r of ranges) {
      const logs = await client.getLogs({ address: vault, event: joinedEvent, fromBlock: r.from, toBlock: r.to })
      for (const l of logs) if (l.args.member) seen.push(l.args.member)
      scannedTo = r.to
    }
    const registry = mergeRegistry(await readRegistry(env), seen)
    summary.scanned = { from: from.toString(), to: scannedTo.toString(), ranges: ranges.length, joined: seen.length }

    // 2. who is due: a full period since their last settle
    const [block, snapshots] = await Promise.all([
      client.getBlock({ blockNumber: latest }),
      snapshotMembers(client, vault, registry),
    ])
    const period = await client.readContract({ address: vault, abi: vaultAbi, functionName: "period" })
    const plan = planRun({ members: snapshots, now: block.timestamp, period, batchSize: BATCH_SIZE })
    summary.registry = plan.keep.length
    summary.pruned = plan.prune.length
    summary.due = plan.due
    await env.KEEPER_KV.put(KV_MEMBERS, JSON.stringify(plan.keep))
    if (ranges.length) await env.KEEPER_KV.put(KV_SCANNED_TO, scannedTo.toString())

    // 3. the keeper's own state
    const key = env.KEEPER_KEY
    if (!key) {
      summary.errors.push("KEEPER_KEY is not set; nothing sent")
    } else {
      const account = privateKeyToAccount(key as Hex)
      summary.keeper = account.address
      const balance = await client.getBalance({ address: account.address })
      summary.keeperBalanceWei = balance.toString()
      summary.lowBalance = balance < BigInt(env.MIN_KEEPER_BALANCE_WEI || "0")

      // 4. settle
      const wallet = createWalletClient({ account, chain: base, transport: http(env.RPC_URL) })
      if (!summary.dryRun && plan.due.length) {
        for (const members of plan.batches) {
          try {
            const gas = GAS_BASE + GAS_PER_MEMBER * BigInt(members.length)
            const { request } = await client.simulateContract({
              account,
              address: vault,
              abi: vaultAbi,
              functionName: "settleMany",
              args: [members],
              gas,
            })
            const tx = await wallet.writeContract({ ...request, gas })
            const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 90_000 })
            summary.sent.push({ members, tx, status: receipt.status })
          } catch (e) {
            // one member's settle cannot revert by design, so a failing batch is an RPC or gas problem;
            // record it per member and move on, the next run retries
            const reason = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e)
            for (const m of members) summary.skipped.push({ member: m, reason })
          }
        }
      }

      // 5. parked exit buffers (principal-only mode): deliver to the sink whenever there is something to deliver
      if (!summary.dryRun) {
        const parked = await client.readContract({ address: vault, abi: vaultAbi, functionName: "sinkShares" })
        if (parked > 0n) {
          try {
            const { request } = await client.simulateContract({ account, address: vault, abi: vaultAbi, functionName: "forwardSink", gas: GAS_BASE })
            const tx = await wallet.writeContract({ ...request, gas: GAS_BASE })
            const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 90_000 })
            summary.sinkForwarded = { tx, status: receipt.status }
          } catch (e) {
            // NothingParked (dust) and OwedButIlliquid (the source cannot pay today) are expected; recorded, not retried here
            summary.errors.push("forwardSink: " + (e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e)))
          }
        }
      }
    }
  } catch (e) {
    summary.errors.push(e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e))
  }
  await env.KEEPER_KV.put(KV_LAST_RUN, JSON.stringify(summary))
  return summary
}

async function snapshotMembers(client: Client, vault: Address, registry: Address[]): Promise<MemberSnapshot[]> {
  if (!registry.length) return []
  const results = await client.multicall({
    allowFailure: false,
    contracts: registry.map((member) => ({ address: vault, abi: vaultAbi, functionName: "memberOf" as const, args: [member] as const })),
  })
  return results.map((m, i) => ({ address: registry[i], principal: m.principal, lastSettled: m.lastSettled }))
}
