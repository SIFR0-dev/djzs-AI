/**
 * Caller-facing error text is a FIXED CODE, never an exception message.
 *
 * Why: viem's HttpRequestError begins "HTTP request failed.\n\nURL: <rpc url>", and a provider
 * URL embeds its API key (CLAUDE.md section 14 classes BASE_RPC_URL as a Worker secret). An
 * upstream body (Anthropic, Irys, the subgraph, the facilitator) can echo request detail. A
 * code carries neither. Ruled 2026-10-20: eas_error and every other error field returned to a
 * caller is a code from `Fault`; an HTTP status integer may ride inside one (`..._http_502`).
 *
 * The raw error still reaches the Worker log through logFault(), with URLs and long hex or
 * token-shaped runs redacted, so the operator keeps the diagnosis and the response keeps nothing.
 */

export const FAULTS = [
  "facilitator_unavailable",
  "intent_unbindable",
  "audit_unavailable",
  "engine_error",
  "post_settlement_error",
  "settlement_uncertain",
  "attester_not_configured",
  "attestation_failed",
  "attester_balance_unavailable",
  "anchor_failed",
  "anchor_gateway_mismatch",
  "anchor_unretrievable",
  "trust_write_failed",
  "extraction_failed",
  "tool_error",
  "subgraph_unreachable",
  "subgraph_graphql_error",
  "irys_query_failed",
] as const

export type Fault = (typeof FAULTS)[number]

/** Redact what must not reach a log line either: URLs (they embed provider keys), hex runs, long tokens. */
export function scrub(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/0x[0-9a-fA-F]{16,}/g, "[hex]")
    // A long token is a key until proven otherwise. All-lowercase words and underscores are not
    // (facilitator reasons such as invalid_exact_evm_payload_authorization_valid_after), and the
    // operator needs those to diagnose a failed payment.
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, (t) => (/^[a-z_]+$/.test(t) ? t : "[token]"))
    .slice(0, 300)
}

/**
 * Server-side only. The raw cause goes to the Worker log; the caller gets a `Fault` code.
 * `ctx` carries PUBLIC reconciliation values (payer address, intent hash, transaction hash): each is
 * logged only if it has exactly that shape, so the line can be matched to on-chain events afterwards.
 */
export function logFault(where: string, e: unknown, ctx: { payer?: unknown; intent_hash?: unknown; transaction?: unknown } = {}): void {
  let name = "unknown"
  let msg = "unprintable"
  try {
    name = e instanceof Error ? e.name : typeof e
    msg = e instanceof Error ? e.message : String(e)
  } catch { /* a null-prototype object, a hostile getter: keep the defaults; logging must never be a second failure */ }
  const extra = ctx.payer !== undefined || ctx.intent_hash !== undefined || ctx.transaction !== undefined
    ? ` :: payer=${addressOnly(ctx.payer) ?? "-"} intent_hash=${hash32Only(ctx.intent_hash) ?? "-"} tx=${hash32Only(ctx.transaction) ?? "-"}`
    : ""
  console.error(`[fault] ${where} :: ${scrub(String(name))} :: ${scrub(String(msg))}${extra}`)
}

/**
 * A reason string supplied by a third party (the facilitator's invalidReason / errorReason) is
 * relayed only if it is a snake_case code: lowercase words ("insufficient_funds") or the
 * UPPER_SNAKE constants this stack uses ("INVALID_PAYMENT"), at most 8 words of at most 20
 * characters. That admits every real x402 reason and rejects free text, a URL, mixed-case
 * tokens, and a 64-character hex or base64 string (a key or a transaction hash has no
 * underscores and is longer than any word). Anything else becomes the fallback.
 */
const LOWER_CODE = /^[a-z][a-z0-9]{0,19}(?:_[a-z0-9]{1,20}){0,7}$/
const UPPER_CODE = /^[A-Z][A-Z0-9]{0,19}(?:_[A-Z0-9]{1,20}){0,7}$/
export function reasonCode(x: unknown, fallback = "unknown"): string {
  return typeof x === "string" && x.length <= 180 && (LOWER_CODE.test(x) || UPPER_CODE.test(x)) ? x : fallback
}

/** An address-shaped value, or undefined. For echoing a third party's `payer` field. */
export function addressOnly(x: unknown): string | undefined {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) ? x : undefined
}

/** A 32-byte-hash-shaped value, or undefined. For echoing a third party's transaction hash. */
export function hash32Only(x: unknown): string | undefined {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x) ? x : undefined
}
