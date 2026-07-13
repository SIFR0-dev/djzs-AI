/**
 * Live-call instrument for the Step 1 milestone. DJ-terminal tool.
 * MCP client (StreamableHTTPClientTransport, per spec payer-side ruling)
 * against a running Worker, default wrangler dev on localhost. Calls
 * verify_pm_trade, then closes the milestone loop with evidence:
 *   leg 1: retrieve the anchored cert by id (gateway, devnet fallback) and
 *          check the fetched payload against the tool response;
 *   leg 2: retrieve it by the designed tags via bounded GraphQL (the
 *          unbounded form is a proven live timeout).
 *
 * Default intent = calibration case pm-block-008, same source as the anchor
 * instrument, so the live cert should carry the recorded verdict_hash
 * 0x8591..4937 whenever extraction lands the stable way (single divergence is
 * not a finding; extraction is stochastic).
 *
 * Run from repo root, with wrangler dev running in another pane (.dev.vars
 * needs ANTHROPIC_API_KEY and IRYS_UPLOAD_KEY):
 *   npx tsx djzs-trust-mcp/harness/pol-live-call.ts
 *   npx tsx djzs-trust-mcp/harness/pol-live-call.ts --url https://djzs-trust-mcp.easy-less-spoil.workers.dev/mcp
 *   npx tsx djzs-trust-mcp/harness/pol-live-call.ts --intent "..." --target my-agent
 * Exit: 0 milestone legs green; 2 setup; 3 upload error (fail-open observed);
 *       4 anchoring disabled (secret missing); 5 no pol_certificate block;
 *       6 anchored but a retrieval leg failed; 1 unexpected.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { sha256Hex } from "../../server/engine-v2/hash"

const DEFAULT_URL = "http://localhost:8787/mcp"
const DEVNET_NODE = "https://devnet.irys.xyz"
const DATASET_PATH = fileURLToPath(
  new URL("../../server/engine-v2/calibration/calibration-dataset.json", import.meta.url),
)
const ANCHOR_CASE_ID = "pm-block-008"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(code: number, msg: string): never {
  console.error(msg)
  process.exit(code)
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

function defaultIntent(): string {
  const ds = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as { cases: { id: string; intent: string }[] }
  const c = ds.cases.find((x) => x.id === ANCHOR_CASE_ID)
  if (!c) fail(2, `case ${ANCHOR_CASE_ID} not found in ${DATASET_PATH}`)
  return c.intent
}

async function main(): Promise<void> {
  const url = arg("url") ?? DEFAULT_URL
  const intent = arg("intent") ?? defaultIntent()
  const target = arg("target") ?? "pol-live-call"

  console.log(`calling verify_pm_trade at ${url} (target_system=${target})`)
  const client = new Client({ name: "pol-live-call", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  const raw = await client.callTool({ name: "verify_pm_trade", arguments: { intent, target_system: target } })
  await client.close()

  const content = (raw as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.[0]?.text
  if (!text) fail(1, `tool returned no text content: ${JSON.stringify(raw).slice(0, 300)}`)
  const result = JSON.parse(text) as Record<string, unknown>
  console.log("tool response:")
  console.log(JSON.stringify(result, null, 2))

  if (result.in_scope !== true) fail(2, "intent extracted out-of-scope; no certificate expected. Use a PM intent.")
  if (typeof result.verdict_hash !== "string") fail(1, "response has no verdict_hash string.")

  const pol = result.pol_certificate as Record<string, unknown> | undefined
  if (!pol) fail(5, "no pol_certificate block in response. Is this the Step 1 Worker build?")
  if (pol.status === "disabled") fail(4, `anchoring disabled: ${pol.detail}. Set IRYS_UPLOAD_KEY in .dev.vars and restart wrangler dev.`)
  if (pol.status === "error") fail(3, `fail-open observed, upload failed: ${pol.detail}. Check devnet balance (pol-devnet-fund.ts status).`)
  if (pol.status !== "anchored") fail(1, `unknown pol_certificate.status: ${JSON.stringify(pol)}`)

  const irysId = String(pol.irys_id)
  const auditId = String(pol.audit_id)
  console.log(`anchored: ${irysId} (audit_id ${auditId})`)

  // Leg 1: retrieval by id. gateway_url first; devnet-direct fallback resolves
  // the open question of whether the public gateway serves devnet items.
  let fetched: string | undefined
  let servedBy: string | undefined
  for (const u of [String(pol.gateway_url), `${DEVNET_NODE}/tx/${irysId}/data`]) {
    const r = await fetchText(u)
    console.log(`GET ${u} -> ${r.status}`)
    if (r.status === 200 && r.text.length > 0) {
      fetched = r.text
      servedBy = u
      break
    }
  }
  let leg1 = false
  if (fetched && servedBy) {
    const cert = JSON.parse(fetched) as Record<string, unknown>
    const hashMatch = cert.verdict_hash === result.verdict_hash
    const intentAbsent = !fetched.includes(intent)
    // Exact commitment check: recompute sha256Hex over the intent we sent and
    // require byte-identity. A prior revision of this line sniffed for a bare
    // 64-char hex from memory; repo convention is 0x-prefixed (shared/hash.ts:47)
    // and the first live cert was flagged RED by its own checker. Compare
    // against the instrument, never a remembered format.
    const commitment = cert.intent_sha256 === sha256Hex(intent)
    console.log(`leg 1 retrieval by id: served by ${servedBy}`)
    console.log(`  verdict_hash match: ${hashMatch}; intent absent from cert: ${intentAbsent}; intent_sha256 exact: ${commitment}`)
    leg1 = hashMatch && intentAbsent && commitment
  } else {
    console.log("leg 1 retrieval by id: FAILED on both gateway and devnet-direct")
  }

  // Leg 2: retrieval by designed tags, bounded GraphQL (unbounded is a proven
  // live timeout). Devnet indexing can lag; retry a few times.
  const from = Date.now() - 2 * 3600 * 1000
  const to = Date.now() + 2 * 3600 * 1000
  const query = `query { transactions(tags: [{name: "Protocol", values: ["ProofOfLogic"]}, {name: "audit-id", values: ["${auditId}"]}], timestamp: {from: ${from}, to: ${to}}, first: 10, order: DESC) { edges { node { id tags { name value } } } } }`
  let leg2 = false
  for (let attempt = 1; attempt <= 6 && !leg2; attempt++) {
    const r = await fetchText(`${DEVNET_NODE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
    const ids: string[] = []
    try {
      const parsed = JSON.parse(r.text) as { data?: { transactions?: { edges?: Array<{ node: { id: string } }> } } }
      for (const e of parsed.data?.transactions?.edges ?? []) ids.push(e.node.id)
    } catch {
      /* non-JSON error body; retry */
    }
    console.log(`leg 2 GraphQL attempt ${attempt}: ${r.status}, ids=[${ids.join(", ")}]`)
    leg2 = ids.includes(irysId)
    if (!leg2 && attempt < 6) await new Promise((res) => setTimeout(res, 10000))
  }

  console.log(`MILESTONE LEGS: by-id ${leg1 ? "GREEN" : "RED"}, by-tags ${leg2 ? "GREEN" : "RED"}`)
  if (leg1 && leg2) {
    console.log("POL LIVE CALL: PASS")
    process.exit(0)
  }
  fail(6, "anchored but a retrieval leg failed; do not call the milestone done.")
}

main().catch((e) => {
  console.error("LIVE CALL CRASH:", e instanceof Error ? e.message : e)
  process.exit(1)
})
