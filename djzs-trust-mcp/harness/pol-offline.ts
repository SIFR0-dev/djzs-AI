/**
 * Offline PoL write harness. ZERO network, ZERO funded key, ZERO Anthropic —
 * the UploadFn seam is stubbed; payload assembly, tagging, and real ANS-104
 * signing execute for real (node build of @irys/bundles; the Worker resolves
 * the same source through its web/pure-JS path, proven separately).
 *
 * Run from the repo root (same convention as the calibration anchor):
 *   npx tsx djzs-trust-mcp/harness/pol-offline.ts
 * Exit 0 => every check passed, final line "POL OFFLINE HARNESS: PASS".
 * Exit 1 => a numbered check failed. Live uploads NEVER happen here.
 */
import { DataItem } from "@irys/bundles"
import {
  anchorPolCertificate,
  buildPolCertificate,
  signPolCertificate,
  POL_GATEWAY_BASE,
  POL_SCHEMA,
  type UploadFn,
} from "../src/pol-certificate"
import { sha256Hex } from "../../server/engine-v2/hash"

// Throwaway, never-funded key. Signing is offline; nothing custodial here.
const TEST_KEY = "11".repeat(32)

// Frozen fixture mirroring the committed response shape (verify-pm-trade.ts:92-112),
// populated with the recorded first-external-audit artifact (CLAUDE.md / spec A6):
// FAIL, M03+M04, risk 40, the 0x8591..4937 verdict_hash.
const FIXTURE_RESULT: Record<string, unknown> = {
  schema_version: "DJZS-ENGINE-V2",
  tool: "verify_pm_trade",
  in_scope: true,
  taxonomy: {
    perp: "v1.x-placeholder",
    pm: "pm-v1-placeholder",
    weights_hash: "wh-placeholder",
    taxonomy_hash: "th-placeholder",
    pm_weights_hash: "pwh-placeholder",
    pm_taxonomy_hash: "pth-placeholder",
  },
  verdict: "FAIL",
  action: "FAIL",
  risk_score: 40,
  flags: [
    { code: "M03", title: "probability unsourced", severity: "major" },
    { code: "M04", title: "consensus-as-edge", severity: "advisory" },
  ],
  unknown_fields: [],
  disagreements: ["stop_loss"],
  verdict_hash: "0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937",
  extraction_failsafe: false,
}

const FIXTURE_INTENT =
  "Buy YES on the pm-block-008 market because the crowd is obviously wrong and it feels certain to resolve yes."

let checks = 0
function check(n: number, name: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) {
    console.error(`CHECK ${n} FAIL: ${name}${detail ? ` :: ${detail}` : ""}`)
    process.exit(1)
  }
  console.log(`CHECK ${n} ok: ${name}`)
}

function tagValue(tags: Array<{ name: string; value: string }>, name: string): string | undefined {
  return tags.find((t) => t.name === name)?.value
}

