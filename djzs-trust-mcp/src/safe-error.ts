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
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[token]")
    .slice(0, 300)
}

/** Server-side only. The raw cause goes to the Worker log; the caller gets a `Fault` code. */
export function logFault(where: string, e: unknown): void {
  const name = e instanceof Error ? e.name : typeof e
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fault] ${where} :: ${name} :: ${scrub(msg)}`)
}

/**
 * A reason string supplied by a third party (the facilitator's invalidReason / errorReason) is
 * relayed only if it is code-shaped. Anything else, including free text, becomes "unknown".
 */
export function reasonCode(x: unknown, fallback = "unknown"): string {
  return typeof x === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : fallback
}
