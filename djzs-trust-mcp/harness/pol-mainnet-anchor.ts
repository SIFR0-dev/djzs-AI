/**
 * Stage 2 (mainnet path, 2026-07-14): prove mainnet Irys anchoring in PURE
 * ISOLATION. No payment, no Worker, no x402 — the ONLY variable under test is
 * the funded mainnet upload key. Builds a real PoL certificate (the same
 * builder the Worker uses), signs it, uploads it to MAINNET Irys, and proves
 * retrieval by id (gateway) AND by the mainnet GraphQL index — the index that
 * query_pol_certificates reads and that devnet certs never appeared in. A green
 * run here means mainnet anchoring is discharged before any real payment moves.
 *
 * Cost: one ~0.5 KB upload, ~$0.0001 of Base ETH from the funded key. No USDC.
 *
 * Key: IRYS_MAINNET_KEY in ../.dev.vars (the dedicated funded mainnet key;
 * NEVER printed). Fund it first with pol-irys-fund.ts --node mainnet fund.
 *
 * Run from repo root:
 *   npx tsx djzs-trust-mcp/harness/pol-mainnet-anchor.ts
 * Exit: 0 anchored + both retrieval legs green; 2 setup (no key / no balance);
 *       3 upload failed; 4 anchored but a retrieval leg failed; 1 crash.
 */
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import {
  buildPolCertificate,
  signPolCertificate,
  buildIrysUploadFn,
  POL_GATEWAY_BASE,
} from "../src/pol-certificate"
import { sha256Hex } from "../../server/engine-v2/hash"

const MAINNET_NODE = "https://uploader.irys.xyz"
const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url))

function fail(code: number, msg: string): never {
  console.error(msg)
  process.exit(code)
}

function loadMainnetKey(): string {
  let raw: string
  try {
    raw = readFileSync(DEV_VARS_PATH, "utf8")
  } catch {
    fail(2, `No .dev.vars at ${DEV_VARS_PATH}. Set IRYS_MAINNET_KEY (funded mainnet key).`)
  }
  const m = raw.match(/(?:^|\n)\s*IRYS_MAINNET_KEY\s*=\s*"?((?:0x)?[0-9a-fA-F]{64})"?/)
  if (!m) fail(2, "IRYS_MAINNET_KEY not found in .dev.vars or not a 64-hex-char key. Fund it with pol-irys-fund.ts --node mainnet first.")
  return m[1]
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

// Same recorded first-external-audit shape used by pol-offline: a real engine
// result, so the cert is structurally identical to a live one.
const FIXTURE_RESULT: Record<string, unknown> = {
  schema_version: "DJZS-ENGINE-V2",
  tool: "verify_pm_trade",
  in_scope: true,
  taxonomy: { perp: "DJZS-LF-v1.1", pm: "DJZS-PM-v1.0" },
  verdict: "FAIL",
  action: "FAIL",
  risk_score: 40,
  flags: [{ code: "DJZS-M03", title: "probability unsourced", severity: "HIGH" }],
  unknown_fields: [],
  disagreements: [],
  verdict_hash: "0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937",
  extraction_failsafe: false,
}
const FIXTURE_INTENT = "mainnet anchoring isolation probe — pm-block-008 shape, no payment path."

async function main(): Promise<void> {
  const key = loadMainnetKey()
  const auditId = `mainnet-anchor-probe-${Date.now()}`

  const cert = buildPolCertificate({
    result: FIXTURE_RESULT,
    intent: FIXTURE_INTENT,
    targetSystem: "djzs-mainnet-anchor-probe",
    auditId,
    issuedAtMs: Date.now(),
  })
  // Sanity: the cert commits to what we think it does, before we spend anything.
  if (cert.payload.verdict_hash !== FIXTURE_RESULT.verdict_hash) fail(1, "cert verdict_hash mismatch pre-upload")
  if (cert.payload.intent_sha256 !== sha256Hex(FIXTURE_INTENT)) fail(1, "cert intent_sha256 mismatch pre-upload")

  console.log(`uploading real PoL cert to MAINNET Irys (${MAINNET_NODE}) ...`)
  const { raw } = await signPolCertificate(cert, key)
  let irysId: string
  try {
    const uploaded = await buildIrysUploadFn(MAINNET_NODE)(raw)
    irysId = uploaded.id
  } catch (e) {
    fail(3, `mainnet upload failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}. Is IRYS_MAINNET_KEY funded? (pol-irys-fund.ts --node mainnet)`)
  }
  console.log(`ANCHORED (mainnet, PERMANENT): ${irysId}`)
  console.log(`gateway: ${POL_GATEWAY_BASE}/${irysId}`)
  console.log(`audit_id: ${auditId}`)

  // Leg 1: retrieval by id via the public gateway.
  let leg1 = false
  const g = await fetchText(`${POL_GATEWAY_BASE}/${irysId}`)
  console.log(`GET gateway/${irysId} -> ${g.status}`)
  if (g.status === 200 && g.text.length > 0) {
    const back = JSON.parse(g.text) as Record<string, unknown>
    leg1 =
      back.verdict_hash === FIXTURE_RESULT.verdict_hash &&
      !g.text.includes(FIXTURE_INTENT) &&
      back.intent_sha256 === sha256Hex(FIXTURE_INTENT)
    console.log(`leg 1 by id: verdict_hash match + intent absent + commitment = ${leg1}`)
  }

  // Leg 2: retrieval by tags via the MAINNET GraphQL index (bounded per the
  // ab9c1d1 hardening: two+ tag filters + a timestamp window, or it times out).
  const from = Date.now() - 2 * 3600 * 1000
  const to = Date.now() + 2 * 3600 * 1000
  const query = `query { transactions(tags: [{name: "Protocol", values: ["ProofOfLogic"]}, {name: "audit-id", values: ["${auditId}"]}], timestamp: {from: ${from}, to: ${to}}, first: 10, order: DESC) { edges { node { id } } } }`
  let leg2 = false
  for (let attempt = 1; attempt <= 8 && !leg2; attempt++) {
    const r = await fetchText(`${MAINNET_NODE}/graphql`, {
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
    console.log(`leg 2 mainnet GraphQL attempt ${attempt}: ${r.status}, found=${leg2}`)
    if (!leg2 && attempt < 8) await new Promise((res) => setTimeout(res, 10000))
  }

  console.log(`MAINNET ANCHOR LEGS: by-id ${leg1 ? "GREEN" : "RED"}, by-tags ${leg2 ? "GREEN" : "RED"}`)
  if (leg1 && leg2) {
    console.log(`POL MAINNET ANCHOR: PASS (permanent cert ${irysId})`)
    process.exit(0)
  }
  fail(4, "mainnet cert anchored but a retrieval leg failed; do not call mainnet anchoring done.")
}

main().catch((e) => {
  console.error("MAINNET ANCHOR CRASH:", e instanceof Error ? e.message : e)
  process.exit(1)
})
