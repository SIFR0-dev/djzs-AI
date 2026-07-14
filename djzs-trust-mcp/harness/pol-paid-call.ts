/**
 * Step 2 rehearsal instrument: x402 payer-side dress rehearsal for the paid
 * verify_pm_trade. DJ-terminal tool, never the Worker.
 *
 * Two gates in one run, expected outputs stated in advance:
 *   GATE U (unpaid): a plain MCP client calls the paid tool and MUST be
 *     refused with the payment-required shape (isError, PAYMENT_REQUIRED /
 *     402 marker). If the tool answers without payment, that is a compliance
 *     failure and this exits 3, loudly.
 *   GATE P (paid): withX402Client signs EIP-3009 for the 0.25 USDC price
 *     (maxPaymentValue raised to exactly 250000 atomic; the library default
 *     of 0.10 USDC would refuse our price), the facilitator verifies and
 *     settles, and the tool returns the full audit WITH pol_certificate
 *     anchored. Then both retrieval legs run as in pol-live-call.
 *
 * Payer key: X402_PAYER_KEY in ../.dev.vars (gitignored; never printed).
 * The payer needs base USDC only; gas is facilitator-paid (Step 0
 * proved the payer's sent-tx count stays zero).
 *
 * Run from repo root, wrangler dev up with doctrine flags:
 *   npx tsx djzs-trust-mcp/harness/pol-paid-call.ts
 *   npx tsx djzs-trust-mcp/harness/pol-paid-call.ts --url <worker>/mcp --target djzs-protocol
 * Exit: 0 all gates green; 2 setup; 3 UNPAID CALL WAS NOT REFUSED; 4 paid
 * call failed; 5 paid result missing pol_certificate; 6 anchored but a
 * retrieval leg failed; 1 crash.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { withX402Client } from "agents/x402"
import { privateKeyToAccount } from "viem/accounts"
import { sha256Hex } from "../../server/engine-v2/hash"

const DEFAULT_URL = "http://localhost:8787/mcp"
const DEVNET_NODE = "https://devnet.irys.xyz"
const NETWORK = "base"
/** 0.25 USDC in atomic units (6 decimals). Exact, least-privilege cap. */
const MAX_PAYMENT_ATOMIC = 250000n
const DATASET_PATH = fileURLToPath(
  new URL("../../server/engine-v2/calibration/calibration-dataset.json", import.meta.url),
)
const ANCHOR_CASE_ID = "pm-block-008"
const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(code: number, msg: string): never {
  console.error(msg)
  process.exit(code)
}

function loadPayerKey(): `0x${string}` {
  let raw: string
  try {
    raw = readFileSync(DEV_VARS_PATH, "utf8")
  } catch {
    fail(2, `No .dev.vars at ${DEV_VARS_PATH}. Add X402_PAYER_KEY (base-sepolia payer burner holding testnet USDC).`)
  }
  const m = raw.match(/(?:^|\n)\s*X402_PAYER_KEY\s*=\s*"?(?:0x)?([0-9a-fA-F]{64})"?/)
  if (!m) fail(2, "X402_PAYER_KEY not found in .dev.vars or not a 64-hex-char key.")
  return `0x${m[1]}`
}

function defaultIntent(): string {
  const ds = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as { cases: { id: string; intent: string }[] }
  const c = ds.cases.find((x) => x.id === ANCHOR_CASE_ID)
  if (!c) fail(2, `case ${ANCHOR_CASE_ID} not found in ${DATASET_PATH}`)
  return c.intent
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 20000)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(t)
  }
}

