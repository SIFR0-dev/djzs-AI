/**
 * Q3 daily anchor — Worker side. Reuses the ProofOfLogic anchoring path exactly:
 * EthereumSigner(IRYS_UPLOAD_KEY) → ANS-104 DataItem → POST {IRYS_NODE_URL}/tx/base-eth.
 * The funded key never leaves the Worker. Callers prove intent with DJZS_Q3_ANCHOR_KEY.
 *
 * Payload anchored (public, immutable):
 *   { schema: "DJZS-Q3-Anchor-1", date, protocol_version, record_count, merkle_root, record_hashes, issued_at }
 * Verification: recompute merkle_root from the committed tests/q3/records/<date>.json (see merkleRoot below),
 * fetch gateway.irys.xyz/<id>, compare. Anyone can do this without trusting DJZS or GitHub history.
 */
import { EthereumSigner, createData } from "@irys/bundles/web"
import { buildIrysUploadFn } from "./pol-certificate"

export const Q3_ANCHOR_SCHEMA = "DJZS-Q3-Anchor-1" as const

export interface Q3AnchorRequest {
  date: string                 // YYYY-MM-DD
  protocol_version: string     // e.g. "1.1"
  record_hashes: string[]      // 0x + 64 hex, one per record, any order
}

const HEX32 = /^0x[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Deterministic Merkle root: sort hashes ascending, sha256(a||b) per level, duplicate last on odd, 0x-prefixed. */
export async function merkleRoot(hashes: string[]): Promise<string> {
  const norm = [...new Set(hashes.map(h => h.toLowerCase()))].sort()
  if (norm.length === 0) throw new Error("merkleRoot: no hashes")
  let level = norm.map(h => hexToBytes(h))
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1])
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const cat = new Uint8Array(64); cat.set(level[i], 0); cat.set(level[i + 1], 32)
      next.push(new Uint8Array(await crypto.subtle.digest("SHA-256", cat)))
    }
    level = next
  }
  return "0x" + bytesToHex(level[0])
}

export function validateQ3AnchorRequest(b: unknown): { ok: true; req: Q3AnchorRequest } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "body must be an object" }
  const r = b as Record<string, unknown>
  if (typeof r.date !== "string" || !DATE.test(r.date)) return { ok: false, error: "date must be YYYY-MM-DD" }
  if (typeof r.protocol_version !== "string" || r.protocol_version.length > 16) return { ok: false, error: "protocol_version required" }
  if (!Array.isArray(r.record_hashes) || r.record_hashes.length === 0 || r.record_hashes.length > 500) return { ok: false, error: "record_hashes: 1..500 entries" }
  if (!r.record_hashes.every(h => typeof h === "string" && HEX32.test(h.toLowerCase()))) return { ok: false, error: "record_hashes must be 0x + 64 hex" }
  return { ok: true, req: { date: r.date, protocol_version: r.protocol_version, record_hashes: r.record_hashes as string[] } }
}

/** Constant-time compare for the anchor key header. */
export function keyMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export async function anchorQ3(
  req: Q3AnchorRequest,
  privateKeyHex: string,
  nodeUrl: string,
): Promise<{ irys_id: string; gateway_url: string; merkle_root: string; record_count: number }> {
  const merkle_root = await merkleRoot(req.record_hashes)
  const payload = {
    schema: Q3_ANCHOR_SCHEMA,
    date: req.date,
    protocol_version: req.protocol_version,
    record_count: req.record_hashes.length,
    merkle_root,
    record_hashes: [...new Set(req.record_hashes.map(h => h.toLowerCase()))].sort(),
    issued_at: new Date().toISOString(),
    issuer: { name: "djzs-trust-mcp", route: "/q3/anchor" },
  }
  const tags = [
    { name: "Protocol", value: "ProofOfLogic" },
    { name: "application-id", value: "DJZS-Q3" },
    { name: "q3-schema", value: Q3_ANCHOR_SCHEMA },
    { name: "q3-date", value: req.date },
    { name: "q3-protocol", value: req.protocol_version },
    { name: "q3-root", value: merkle_root },
    { name: "Content-Type", value: "application/json" },
  ]
  const key = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex
  const signer = new EthereumSigner(key)
  const item = createData(JSON.stringify(payload), signer, { tags })
  await item.sign(signer)
  const { id } = await buildIrysUploadFn(nodeUrl)(item.getRaw())
  return { irys_id: id, gateway_url: `https://gateway.irys.xyz/${id}`, merkle_root, record_count: req.record_hashes.length }
}

function hexToBytes(h: string): Uint8Array { const s = h.startsWith("0x") ? h.slice(2) : h; const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out }
function bytesToHex(b: Uint8Array): string { return Array.from(b, x => x.toString(16).padStart(2, "0")).join("") }
