/**
 * Irys funding utility for the PoL upload key, devnet OR mainnet. DJ-terminal
 * tool; never runs in the Worker. Reads the key from ../.dev.vars (gitignored)
 * and NEVER prints it; only the address is printed. Supersedes pol-devnet-fund.ts.
 *
 * Deliberate key separation (dedicated-mainnet-key ruling 2026-07-14):
 *   devnet  -> IRYS_UPLOAD_KEY   (the base-sepolia throwaway)
 *   mainnet -> IRYS_MAINNET_KEY  (a fresh key holding REAL Base ETH)
 * The harness reads the key that matches the chosen network, so a mainnet run
 * can never grab the devnet throwaway and vice versa.
 *
 * Protocol (from @irys/upload-core fund.js, published client not memory): send
 * Base ETH on-chain to the node's base-eth deposit address, then POST
 * /account/balance/base-eth {tx_id}; the node answers 202 and credits.
 *
 * Run from repo root:
 *   npx tsx djzs-trust-mcp/harness/pol-irys-fund.ts                 devnet status
 *   npx tsx djzs-trust-mcp/harness/pol-irys-fund.ts --node mainnet  mainnet status
 *   npx tsx djzs-trust-mcp/harness/pol-irys-fund.ts --node mainnet fund 0.002
 * Exit: 0 ok, 2 precondition (missing key, empty wallet, wrong chain), 1 unexpected.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { Wallet } from "@ethersproject/wallet"
import { JsonRpcProvider } from "@ethersproject/providers"
import { BigNumber } from "@ethersproject/bignumber"

const TOKEN = "base-eth"
const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url))

interface NetCfg {
  node: string
  rpc: string
  chainId: number
  keyVar: string
  recordedDeposit: string
  maxEth: number
  defaultEth: number
}
const NETS: Record<string, NetCfg> = {
  devnet: {
    node: "https://devnet.irys.xyz",
    rpc: "https://sepolia.base.org",
    chainId: 84532,
    keyVar: "IRYS_UPLOAD_KEY",
    recordedDeposit: "0x853758425e953739F5438fd6fd0Efe04A477b039", // /info 2026-07-12
    maxEth: 0.05,
    defaultEth: 0.001,
  },
  mainnet: {
    node: "https://uploader.irys.xyz",
    rpc: "https://mainnet.base.org",
    chainId: 8453,
    keyVar: "IRYS_MAINNET_KEY",
    recordedDeposit: "0x32Ed3Dc90CD5AE7b875A0ee7A86CA6D2fc72c635", // /info 2026-07-14
    // Tighter caps: this is REAL money. ~$0.0004 per 2 KB cert, so 0.002 ETH is
    // ~16k uploads; the 0.01 ceiling is a fat-finger guard, not a target.
    maxEth: 0.01,
    defaultEth: 0.002,
  },
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function fail(code: number, msg: string): never {
  console.error(msg)
  process.exit(code)
}

function loadKey(keyVar: string): string {
  let raw: string
  try {
    raw = readFileSync(DEV_VARS_PATH, "utf8")
  } catch {
    fail(2, `No .dev.vars at ${DEV_VARS_PATH}. Set ${keyVar} first.`)
  }
  const re = new RegExp(`(?:^|\\n)\\s*${keyVar}\\s*=\\s*"?(?:0x)?([0-9a-fA-F]{64})"?`)
  const m = raw.match(re)
  if (!m) fail(2, `${keyVar} not found in .dev.vars or not a 64-hex-char key.`)
  return m[1]
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}
async function getText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return await res.text()
}

async function main(): Promise<void> {
  const netName = arg("node") ?? "devnet"
  const cfg = NETS[netName]
  if (!cfg) fail(2, `Unknown --node "${netName}". Use devnet or mainnet.`)
  // positional mode/amount, skipping the --node <name> pair
  const positionals = process.argv.slice(2).filter((a, i, arr) => {
    if (a === "--node") return false
    if (i > 0 && arr[i - 1] === "--node") return false
    return !a.startsWith("--")
  })
  const mode = positionals[0] ?? "status"

  const wallet = new Wallet(loadKey(cfg.keyVar)).connect(new JsonRpcProvider(cfg.rpc))
  console.log(`network: ${netName} (${cfg.node}); key var: ${cfg.keyVar}`)
  console.log(`address: ${wallet.address}`)

  const info = await getJson(`${cfg.node}/info`)
  const depositAddress = (info.addresses as Record<string, string>)[TOKEN]
  if (!depositAddress) fail(2, `${netName} /info returned no deposit address for ${TOKEN}.`)
  console.log(`deposit address (live /info): ${depositAddress} ${depositAddress === cfg.recordedDeposit ? "(matches recorded)" : "(CHANGED vs recorded)"}`)

  console.log(`price for 2048 bytes: ${await getText(`${cfg.node}/price/${TOKEN}/2048`)} wei`)

  const chainBal = await wallet.getBalance()
  console.log(`${netName} wallet balance: ${chainBal.toString()} wei`)
  console.log(`irys upload balance: ${JSON.stringify(await getJson(`${cfg.node}/account/balance/${TOKEN}?address=${wallet.address}`))}`)

  if (mode === "status") {
    console.log(netName === "mainnet"
      ? `Next: send Base MAINNET ETH to the address above, then rerun with "fund".`
      : `Next: faucet base-sepolia ETH to the address above, then rerun with "fund".`)
    process.exit(0)
  }
  if (mode !== "fund") fail(2, `Unknown mode "${mode}". Use status or "fund [amountEth]".`)

  const network = await wallet.provider.getNetwork()
  if (network.chainId !== cfg.chainId) {
    fail(2, `RPC chainId ${network.chainId} is not ${netName} ${cfg.chainId}. Refusing to send.`)
  }

  const amountEth = Number(positionals[1] ?? String(cfg.defaultEth))
  if (!Number.isFinite(amountEth) || amountEth <= 0 || amountEth > cfg.maxEth) {
    fail(2, `Refusing amount ${positionals[1]}: must be a number in (0, ${cfg.maxEth}] for ${netName}.`)
  }
  const valueWei = BigNumber.from((BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n).toString())
  const gasPrice = await wallet.provider.getGasPrice()
  const headroom = gasPrice.mul(21000).mul(3)
  if (chainBal.lt(valueWei.add(headroom))) {
    fail(2, `Wallet balance ${chainBal.toString()} wei cannot cover ${valueWei.toString()} + gas. Fund the address above first.`)
  }

  console.log(`sending ${valueWei.toString()} wei to ${depositAddress} on ${netName}...`)
  const tx = await wallet.sendTransaction({ to: depositAddress, value: valueWei })
  console.log(`deposit tx: ${tx.hash}`)
  await tx.wait(1)
  console.log("mined (1 confirmation). Notifying node...")

  // Success shape differs by network, both observed live (2026-07-14):
  //   devnet  -> 202 Accepted
  //   mainnet -> 200 {"confirmed":true} (then "Tx already processed (confirmed)")
  // Accept either; {"confirmed":false} is "not yet", keep polling.
  let credited = false
  for (let attempt = 1; attempt <= 18; attempt++) {
    const res = await fetch(`${cfg.node}/account/balance/${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: tx.hash }),
    })
    const body = await res.text()
    const ok =
      res.status === 202 ||
      (res.status === 200 && (/"confirmed"\s*:\s*true/.test(body) || /already processed/i.test(body)))
    if (ok) {
      credited = true
      console.log(`notify accepted (${res.status}) on attempt ${attempt}: ${body.slice(0, 80)}`)
      break
    }
    console.log(`notify attempt ${attempt}: ${res.status} ${body.slice(0, 200)} (retry 5s)`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!credited) fail(1, "Node never confirmed the deposit in 18 attempts. Balance may still credit later; rerun status.")

  console.log(`irys upload balance after funding: ${JSON.stringify(await getJson(`${cfg.node}/account/balance/${TOKEN}?address=${wallet.address}`))}`)
  console.log("FUND: DONE")
  process.exit(0)
}

main().catch((e) => {
  console.error("FUND CRASH:", e instanceof Error ? e.message : e)
  process.exit(1)
})
