/**
 * faults.ts - every error this Worker can return, as a fixed code.
 *
 * Same rule as djzs-trust-mcp/src/safe-error.ts (ruled 2026-10-20): caller-facing error text is a
 * code from a closed list, never an exception message. An exception can carry a URL, a key or an
 * upstream body; a code carries none. The raw cause goes to the Worker log through logFault, with
 * URLs, long hex runs and token-shaped strings redacted.
 */

export const FAULTS = [
  "gate_not_configured",
  "bad_signature",
  "body_too_large",
  "invalid_json",
  "bad_envelope",
  "wrong_tool",
  "store_unavailable",
  "store_error",
  "executor_unavailable",
  "gate_closed",
  "operator_not_configured",
  "unauthorized",
  "bad_request",
  "not_found",
  "conflict",
  "method_not_allowed",
  "internal_error",
] as const
export type Fault = (typeof FAULTS)[number]

function scrub(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/0x[0-9a-fA-F]{16,}/g, "[hex]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, (t) => (/^[a-z_]+$/.test(t) ? t : "[token]"))
    .slice(0, 300)
}

/** Server-side only. `where` is a fixed label chosen by the caller, never request data. */
export function logFault(where: string, e: unknown): void {
  let name = "unknown"
  let msg = "unprintable"
  try {
    name = e instanceof Error ? e.name : typeof e
    msg = e instanceof Error ? e.message : String(e)
  } catch {
    /* a hostile getter: keep the defaults, logging must never be a second failure */
  }
  console.error(`[fault] ${where} :: ${scrub(String(name))} :: ${scrub(String(msg))}`)
}

const BASE_HEADERS: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" }

export function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...BASE_HEADERS, ...extra } })
}

export function fault(code: Fault, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: code, ...extra }, status)
}
