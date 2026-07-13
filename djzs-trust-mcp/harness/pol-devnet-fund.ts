/**
 * Devnet funding utility for the PoL upload key. DJ-terminal tool; never runs
 * in the Worker. Key custody note: reads IRYS_UPLOAD_KEY from ../.dev.vars
 * (gitignored) and NEVER prints it; the only thing printed is the address.
 *
 * Protocol (read from @irys/upload-core 0.0.10 dist fund.js, the published
 * client, not memory): send base-sepolia ETH on-chain to the devnet deposit
 * address for the token, then POST /account/balance/base-eth {tx_id}; the
 * node answers 202 and credits after verifying the transaction.
 *
 * Run from repo root:
 *   npx tsx djzs-trust-mcp/harness/pol-devnet-fund.ts            status: address, balances, price
 *   npx tsx djzs-trust-mcp/harness/pol-devnet-fund.ts fund       deposit 0.001 base-sepolia ETH
 *   npx tsx djzs-trust-mcp/harness/pol-devnet-fund.ts fund 0.002 deposit a custom amount (max 0.05)
 * Exit: 0 ok, 2 precondition (missing key file, empty wallet, wrong chain), 1 unexpected.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { Wallet } from "@ethersproject/wallet"
import { JsonRpcProvider } from "@ethersproject/providers"
import { BigNumber } from "@ethersproject/bignumber"

const DEVNET_NODE = "https://devnet.irys.xyz"
const TOKEN = "base-eth"
const BASE_SEPOLIA_RPC = "https://sepolia.base.org"
const BASE_SEPOLIA_CHAIN_ID = 84532
/** Recorded from live GET /info on 2026-07-12; the runtime /info value governs. */
const RECORDED_DEPOSIT_ADDRESS = "0x853758425e953739F5438fd6fd0Efe04A477b039"
const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url))

function fail(code: number, msg: string): never {
  console.error(msg)
  process.exit(code)
}

function loadKey(): string {
  let raw: string
  try {
    raw = readFileSync(DEV_VARS_PATH, "utf8")
  } catch {
    fail(2, `No .dev.vars at ${DEV_VARS_PATH}. Copy .dev.vars.example and set IRYS_UPLOAD_KEY (throwaway devnet key).`)
  }
  const m = raw.match(/(?:^|\n)\s*IRYS_UPLOAD_KEY\s*=\s*"?(?:0x)?([0-9a-fA-F]{64})"?/)
  if (!m) fail(2, "IRYS_UPLOAD_KEY not found in .dev.vars or not a 64-hex-char key.")
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
  const mode = process.argv[2] ?? "status"
  const wallet = new Wallet(loadKey()).connect(new JsonRpcProvider(BASE_SEPOLIA_RPC))
  console.log(`address: ${wallet.address}`)

  const info = await getJson(`${DEVNET_NODE}/info`)
  const depositAddress = (info.addresses as Record<string, string>)[TOKEN]
  if (!depositAddress) fail(2, `Devnet /info returned no deposit address for token ${TOKEN}.`)
  console.log(`devnet deposit address (live /info): ${depositAddress} ${depositAddress === RECORDED_DEPOSIT_ADDRESS ? "(matches recorded)" : "(CHANGED vs recorded 2026-07-12)"}`)

  const price2k = await getText(`${DEVNET_NODE}/price/${TOKEN}/2048`)
  console.log(`price for 2048 bytes: ${price2k} wei`)

  const chainBal = await wallet.getBalance()
  console.log(`base-sepolia wallet balance: ${chainBal.toString()} wei`)
  const nodeBal = await getJson(`${DEVNET_NODE}/account/balance/${TOKEN}?address=${wallet.address}`)
  console.log(`devnet upload balance: ${JSON.stringify(nodeBal)}`)

  if (mode === "status") {
    console.log(`Next: faucet base-sepolia ETH to the address above, then rerun with "fund".`)
    process.exit(0)
  }
  if (mode !== "fund") fail(2, `Unknown mode "${mode}". Use no argument for status, or "fund [amountEth]".`)

  const network = await wallet.provider.getNetwork()
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    fail(2, `RPC chainId ${network.chainId} is not base-sepolia ${BASE_SEPOLIA_CHAIN_ID}. Refusing to send.`)
  }

  const amountEth = Number(process.argv[3] ?? "0.001")
  if (!Number.isFinite(amountEth) || amountEth <= 0 || amountEth > 0.05) {
    fail(2, `Refusing amount ${process.argv[3]}: must be a number in (0, 0.05]. This is a throwaway devnet key.`)
  }
  const valueWei = BigNumber.from((BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n).toString())
  const gasPrice = await wallet.provider.getGasPrice()
  const headroom = gasPrice.mul(21000).mul(3)
  if (chainBal.lt(valueWei.add(headroom))) {
    fail(2, `Wallet balance ${chainBal.toString()} wei cannot cover ${valueWei.toString()} wei + gas headroom. Faucet the address above first.`)
  }

  console.log(`sending ${valueWei.toString()} wei to ${depositAddress} on base-sepolia...`)
  const tx = await wallet.sendTransaction({ to: depositAddress, value: valueWei })
  console.log(`deposit tx: ${tx.hash}`)
  await tx.wait(1)
  console.log("mined (1 confirmation). Notifying devnet node...")

  // Mirror of fund.js submitTransaction: POST {tx_id}, expect 202. The node may
  // want more confirmations before accepting; retry with patience.
  let credited = false
  for (let attempt = 1; attempt <= 18; attempt++) {
    const res = await fetch(`${DEVNET_NODE}/account/balance/${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: tx.hash }),
    })
    if (res.status === 202) {
      credited = true
      console.log(`notify accepted (202) on attempt ${attempt}`)
      break
    }
    const body = (await res.text()).slice(0, 200)
    console.log(`notify attempt ${attempt}: ${res.status} ${body} (retrying in 5s)`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!credited) fail(1, "Node never accepted the funding notification (no 202 in 18 attempts). Balance may still credit later; rerun status mode.")

  const after = await getJson(`${DEVNET_NODE}/account/balance/${TOKEN}?address=${wallet.address}`)
  console.log(`devnet upload balance after funding: ${JSON.stringify(after)}`)
  console.log("FUND: DONE")
  process.exit(0)
}

main().catch((e) => {
  console.error("FUND CRASH:", e instanceof Error ? e.message : e)
  process.exit(1)
})
