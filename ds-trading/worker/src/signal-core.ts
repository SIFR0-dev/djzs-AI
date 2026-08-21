// Signal-spec registration core — pure and deterministic.
// Discipline: the spec hash is computed at registration, BEFORE any signal
// exists; params and kill_criteria are immutable from the moment the row is
// written (there is no update path at all). A signal-box verdict is accepted
// only against a spec that is registered AND armed (status shadow/live) —
// enforced in the verdict route.

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const body = Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",");
  return `{${body}}`;
}

export interface SpecInput {
  spec_id: string; // 'SC-03'
  version: string; // 'v1'
  params: Record<string, unknown>;
  kill_criteria: Record<string, unknown>;
}

export const SPEC_ID_RE = /^SC-\d{2}$/;

export function canonicalSpecPreimage(s: SpecInput): string {
  return stableStringify({
    kill_criteria: s.kill_criteria,
    params: s.params,
    spec_id: s.spec_id,
    version: s.version,
  });
}

export async function computeSpecHash(s: SpecInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSpecPreimage(s));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
