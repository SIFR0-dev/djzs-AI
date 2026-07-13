/**
 * PoL certificate assembly + Irys anchoring for verify_pm_trade results.
 *
 * INVARIANT (PHASE2_SPEC.md, "Invariant: verdict_hash unchanged"): this module
 * consumes a FINISHED audit result. Nothing here feeds the verdict_hash
 * preimage; intent_sha256 is a downstream commitment over the already-audited
 * intent text, computed after the verdict exists. GATE after wiring this in:
 * anchor-pm-block-008 re-run, exit 0, hash byte-identical.
 *
 * Runtime duality, deliberate:
 *  - Worker bundle (wrangler, workerd/browser conditions): the native keccak +
 *    secp256k1 imports inside @irys/bundles resolve to those packages' pure-JS
 *    browser-field fallbacks (keccak -> js.js, secp256k1 -> elliptic.js);
 *    nodejs_compat v2 provides global Buffer. Proven bundleable and
 *    signing-valid under workerd conditions (session instrument 2026-07-12).
 *  - Node harness (tsx): the same specifier resolves the node build. Same
 *    source, both runtimes.
 *
 * Seam: UploadFn mirrors the ModelFn seam in verify-pm-trade.ts. The offline
 * harness stubs ONLY the HTTP POST; payload assembly, tagging, and real
 * ANS-104 signing execute for real, no network, no funded key.
 *
 * Zero MCP-SDK / zod / hono imports here: the Step 2 McpAgent migration
 * carries this file unchanged, outside every pin conflict listed in the spec.
 */
import { EthereumSigner, createData } from "@irys/bundles/web"
import { sha256Hex } from "../../server/engine-v2/hash"

export const POL_SCHEMA = "DJZS-PoL-1"
/** Content retrieval base. Devnet retrievability is verified at live-harness time. */
export const POL_GATEWAY_BASE = "https://gateway.irys.xyz"
/**
 * Irys token route segment (upload protocol: POST {node}/tx/{token}, raw signed
 * DataItem bytes, application/octet-stream — read from @irys/upload-core 0.0.10
 * dist, the published artifact, not memory). D3 ruling 2026-07-12: devnet first;
 * devnet balances come from the faucet.
 */
export const POL_UPLOAD_TOKEN = "base-eth"

/** The injectable network seam. Takes raw signed DataItem bytes, returns the Irys tx id. */
export type UploadFn = (rawDataItem: Uint8Array) => Promise<{ id: string }>

export interface PolTag {
  name: string
  value: string
}

export interface PolBuildInputs {
  /** Finished runVerifyPmTrade response. Must be in_scope === true with a verdict. */
  result: Record<string, unknown>
  /** The exact intent string the audit ran on. Hashed into the cert; NEVER published. */
  intent: string
  /** Optional caller-supplied Target-System tag value (D4 ruling: optional tool input). */
  targetSystem?: string
  /** Unique id of this audit INSTANCE (deterministic engine => identical verdict_hash across runs is expected). */
  auditId: string
  issuedAtMs: number
}

export interface PolCertificate {
  payload: Record<string, unknown>
  tags: PolTag[]
}

export interface AnchoredPol {
  irys_id: string
  gateway_url: string
  audit_id: string
  verdict_hash: string
}

/**
 * Assemble the certificate. Refuses anything that is not an in-scope audit
 * result carrying a verdict_hash — a cert for a non-audit would be a
 * fabricated attestation.
 *
 * D1 ruling 2026-07-12: full response mirror + intent_sha256 commitment; raw
 * intent text stays off-chain.
 */
