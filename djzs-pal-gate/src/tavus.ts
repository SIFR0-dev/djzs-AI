/**
 * tavus.ts - is this request really a Tavus tool call, and what does it carry.
 *
 * Tavus delivers a tool call to a customer endpoint as an HTTPS POST. With delivery.api.auth.type
 * "hmac" the body is a fixed envelope and the header X-Tavus-Signature carries the lowercase hex
 * HMAC-SHA256 of THE EXACT BODY BYTES under the shared secret (Tavus docs, Tool Delivery,
 * "Verifying API signatures"). The envelope:
 *
 *   { "name": "<tool name>", "arguments": "<JSON string written by the model>",
 *     "tool_call_id": "...", "conversation_id": "...", "inference_id": "...", "turn_idx": 4 }
 *
 * ORDER MATTERS. The signature is checked against the raw bytes BEFORE anything is parsed. Parsing
 * and re-serialising first would verify a different byte string than the one that was signed.
 *
 * IDEMPOTENCY. Tavus retries a call once on a 5xx or a connection error. Its docs call the envelope
 * field tool_call_id "unique per invocation" and the {tavus_tool_call_id} placeholder "stable
 * across retries"; this gate takes them to be the same id and keys a decision on
 * (conversation_id, tool_call_id). If a retry ever arrived under a new id it would be decided as a
 * new call, and could not be approved twice: the first decision already holds the claim.
 *
 * THE POST-CALL ACTION is delivered through the same delivery.api field, so with auth.type "hmac"
 * it should arrive in the same envelope. The docs do not show a post-call request in hmac mode,
 * and no LLM turn produces it, so tool_call_id, inference_id and turn_idx may be missing there.
 * parsePostCallEnvelope therefore requires only what settling needs: the name and the
 * conversation_id. (README, "Not yet verified against a live Tavus account".)
 */

/** Largest body the gate will read. The envelope for this tool is a few hundred bytes. */
export const MAX_BODY_BYTES = 16 * 1024

const HEX64_RE = /^[0-9a-fA-F]{64}$/
/** Tavus ids are short opaque tokens. Anything else is not stored. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

function hexToBytes(hex: string): ArrayBuffer {
  const buf = new ArrayBuffer(hex.length / 2)
  const out = new Uint8Array(buf)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return buf
}

/**
 * True only when `signatureHex` is the HMAC-SHA256 of `rawBody` under `secret`.
 * crypto.subtle.verify does the comparison, so it is constant-time; a header that is not exactly
 * 64 hex characters is refused before any key is touched.
 */
export async function verifyTavusSignature(secret: string, rawBody: ArrayBuffer, signatureHex: string | null | undefined): Promise<boolean> {
  if (typeof secret !== "string" || secret === "") return false
  if (typeof signatureHex !== "string") return false
  const sig = signatureHex.trim()
  if (!HEX64_RE.test(sig)) return false
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
  return crypto.subtle.verify("HMAC", key, hexToBytes(sig), rawBody)
}

export interface ToolEnvelope {
  name: string
  /** The model's raw arguments, exactly as received. */
  argumentsJson: string
  tool_call_id: string
  conversation_id: string
}

type EnvelopeError = { ok: false; error: "invalid_json" | "bad_envelope" }
export type EnvelopeParse = { ok: true; envelope: ToolEnvelope } | EnvelopeError

function decodeObject(rawBody: ArrayBuffer): { ok: true; b: Record<string, unknown> } | EnvelopeError {
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody))
  } catch {
    return { ok: false, error: "invalid_json" }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_envelope" }
  return { ok: true, b: body as Record<string, unknown> }
}

/**
 * Raw (already verified) body -> envelope. `arguments` is documented as a JSON-encoded string; an
 * object is tolerated and re-encoded so a change on Tavus's side degrades to "read it anyway"
 * instead of "refuse every call". Everything else must be exactly as documented.
 */
export function parseEnvelope(rawBody: ArrayBuffer): EnvelopeParse {
  const decoded = decodeObject(rawBody)
  if (!decoded.ok) return decoded
  const b = decoded.b
  const name = b.name
  const tool_call_id = b.tool_call_id
  const conversation_id = b.conversation_id
  if (typeof name !== "string" || !ID_RE.test(name)) return { ok: false, error: "bad_envelope" }
  if (typeof tool_call_id !== "string" || !ID_RE.test(tool_call_id)) return { ok: false, error: "bad_envelope" }
  if (typeof conversation_id !== "string" || !ID_RE.test(conversation_id)) return { ok: false, error: "bad_envelope" }
  let argumentsJson: string
  if (typeof b.arguments === "string") argumentsJson = b.arguments
  else if (b.arguments && typeof b.arguments === "object") argumentsJson = JSON.stringify(b.arguments)
  else if (b.arguments === undefined || b.arguments === null) argumentsJson = "{}"
  else return { ok: false, error: "bad_envelope" }
  return { ok: true, envelope: { name, argumentsJson, tool_call_id, conversation_id } }
}

/** What the post-call action carries that settling needs. */
export interface PostCallEnvelope {
  name: string
  conversation_id: string
}

export type PostCallEnvelopeParse = { ok: true; envelope: PostCallEnvelope } | EnvelopeError

/**
 * Raw (already verified) body -> post-call envelope. Only `name` and `conversation_id` are
 * required; every other field of the tool-call envelope is ignored if present and not missed if
 * absent. Nothing in the body beyond the conversation id influences what is settled: the decisions
 * to execute are the ones this gate already recorded as approved for that conversation.
 */
export function parsePostCallEnvelope(rawBody: ArrayBuffer): PostCallEnvelopeParse {
  const decoded = decodeObject(rawBody)
  if (!decoded.ok) return decoded
  const { name, conversation_id } = decoded.b
  if (typeof name !== "string" || !ID_RE.test(name)) return { ok: false, error: "bad_envelope" }
  if (typeof conversation_id !== "string" || !ID_RE.test(conversation_id)) return { ok: false, error: "bad_envelope" }
  return { ok: true, envelope: { name, conversation_id } }
}
