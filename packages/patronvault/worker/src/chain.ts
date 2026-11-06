import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem"
import { base } from "viem/chains"
import { erc20Abi, erc4626Abi, vaultAbi } from "./abi"

export interface Env {
  CHAIN_ID: string
  RPC_URL: string
  VAULT_ADDRESS: string
  DEPLOY_BLOCK: string
  PAYEE_ADDRESS: string
  PAYEE_MIN: string
  DRY_RUN: string
  SCAN_CHUNK: string
  MIN_KEEPER_BALANCE_WEI: string
  KEEPER_KEY?: string
  KEEPER_KV: KVNamespace
  ASSETS: Fetcher
}

export const ZERO = "0x0000000000000000000000000000000000000000" as const

export function isAddress(s: string): s is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

export function vaultAddress(env: Env): Address | null {
  return isAddress(env.VAULT_ADDRESS) && env.VAULT_ADDRESS.toLowerCase() !== ZERO ? (env.VAULT_ADDRESS as Address) : null
}

export function publicClient(env: Env) {
  return createPublicClient({ chain: base, transport: http(env.RPC_URL) })
}

export type Client = ReturnType<typeof publicClient>

export function termsHashOf(text: string): Hex {
  return keccak256(toBytes(text))
}

/** Everything the page shows before a wallet connects, in one multicall. */
export async function readVaultConfig(client: Client, vault: Address) {
  const c = { address: vault, abi: vaultAbi } as const
  const r = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "asset" },
      { ...c, functionName: "source" },
      { ...c, functionName: "minDeposit" },
      { ...c, functionName: "period" },
      { ...c, functionName: "termsHash" },
      { ...c, functionName: "maxTotalPrincipal" },
      { ...c, functionName: "joinDeadline" },
      { ...c, functionName: "yieldSink" },
      { ...c, functionName: "feeBps" },
      { ...c, functionName: "totalPrincipal" },
      { ...c, functionName: "memberCount" },
      { ...c, functionName: "creatorRegistry" },
      { ...c, functionName: "settleInterval" },
      { ...c, functionName: "sinkShares" },
    ],
  })
  const [asset, source, minDeposit, period, termsHash, maxTotalPrincipal, joinDeadline, yieldSink, feeBps, totalPrincipal, memberCount, creatorRegistry, settleInterval, sinkShares] = r
  return { asset, source, minDeposit, period, termsHash, maxTotalPrincipal, joinDeadline, yieldSink, feeBps, totalPrincipal, memberCount, creatorRegistry, settleInterval, sinkShares }
}

export async function readSource(client: Client, source: Address, vault: Address) {
  const s = { address: source, abi: erc4626Abi } as const
  const [totalAssets, oneShare, maxWithdraw] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...s, functionName: "totalAssets" },
      { ...s, functionName: "convertToAssets", args: [1_000_000n] },
      { ...s, functionName: "maxWithdraw", args: [vault] },
    ],
  })
  return { totalAssets, oneShare, maxWithdraw }
}

export function payeeOf(env: Env): Address | null {
  return isAddress(env.PAYEE_ADDRESS) && env.PAYEE_ADDRESS.toLowerCase() !== ZERO ? (env.PAYEE_ADDRESS as Address) : null
}

export function payeeMin(env: Env): bigint {
  return BigInt(env.PAYEE_MIN || "0")
}

export async function readMember(client: Client, vault: Address, member: Address, payee: Address | null, floor: bigint) {
  const c = { address: vault, abi: vaultAbi } as const
  const [m, routes, value, shortfall, preview] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "memberOf", args: [member] },
      { ...c, functionName: "routesOf", args: [member] },
      { ...c, functionName: "positionValue", args: [member] },
      { ...c, functionName: "inShortfall", args: [member] },
      { ...c, functionName: "previewSettle", args: [member] },
    ],
  })
  const patron = payee ? await client.readContract({ ...c, functionName: "isPatronAtLeast", args: [payee, member, floor] }) : null
  return { member: m, routes, positionValue: value, inShortfall: shortfall, preview, patronOfPayee: patron, payeeFloor: floor }
}

export async function readBalance(client: Client, token: Address, who: Address) {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })
}

/** JSON with bigints as decimal strings. */
export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } })
}
