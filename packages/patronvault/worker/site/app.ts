/**
 * The member page's wallet layer. Reads come from the Worker's /patron/api; every write is a transaction the
 * member signs in their own wallet (injected EIP-1193 provider: Coinbase Wallet, MetaMask, Rabby). The page
 * holds no key and calls no server for writes. Bundled by esbuild into assets/patron/app.js.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem"
import { base } from "viem/chains"
import { erc20Abi, vaultAbi } from "../src/abi"

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (ev: string, cb: (...a: unknown[]) => void) => void }
declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

interface Status {
  chainId: number
  rpcUrl: string
  block: string
  now: string
  vault: Address
  asset: Address
  minDeposit: string
  period: string
  termsHash: Hex
  servedTermsHash: Hex
  termsMatch: boolean
  maxTotalPrincipal: string
  joinDeadline: string
  yieldSink: Address
  feeBps: string
  totalPrincipal: string
  memberCount: string
  payee: Address | null
  payeeMin: string
  creatorRegistry: Address
  settleInterval: string
  sinkShares: string
  source: { address: Address; totalAssets: string; oneShare: string; maxWithdraw: string }
}

interface MemberView {
  address: Address
  member: { principal: string; shares: string; joinedAt: string; lastSettled: string; funded: boolean }
  routes: Array<{ creator: Address; amountPerPeriod: string; carry: string }>
  positionValue: string
  inShortfall: boolean
  preview: [string, string, string]
  patronOfPayee: boolean | null
  payeeFloor: string
  usdcBalance: string
  allowance: string
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const usdc = (units: string | bigint) => Number(formatUnits(BigInt(units), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4)
const when = (unix: string | bigint) => (BigInt(unix) === 0n ? "none" : new Date(Number(unix) * 1000).toISOString().slice(0, 10))

const PLAIN: Record<string, string> = {
  BadTerms: "the terms hash the page sent does not match the contract: do not join from this page until /patron/health shows termsMatch true",
  AlreadyMember: "this wallet is already a member; use deposit, not join",
  NotMember: "this wallet is not a member",
  BelowMinimum: "below the minimum deposit, or a withdrawal that would leave less than the minimum (take it all instead)",
  ExceedsPrincipal: "more than your deposit",
  TooManyRoutes: "16 routes is the limit",
  BelowCreatorMinimum: "the creator set a higher minimum per 30 days",
  ZeroAddress: "the creator address is empty",
  SelfRoute: "you cannot route to yourself",
  OwedButIlliquid: "the source cannot pay what this route is still owed today; try again when it is liquid",
  CapReached: "the pilot's cap on total deposits is reached",
  JoinClosed: "the join window has closed",
  YieldNotClaimable: "this vault is principal-only: there is nothing for a member to claim",
  TransferFailed: "the USDC transfer failed: check your balance and allowance",
  InvalidRecipient: "the vault, its source and USDC itself cannot be creators",
  SettleTooSoon: "someone else settled this member less than a day ago; the member can settle at any time",
  InsufficientGas: "the wallet set too low a gas limit for a payout; raise it (a settle needs about 2.6M)",
  SourceOutOfGas: "the yield source needed more gas than a payout allows; nothing was changed",
  CreatorNotAllowed: "this vault routes only to the creators fixed in it at deployment",
  NothingParked: "nothing is parked for the sink",
}

function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    const name = r?.data?.errorName
    if (name) return `${name}: ${PLAIN[name] ?? "the contract refused this"}`
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}

let status: Status | null = null
let account: Address | null = null
let me: MemberView | null = null

// the same RPC the Worker reads from, so the page and the API never disagree about which chain state they show
let publicClient = createPublicClient({ chain: base, transport: http() })

function wallet() {
  if (!window.ethereum) throw new Error("no wallet found in this browser")
  return createWalletClient({ chain: base, transport: custom(window.ethereum) })
}

function say(line: string, kind: "ok" | "wait" | "fail" = "wait") {
  const log = $("log")
  const row = document.createElement("div")
  row.className = "row " + kind
  row.textContent = `${new Date().toISOString().slice(11, 19)}  ${line}`
  log.prepend(row)
}

async function loadStatus() {
  const r = await fetch("/patron/api/status", { cache: "no-store" })
  if (!r.ok) throw new Error(`status ${r.status}`)
  status = (await r.json()) as Status
  const s = status
  publicClient = createPublicClient({ chain: base, transport: http(s.rpcUrl) })
  $("vault").textContent = s.vault
  $("vault").setAttribute("href", `https://basescan.org/address/${s.vault}`)
  $("source").textContent = s.source.address
  $("source").setAttribute("href", `https://basescan.org/address/${s.source.address}`)
  $("terms-hash").textContent = s.termsHash
  $("terms-match").textContent = s.termsMatch ? "OK  served text hashes to the contract's termsHash" : "XX  served text does NOT hash to the contract's termsHash: do not join"
  $("terms-match").className = s.termsMatch ? "ok" : "fail"
  $("members").textContent = `${s.memberCount}`
  $("principal").textContent = `${usdc(s.totalPrincipal)} / ${BigInt(s.maxTotalPrincipal) === 0n ? "no cap" : usdc(s.maxTotalPrincipal)} USDC`
  $("min").textContent = `${usdc(s.minDeposit)} USDC`
  $("deadline").textContent = when(s.joinDeadline)
  $("mode").textContent = s.yieldSink.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "members keep unrouted yield" : "principal-only: members never receive yield"
  $("fee").textContent = `${Number(s.feeBps) / 100}%`
  $("payee").textContent = s.payee ?? "not set"
  $("registry").textContent = s.creatorRegistry.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "any address" : `fixed at deployment (${short(s.creatorRegistry)})`
  $("block").textContent = s.block
  const joinInput = $("join-amount") as HTMLInputElement
  if (!joinInput.value) joinInput.value = formatUnits(BigInt(s.minDeposit), 6)
  const routeInput = $("route-creator") as HTMLInputElement
  if (!routeInput.value && s.payee) routeInput.value = s.payee
  ;($("join-btn") as HTMLButtonElement).disabled = !s.termsMatch
}

async function loadTerms() {
  const r = await fetch("/patron/terms", { cache: "no-store" })
  $("terms-text").textContent = await r.text()
  $("terms-served").textContent = r.headers.get("x-terms-keccak256") ?? ""
}

async function loadMember() {
  if (!account) return
  const r = await fetch(`/patron/api/member/${account}`, { cache: "no-store" })
  if (!r.ok) throw new Error(`member ${r.status}`)
  me = (await r.json()) as MemberView
  const m = me
  const isMember = BigInt(m.member.principal) > 0n
  $("acct").textContent = account
  $("usdc-balance").textContent = `${usdc(m.usdcBalance)} USDC`
  $("position").hidden = !isMember
  $("join").hidden = isMember
  if (isMember) {
    $("deposit").textContent = `${usdc(m.member.principal)} USDC`
    const oneShare = status ? BigInt(status.source.oneShare) / 1_000_000n + 2n : 2n
    const gap = BigInt(m.member.principal) - BigInt(m.positionValue)
    $("value").textContent = `${usdc(m.positionValue)} USDC${m.inShortfall ? (gap <= oneShare ? "  (one share of the source's deposit rounding; interest covers it within minutes)" : "  (below deposit: the source took a loss; see terms 6)") : ""}`
    $("joined").textContent = when(m.member.joinedAt)
    $("last-settled").textContent = when(m.member.lastSettled)
    const floor = usdc(m.payeeFloor)
    $("funded").textContent = m.patronOfPayee === null ? (m.member.funded ? "OK  funded at the last settle" : "XX  not covered at the last settle") : m.patronOfPayee ? `OK  patron of the Scan Room at ${floor} USDC per 30 days or more, covered by yield right now` : `XX  not a patron right now: no route of at least ${floor} USDC per 30 days, or the yield does not cover it`
    $("funded").className = (m.patronOfPayee ?? m.member.funded) ? "ok" : "fail"
    const [owed, fromYield, pay] = m.preview
    $("preview").textContent = `owed ${usdc(owed)}  ·  yield covers ${usdc(fromYield)}  ·  payable today ${usdc(pay)}`
    const rows = m.routes.map((r) => `<tr><td><a href="https://basescan.org/address/${r.creator}">${short(r.creator)}</a></td><td>${usdc(r.amountPerPeriod)} USDC / 30d</td><td>${status?.payee && r.creator.toLowerCase() === status.payee.toLowerCase() ? (m.patronOfPayee ? "patron" : "lapsed") : ""}</td></tr>`)
    $("routes").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="3" class="muted">no routes yet</td></tr>`
    ;($("withdraw-amount") as HTMLInputElement).placeholder = `up to ${formatUnits(BigInt(m.member.principal), 6)}`
  }
}

type Call = { address: Address; abi: typeof vaultAbi | typeof erc20Abi; functionName: string; args?: readonly unknown[] }
type SimulateArgs = Parameters<typeof publicClient.simulateContract>[0]

/** Simulate first, so a transaction that would revert is refused here with the contract's own error in plain
 *  language, and the wallet only ever sees a call that passes. Then send and wait for the receipt. */