export function buildPolCertificate(inputs: PolBuildInputs): PolCertificate {
  const { result, intent, targetSystem, auditId, issuedAtMs } = inputs

  if (result.in_scope !== true || result.verdict == null) {
    throw new Error("PoL certificate refused: not an in-scope audit result (nothing to certify).")
  }
  const verdictHash = result.verdict_hash
  if (typeof verdictHash !== "string" || !verdictHash.startsWith("0x")) {
    throw new Error("PoL certificate refused: result carries no verdict_hash string.")
  }
  const verdict = String(result.verdict)

  const payload: Record<string, unknown> = {
    pol_schema: POL_SCHEMA,
    tool: "verify_pm_trade",
    schema_version: result.schema_version ?? "DJZS-ENGINE-V2",
    // The taxonomy hash block, verbatim from the tool response (d92aa6c).
    taxonomy: result.taxonomy ?? null,
    verdict,
    action: result.action ?? null,
    risk_score: result.risk_score ?? null,
    flags: result.flags ?? [],
    unknown_fields: result.unknown_fields ?? [],
    // The sha256Hex engine artifact — never the v1 keccak TRACE hash (spec A2).
    verdict_hash: verdictHash,
    // Commits to WHAT was audited without publishing the thesis (D1 ruling).
    intent_sha256: sha256Hex(intent),
    extraction: {
      n: 3,
      disagreements: result.disagreements ?? [],
      failsafe: result.extraction_failsafe ?? false,
    },
    issued_at_ms: issuedAtMs,
    issuer: { name: "djzs-trust-mcp", version: "1.0.0" },
    audit_id: auditId,
  }

  // Tag contract: the deployed query side (src/index.ts) filters on
  // Protocol + application-id always, and optionally Target-System / verdict /
  // tier; it reads audit-id off the tags. Emitting anything less makes the
  // cert invisible to the existing tool.
  const tags: PolTag[] = [
    { name: "Protocol", value: "ProofOfLogic" },
    { name: "application-id", value: "DJZS-Oracle" },
    { name: "verdict", value: verdict },
    { name: "tier", value: "micro" },
    { name: "audit-id", value: auditId },
    { name: "verdict-hash", value: verdictHash },
    { name: "pol-schema", value: POL_SCHEMA },
    { name: "Content-Type", value: "application/json" },
  ]
  if (targetSystem) tags.push({ name: "Target-System", value: targetSystem })

  return { payload, tags }
}

/**
 * 32-char random anchor, transport-level uniqueness ONLY. The engine is
 * deterministic: identical theses produce identical payloads, and without an
 * anchor two identical uploads could collapse to one DataItem id. Mirrors what
 * @irys/upload-core does on every upload. verdict_hash is untouched by this.
 */
function randomAnchor32(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).slice(0, 32)
}

/** Sign the certificate into a raw ANS-104 DataItem. Pure of network. */
export async function signPolCertificate(
  cert: PolCertificate,
  privateKeyHex: string,
): Promise<{ raw: Uint8Array; id: string }> {
  const key = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex
  const signer = new EthereumSigner(key)
  const item = createData(JSON.stringify(cert.payload), signer, {
    tags: cert.tags,
    anchor: randomAnchor32(),
  })
  await item.sign(signer)
  return { raw: item.getRaw(), id: item.id }
}

/** build -> sign -> upload. The only network I/O is via the injected uploadFn. */
export async function anchorPolCertificate(
  inputs: PolBuildInputs,
  privateKeyHex: string,
  uploadFn: UploadFn,
): Promise<AnchoredPol> {
  const cert = buildPolCertificate(inputs)
  const { raw } = await signPolCertificate(cert, privateKeyHex)
  const { id } = await uploadFn(raw)
  return {
    irys_id: id,
    gateway_url: `${POL_GATEWAY_BASE}/${id}`,
    audit_id: inputs.auditId,
    verdict_hash: cert.payload.verdict_hash as string,
  }
}

/**
 * The real UploadFn. Protocol read from the published @irys/upload-core 0.0.10
 * artifact: POST {node}/tx/{token}; 201 is an error signal carrying a message
 * body; 402 is an unfunded balance.
 */
export function buildIrysUploadFn(nodeUrl: string, token: string = POL_UPLOAD_TOKEN): UploadFn {
  return async (rawDataItem: Uint8Array) => {
    const res = await fetch(new URL(`/tx/${token}`, nodeUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: rawDataItem as unknown as BodyInit,
    })
    if (res.status === 201 || res.status === 402 || !res.ok) {
      const detail = (await res.text()).slice(0, 300)
      const hint = res.status === 402 ? " (unfunded upload balance for this token)" : ""
      throw new Error(`Irys upload rejected: ${res.status}${hint}: ${detail}`)
    }
    const receipt = (await res.json()) as { id?: string }
    if (!receipt.id) {
      throw new Error("Irys upload returned 2xx but no id in receipt body.")
    }
    return { id: receipt.id }
  }
}