async function main(): Promise<void> {
  const url = arg("url") ?? DEFAULT_URL
  const intent = arg("intent") ?? defaultIntent()
  const target = arg("target") ?? "djzs-protocol"
  const toolArgs = { intent, target_system: target }

  // GATE U: unpaid refusal.
  console.log(`GATE U: unpaid call to verify_pm_trade at ${url}`)
  const plain = new Client({ name: "pol-paid-call-unpaid", version: "1.0.0" })
  await plain.connect(new StreamableHTTPClientTransport(new URL(url)))
  let unpaidRefused = false
  let unpaidText = ""
  try {
    const res = (await plain.callTool({ name: "verify_pm_trade", arguments: toolArgs })) as {
      isError?: boolean
      content?: Array<{ text?: string }>
    }
    unpaidText = res.content?.[0]?.text ?? JSON.stringify(res)
    unpaidRefused = res.isError === true && /payment[_\s-]?required|402/i.test(unpaidText)
  } catch (e) {
    // A protocol-level payment error is also a refusal.
    unpaidText = e instanceof Error ? e.message : String(e)
    unpaidRefused = /payment[_\s-]?required|402/i.test(unpaidText)
  }
  await plain.close()
  console.log(`  refusal shape: ${unpaidRefused} :: ${unpaidText.slice(0, 200)}`)
  if (!unpaidRefused) {
    fail(3, "COMPLIANCE FAILURE: unpaid call was not refused with a payment-required shape. Halt; do not deploy.")
  }

  // GATE P: paid call through the x402 client.
  console.log("GATE P: paid call (0.25 USDC, base-sepolia, facilitator-settled)")
  const account = privateKeyToAccount(loadPayerKey())
  console.log(`  payer address: ${account.address}`)
  const inner = new Client({ name: "pol-paid-call", version: "1.0.0" })
  await inner.connect(new StreamableHTTPClientTransport(new URL(url)))
  const paidClient = withX402Client(inner, {
    account,
    network: NETWORK,
    maxPaymentValue: MAX_PAYMENT_ATOMIC,
  })
  const paid = (await paidClient.callTool(
    async (reqs) => {
      console.log(`  payment requirements: ${JSON.stringify(reqs).slice(0, 300)}`)
      return true
    },
    { name: "verify_pm_trade", arguments: toolArgs },
  )) as { isError?: boolean; content?: Array<{ text?: string }> }
  await inner.close()
  const text = paid.content?.[0]?.text
  if (paid.isError || !text) fail(4, `paid call failed: ${(text ?? JSON.stringify(paid)).slice(0, 300)}`)
  const result = JSON.parse(text) as Record<string, unknown>
  console.log("tool response:")
  console.log(JSON.stringify(result, null, 2))
  if (result.in_scope !== true || typeof result.verdict_hash !== "string") {
    fail(4, "paid call returned but not an in-scope audit with a verdict_hash.")
  }

  const pol = result.pol_certificate as Record<string, unknown> | undefined
  if (!pol || pol.status !== "anchored") {
    fail(5, `paid result has no anchored pol_certificate: ${JSON.stringify(pol ?? null).slice(0, 200)}`)
  }
  const irysId = String(pol.irys_id)
  const auditId = String(pol.audit_id)
  console.log(`anchored: ${irysId} (audit_id ${auditId})`)

  // Retrieval legs, as in pol-live-call.
  let leg1 = false
  for (const u of [String(pol.gateway_url), `${DEVNET_NODE}/tx/${irysId}/data`]) {
    const r = await fetchText(u)
    console.log(`GET ${u} -> ${r.status}`)
    if (r.status === 200 && r.text.length > 0) {
      const cert = JSON.parse(r.text) as Record<string, unknown>
      leg1 =
        cert.verdict_hash === result.verdict_hash &&
        !r.text.includes(intent) &&
        cert.intent_sha256 === sha256Hex(intent)
      console.log(`leg 1 by id: served by ${u}; checks ${leg1}`)
      break
    }
  }
  const from = Date.now() - 2 * 3600 * 1000
  const to = Date.now() + 2 * 3600 * 1000
  const query = `query { transactions(tags: [{name: "Protocol", values: ["ProofOfLogic"]}, {name: "audit-id", values: ["${auditId}"]}], timestamp: {from: ${from}, to: ${to}}, first: 10, order: DESC) { edges { node { id } } } }`
  let leg2 = false
  for (let attempt = 1; attempt <= 6 && !leg2; attempt++) {
    const r = await fetchText(`${DEVNET_NODE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
    try {
      const parsed = JSON.parse(r.text) as { data?: { transactions?: { edges?: Array<{ node: { id: string } }> } } }
      leg2 = (parsed.data?.transactions?.edges ?? []).some((e) => e.node.id === irysId)
    } catch {
      /* retry */
    }
    console.log(`leg 2 GraphQL attempt ${attempt}: ${r.status}, found=${leg2}`)
    if (!leg2 && attempt < 6) await new Promise((res) => setTimeout(res, 10000))
  }

  console.log(`GATES: unpaid-refusal GREEN, paid-settle GREEN, by-id ${leg1 ? "GREEN" : "RED"}, by-tags ${leg2 ? "GREEN" : "RED"}`)
  if (leg1 && leg2) {
    console.log("POL PAID CALL: PASS")
    process.exit(0)
  }
  fail(6, "paid + anchored but a retrieval leg failed; do not call the rehearsal done.")
}

main().catch((e) => {
  console.error("PAID CALL CRASH:", e instanceof Error ? e.message : e)
  process.exit(1)
})