async function main(): Promise<void> {
  const auditId = "harness-audit-0001"
  const issuedAtMs = 1752300000000

  // --- 1. Payload contract ---
  const cert = buildPolCertificate({
    result: FIXTURE_RESULT,
    intent: FIXTURE_INTENT,
    targetSystem: "vugola-agent",
    auditId,
    issuedAtMs,
  })
  check(1, "payload.verdict_hash identical to engine result", cert.payload.verdict_hash === FIXTURE_RESULT.verdict_hash)
  check(2, "payload.intent_sha256 commits to the exact intent", cert.payload.intent_sha256 === sha256Hex(FIXTURE_INTENT))
  check(3, "raw intent text NOT in payload", !("intent" in cert.payload) && !JSON.stringify(cert.payload).includes(FIXTURE_INTENT))
  check(4, "pol_schema + audit_id present", cert.payload.pol_schema === POL_SCHEMA && cert.payload.audit_id === auditId)
  check(5, "taxonomy block carried verbatim", JSON.stringify(cert.payload.taxonomy) === JSON.stringify(FIXTURE_RESULT.taxonomy))

  // --- 2. Tag contract (deployed query side, src/index.ts:33-39 as committed) ---
  const t = cert.tags
  check(6, "Protocol=ProofOfLogic", tagValue(t, "Protocol") === "ProofOfLogic")
  check(7, "application-id=DJZS-Oracle", tagValue(t, "application-id") === "DJZS-Oracle")
  check(8, "verdict tag matches result", tagValue(t, "verdict") === "FAIL")
  check(9, "tier=micro", tagValue(t, "tier") === "micro")
  check(10, "audit-id tag", tagValue(t, "audit-id") === auditId)
  check(11, "Target-System from D4 optional input", tagValue(t, "Target-System") === "vugola-agent")
  check(12, "verdict-hash + pol-schema + Content-Type tags", tagValue(t, "verdict-hash") === FIXTURE_RESULT.verdict_hash && tagValue(t, "pol-schema") === POL_SCHEMA && tagValue(t, "Content-Type") === "application/json")
  const noTarget = buildPolCertificate({ result: FIXTURE_RESULT, intent: FIXTURE_INTENT, auditId, issuedAtMs })
  check(13, "Target-System omitted when input absent", tagValue(noTarget.tags, "Target-System") === undefined)

  // --- 3. Real signing, parsed back and verified ---
  const signed = await signPolCertificate(cert, TEST_KEY)
  const parsed = new DataItem(Buffer.from(signed.raw))
  check(14, "signed DataItem verifies", await parsed.isValid())
  check(15, "parsed id matches signed id", parsed.id === signed.id)
  const parsedTags = parsed.tags as Array<{ name: string; value: string }>
  check(16, "tags roundtrip byte-exact", JSON.stringify(parsedTags) === JSON.stringify(cert.tags))
  const parsedPayload = JSON.parse(parsed.rawData.toString("utf8"))
  check(17, "payload roundtrip byte-exact", JSON.stringify(parsedPayload) === JSON.stringify(cert.payload))
  check(18, "anchor present (transport uniqueness)", typeof parsed.anchor === "string" && parsed.anchor.length > 0)
  const signedAgain = await signPolCertificate(cert, TEST_KEY)
  check(19, "identical cert, distinct DataItem ids (anchor)", signedAgain.id !== signed.id)

  // --- 4. Orchestration through the stub seam ---
  const calls: Uint8Array[] = []
  const stubUpload: UploadFn = async (raw) => {
    calls.push(raw)
    return { id: "STUB-IRYS-ID-0001" }
  }
  const anchored = await anchorPolCertificate(
    { result: FIXTURE_RESULT, intent: FIXTURE_INTENT, targetSystem: "vugola-agent", auditId, issuedAtMs },
    TEST_KEY,
    stubUpload,
  )
  check(20, "exactly one upload call", calls.length === 1)
  check(21, "uploaded bytes are a valid DataItem", await new DataItem(Buffer.from(calls[0])).isValid())
  check(22, "gateway_url composed from stub id", anchored.gateway_url === `${POL_GATEWAY_BASE}/STUB-IRYS-ID-0001`)
  check(23, "anchored result echoes verdict_hash + audit_id", anchored.verdict_hash === FIXTURE_RESULT.verdict_hash && anchored.audit_id === auditId)

  // --- 5. Refusals ---
  let refusedOutOfScope = false
  try {
    buildPolCertificate({
      result: { ...FIXTURE_RESULT, in_scope: false, verdict: null },
      intent: FIXTURE_INTENT,
      auditId,
      issuedAtMs,
    })
  } catch {
    refusedOutOfScope = true
  }
  check(24, "out-of-scope result refused (no cert for a non-audit)", refusedOutOfScope)
  let refusedNoHash = false
  try {
    const { verdict_hash: _dropped, ...rest } = FIXTURE_RESULT
    buildPolCertificate({ result: rest, intent: FIXTURE_INTENT, auditId, issuedAtMs })
  } catch {
    refusedNoHash = true
  }
  check(25, "result without verdict_hash refused", refusedNoHash)
  const failingUpload: UploadFn = async () => {
    throw new Error("stub: Irys upload rejected: 402")
  }
  let uploadErrorPropagated = false
  try {
    await anchorPolCertificate({ result: FIXTURE_RESULT, intent: FIXTURE_INTENT, auditId, issuedAtMs }, TEST_KEY, failingUpload)
  } catch {
    uploadErrorPropagated = true
  }
  check(26, "upload failure rejects (index.ts fail-open catches it)", uploadErrorPropagated)

  console.log(`POL OFFLINE HARNESS: PASS (${checks} checks)`)
}

main().catch((e) => {
  console.error("HARNESS CRASH:", e)
  process.exit(1)
})