async function tx(label: string, call: Call) {
  if (!account) return say("connect a wallet first", "fail")
  try {
    const { request } = await publicClient.simulateContract({ ...(call as unknown as object), account } as SimulateArgs)
    say(`${label}: confirm in your wallet`)
    const hash = await wallet().writeContract(request as never)
    say(`${label}: sent ${short(hash)}, waiting`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    say(`${label}: ${receipt.status === "success" ? "OK" : "XX reverted"}  ${hash}`, receipt.status === "success" ? "ok" : "fail")
    await Promise.all([loadStatus(), loadMember()])
  } catch (e) {
    say(`${label}: XX ${explain(e)}`, "fail")
  }
}

async function connect() {
  try {
    const w = wallet()
    const [addr] = await w.requestAddresses()
    const chainId = await w.getChainId()
    if (chainId !== base.id) {
      await w.switchChain({ id: base.id })
    }
    account = addr
    $("connect").textContent = short(addr)
    await loadMember()
    say(`connected ${addr}`, "ok")
  } catch (e) {
    say(`connect: XX ${explain(e)}`, "fail")
  }
}

function wire() {
  $("connect").addEventListener("click", connect)
  $("join-btn").addEventListener("click", async () => {
    if (!status || !account) return say("connect a wallet first", "fail")
    if (!($("terms-ok") as HTMLInputElement).checked) return say("read the terms and tick the box first", "fail")
    const amount = parseUnits(($("join-amount") as HTMLInputElement).value || "0", 6)
    const allowance = me ? BigInt(me.allowance) : 0n
    if (allowance < amount) {
      await tx("approve USDC", { address: status.asset, abi: erc20Abi, functionName: "approve", args: [status.vault, amount] })
      await loadMember()
      if (me && BigInt(me.allowance) < amount) return
    }
    await tx("join", { address: status.vault, abi: vaultAbi, functionName: "join", args: [amount, status.termsHash] })
  })
  $("route-btn").addEventListener("click", async () => {
    if (!status || !account) return say("connect a wallet first", "fail")
    const creator = ($("route-creator") as HTMLInputElement).value.trim() as Address
    const per = parseUnits(($("route-amount") as HTMLInputElement).value || "0", 6)
    await tx("set route", { address: status.vault, abi: vaultAbi, functionName: "setRoute", args: [creator, per] })
  })
  $("settle-btn").addEventListener("click", async () => {
    if (!status || !account) return say("connect a wallet first", "fail")
    await tx("settle", { address: status.vault, abi: vaultAbi, functionName: "settle", args: [account] })
  })
  $("withdraw-btn").addEventListener("click", async () => {
    if (!status || !account) return say("connect a wallet first", "fail")
    const amount = parseUnits(($("withdraw-amount") as HTMLInputElement).value || "0", 6)
    await tx("withdraw", { address: status.vault, abi: vaultAbi, functionName: "withdraw", args: [amount] })
  })
  $("leave-btn").addEventListener("click", async () => {
    if (!status || !account) return say("connect a wallet first", "fail")
    if (!confirm("Leave: your whole deposit comes back, your routes are cleared, and the yield buffer goes to your creators. Continue?")) return
    await tx("leave", { address: status.vault, abi: vaultAbi, functionName: "leave" })
  })
  window.ethereum?.on?.("accountsChanged", () => {
    account = null
    me = null
    $("connect").textContent = "connect wallet"
    $("position").hidden = true
    $("join").hidden = true
  })
}

async function main() {
  wire()
  $("js-state").textContent = "live"
  try {
    await Promise.all([loadStatus(), loadTerms()])
  } catch (e) {
    say(`load: XX ${explain(e)}`, "fail")
  }
}

main()
