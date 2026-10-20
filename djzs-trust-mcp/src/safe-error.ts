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

/**
 * Server-side only. The raw cause goes to the Worker log; the caller gets a `Fault` code.
 * `ctx` carries PUBLIC reconciliation values (payer address, intent hash, transaction hash): each is
 * logged only if it has exactly that shape, so the line can be matched to on-chain events afterwards.
 */
export function logFault(where: string, e: unknown, ctx: { payer?: unknown; intent_hash?: unknown; transaction?: unknown } = {}): void {
  let name = typeof e as string
  let msg = String(e)
  try {
    if (e instanceof Error) { name = e.name; msg = e.message }
  } catch { /* an exotic thrown value must not turn logging into a second failure */ }
  const addr = (x: unknown) => (typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) ? x : "-")
  const h32 = (x: unknown) => (typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x) ? x : "-")
  const extra = ctx.payer !== undefined || ctx.intent_hash !== undefined || ctx.transaction !== undefined
    ? ` :: payer=${addr(ctx.payer)} intent_hash=${h32(ctx.intent_hash)} tx=${h32(ctx.transaction)}`
    : ""
  console.error(`[fault] ${where} :: ${scrub(String(name))} :: ${scrub(String(msg))}${extra}`)
}

/**
 * A reason string supplied by a third party (the facilitator's invalidReason / errorReason) is
 * relayed only if it is code-shaped. Anything else, including free text, becomes "unknown".
 */
export function reasonCode(x: unknown, fallback = "unknown"): string {
  return typeof x === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : fallback
}
