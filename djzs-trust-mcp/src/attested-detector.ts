/**
 * attested-detector.ts - DJZS-AD-v0.1 (the attested-detector lane)
 *
 * "LLM detects, TypeScript decides" gets a verifiable seam: the detector (LLM) call is
 * routed through Phala Cloud's ACI gateway (inference.phala.com, protocol `aci/1`), and
 * every call returns a signed receipt that commits - inside the TEE - to the exact
 * request bytes, the exact response bytes, the serving upstream, and the attested
 * workload keyset. This module reproduces the ACI constructions over Web Crypto only
 * (no Node deps, runs in the Worker and under tsx) and turns one chat completion into
 * an AttestedDetection record: the object a paid verdict can carry and anyone can
 * re-verify offline.
 *
 * Verified here (ACI spec sec.9.1 check 2-3, sec.9.3 checks 1-5):
 *   - report binding: sha256(JCS(workload_keyset)) == workload_keyset_digest, and
 *     sha256(statement(digest, nonce)) == report_data - the nonce is NOT raw in
 *     report_data; it is hashed inside a fixed statement (sec.3.2);
 *   - keyset expiry (now < not_after);
 *   - receipt signature: Ed25519 over JCS(document minus `signature`) under the key
 *     that `key_id` names in the established keyset's receipt_signing_keys;
 *   - receipt document: api_version aci/1, workload_keyset_digest == established;
 *   - request.received.body_hash == sha256 of the request body we sent;
 *   - response.returned.body_hash == sha256 of the response bytes we received;
 *   - upstream.verified: result "verified" with a session_id (aggregator serving).
 *
 * NOT verified in v0.1 (disclosed, policy steps for the ruleset, never implied):
 *   - the TDX quote to Intel's vendor root (sec.9.1 check 1: @phala/dcap-qvl + collateral);
 *   - compose measurement / provenance review (sec.9.1 check 4) - `repo_commit` is recorded;
 *   - TLS SPKI pinning / E2EE (sec.9.1 check 6) - the Worker's fetch cannot pin SPKI.
 *
 * Claim this supports: verifiable execution of the detector step - never "accurate".
 *
 * Spec: github.com/Dstack-TEE/private-ai-gateway - spec/aci.md (sec.3, sec.4, sec.7, sec.9) and
 * spec/test-vectors.md. tests/attested-detector.test.ts pins those vectors byte-for-byte.
 */

export const ATTESTED_DETECTOR_VERSION = "DJZS-AD-v0.1" as const;
export const ACI_API_VERSION = "aci/1" as const;
export const ACI_REPORT_DATA_PURPOSE = "aci.report_data.v1" as const;
export const PHALA_ACI_BASE = "https://inference.phala.com/v1" as const;
/**
 * Default detector model. A TEE-served open-weight model is the whole point (the
 * Anthropic detector cannot run inside Phala's enclave); the extraction contract was
 * measured on Claude, so the Q2 A/B (owed before any deploy) decides whether this
 * default stands. Override per call; the live probe prints the current TEE model list.
 */
export const PHALA_DEFAULT_MODEL = "qwen/qwen3.8-27b" as const;

/**
 * Reasoning control for thinking models (fill35). Sent as the gateway's unified `reasoning`
 * request field, which the ACI gateway re-encodes in the serving route's own dialect
 * (`reasoning`, `reasoning_effort`, chat_template_kwargs or `thinking`; private-ai-gateway
 * src/middleware/request_transform.rs). "off" = { enabled: false }; the others = { effort }.
 * Unset sends NOTHING: the request bytes are then exactly fill33's.
 *
 * Why it exists: the first attested Q2 run (2026-10-23, qwen/qwen3.8-27b, max_tokens 1024, no
 * reasoning control) failsafed 60 of 80 consensus runs: 11 of the 12 full PM theses 5/5 (R1 3/5),
 * the one-line A2 2/5, A1 and both perp intents never. A thinking model's reasoning counts against
 * max_tokens; tests/phala-extraction-diag.ts measures whether that is the cause before any
 * configuration is ruled.
 */
export type ReasoningMode = "off" | "low" | "medium" | "high";
export const REASONING_MODES: readonly ReasoningMode[] = ["off", "low", "medium", "high"];

/** The request field for a mode. */
export function reasoningField(mode: ReasoningMode): Record<string, unknown> {
  return mode === "off" ? { enabled: false } : { effort: mode };
}

/**
 * Parse an operator-set reasoning value (Worker var / .dev.vars). Unset, empty or "default"
 * -> undefined (send nothing). A value outside REASONING_MODES -> null: the caller refuses,
 * never guesses.
 */
export function parseReasoningMode(v: string | undefined): ReasoningMode | undefined | null {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "" || t === "default") return undefined;
  return (REASONING_MODES as readonly string[]).includes(t) ? (t as ReasoningMode) : null;
}

/** The gateway's own bound (private-ai-gateway errors.rs: max_tokens must be between 0 and 393216). */
export const MAX_TOKENS_CEILING = 393216;
export const DEFAULT_MAX_TOKENS = 1024;

/** Parse an operator-set max_tokens. Unset/empty -> DEFAULT_MAX_TOKENS; not an integer in 1..393216 -> null (refuse). */
export function parseMaxTokens(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return DEFAULT_MAX_TOKENS;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_TOKENS_CEILING ? n : null;
}

/** sha256 of the empty string: a detector_output_sha256 equal to this is an EMPTY output. */
export const EMPTY_OUTPUT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// --- Wire shapes (only the members this module touches are typed) --------------------

export interface KeysetKey {
  key_id: string;
  algo: string;
  public_key: string;
  [k: string]: unknown;
}

export interface WorkloadKeyset {
  not_after: number;
  receipt_signing_keys: KeysetKey[];
  [k: string]: unknown;
}

export interface SourceProvenance {
  repo_url?: string | null;
  repo_commit?: string | null;
  image_digest?: string | null;
  [k: string]: unknown;
}

export interface AttestationReport {
  api_version: string;
  workload_keyset_digest: string;
  attestation: {
    tee_type: string;
    workload_keyset: unknown;
    report_data: string;
    source_provenance?: SourceProvenance | null;
    evidence?: unknown;
    [k: string]: unknown;
  };
  service_capabilities?: { serving?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ReceiptEvent {
  type: string;
  body_hash?: string;
  [k: string]: unknown;
}

/** The document served by GET /v1/aci/receipts/{id} (sec.7.3 payload + key_id + signature). */
export interface ReceiptDocument {
  api_version: string;
  receipt_id: string;
  chat_id?: string | null;
  model?: string | null;
  workload_keyset_digest: string;
  endpoint: string;
  method: string;
  served_at: number;
  event_log: ReceiptEvent[];
  key_id: string;
  signature: string;
  [k: string]: unknown;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

// --- Primitives (Web Crypto only) ----------------------------------------------------

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decode lowercase/uppercase hex (optional 0x). Throws on malformed input. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`malformed hex (${hex.length} chars)`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  return toHex(await sha256(typeof bytes === "string" ? enc.encode(bytes) : bytes));
}

/** `sha256:<hex>` - the ACI digest form (Appendix A) used for keyset digests and body hashes. */
export async function sha256Prefixed(bytes: Uint8Array | string): Promise<string> {
  return "sha256:" + (await sha256Hex(bytes));
}

/**
 * RFC 8785 (JCS) bytes of a parsed JSON value: compact, member names sorted by UTF-16
 * code units, strings/numbers per ES JSON.stringify. For the ACI artifact constraints
 * (ASCII member names, integer numbers) JSON.stringify over a key-sorted copy IS the
 * canonical form - the same construction the reference verifier uses.
 */
export function jcsBytes(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** Verify an Ed25519 (RFC 8032) signature. Returns false for bad/malformed input, never throws. */
export async function verifyEd25519(publicKeyRaw: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", publicKeyRaw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

/** 32 random bytes as 64 lowercase hex - the sec.3.2 nonce form. */
export function randomNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

// --- ACI constructions (spec sec.3.1, sec.3.2, sec.7, sec.8) -------------------------------------

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;

/** `workload_keyset_digest` (sec.3.1): sha256 over the keyset's JCS form. */
export async function computeKeysetDigest(keyset: unknown): Promise<string> {
  return sha256Prefixed(jcsBytes(keyset));
}

/** The exact attestation-statement bytes (sec.3.2) - a fixed template, never a JSON encoder. */
export function attestationStatement(keysetDigest: string, nonce: string | null | undefined): Uint8Array {
  if (!DIGEST_RE.test(keysetDigest)) throw new Error(`keyset digest is not sha256:<64-hex>: "${keysetDigest}"`);
  if (nonce != null && !NONCE_RE.test(nonce)) throw new Error("nonce must be exactly 64 lowercase hex characters (sec.3.2)");
  const noncePart = nonce == null ? "null" : `"${nonce}"`;
  return enc.encode(`{"keyset_digest":"${keysetDigest}","nonce":${noncePart},"purpose":"${ACI_REPORT_DATA_PURPOSE}"}`);
}

/** `report_data` (sec.3.2): bare-hex sha256 of the statement; the TEE zero-pads it to 64 bytes. */
export async function computeReportData(keysetDigest: string, nonce: string | null | undefined): Promise<string> {
  return sha256Hex(attestationStatement(keysetDigest, nonce));
}

/** `session_id` (sec.8): bare-hex sha256 of the session document's JCS form. */
export async function computeSessionId(sessionDocument: unknown): Promise<string> {
  return sha256Hex(jcsBytes(sessionDocument));
}

export function findEvent(receipt: { event_log?: unknown }, type: string): ReceiptEvent | undefined {
  if (!Array.isArray(receipt.event_log)) return undefined;
  return (receipt.event_log as ReceiptEvent[]).find((e) => e && e.type === type);
}

// --- Verification (spec sec.9.1 check 2-3, sec.9.3) ----------------------------------------

export interface ReportBinding {
  ok: boolean;
  checks: Check[];
  /** Established (recomputed, authoritative) keyset digest - never the report's restated copy. */
  digest?: string;
  keyset?: WorkloadKeyset;
}

/**
 * sec.9.1 check 2 (binding + freshness) and check 3 (expiry) over a served report and the
 * nonce THIS client sent. A failed check is `ok:false`, never a throw; only a malformed
 * caller nonce throws.
 */
export async function verifyReportBinding(
  report: AttestationReport,
  nonce: string | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ReportBinding> {
  const checks: Check[] = [];
  push(checks, "api_version", report.api_version === ACI_API_VERSION, `api_version "${report.api_version}" is not "${ACI_API_VERSION}"`);
  const keysetValue = report.attestation?.workload_keyset;
  if (keysetValue === null || typeof keysetValue !== "object" || Array.isArray(keysetValue)) {
    for (const name of ["workload_keyset_digest", "report_data", "not_after"]) checks.push({ name, ok: false, detail: "workload_keyset is not a JSON object" });
    return { ok: false, checks };
  }
  const digest = await computeKeysetDigest(keysetValue);
  push(checks, "workload_keyset_digest", report.workload_keyset_digest === digest, `report ${report.workload_keyset_digest} != recomputed ${digest}`);
  const expected = await computeReportData(digest, nonce);
  push(checks, "report_data", report.attestation.report_data === expected, `report ${report.attestation.report_data} != recomputed ${expected}`);
  const keyset = keysetValue as WorkloadKeyset;
  const notAfter = keyset.not_after;
  push(checks, "not_after", typeof notAfter === "number" && now < notAfter, typeof notAfter === "number" ? `now ${now} >= not_after ${notAfter}` : "keyset has no numeric not_after");
  return { ok: checks.every((c) => c.ok), checks, digest, keyset };
}

export interface ReceiptVerification {
  ok: boolean;
  checks: Check[];
}

/**
 * sec.9.3 checks 1-2: `signature` is Ed25519 over JCS(document minus `signature`) under the
 * keyset entry `key_id` names; api_version is aci/1; the document binds the established digest.
 */
export async function verifyReceipt(document: ReceiptDocument, keyset: WorkloadKeyset, establishedDigest: string): Promise<ReceiptVerification> {
  const checks: Check[] = [];
  const keys = Array.isArray(keyset.receipt_signing_keys) ? keyset.receipt_signing_keys : [];
  const entry = keys.find((k) => k && k.key_id === document.key_id);
  if (!entry) {
    checks.push({ name: "signature", ok: false, detail: `key_id "${document.key_id}" not in receipt_signing_keys` });
  } else if (entry.algo !== "ed25519") {
    checks.push({ name: "signature", ok: false, detail: `unsupported signature algo "${entry.algo}"` });
  } else {
    const { signature, ...unsigned } = document;
    let ok = false;
    try {
      ok = await verifyEd25519(fromHex(entry.public_key), fromHex(signature), jcsBytes(unsigned));
    } catch {
      ok = false;
    }
    push(checks, "signature", ok, `ed25519 verification failed under "${document.key_id}"`);
  }
  push(checks, "api_version", document.api_version === ACI_API_VERSION, `api_version "${document.api_version}" is not "${ACI_API_VERSION}"`);
  push(checks, "workload_keyset_digest", document.workload_keyset_digest === establishedDigest, `document ${document.workload_keyset_digest} != established ${establishedDigest}`);
  return { ok: checks.every((c) => c.ok), checks };
}

/** sec.9.3 check 3/4: an event's body_hash against the bytes this client sent/received. */
export async function checkBodyHash(document: ReceiptDocument, type: "request.received" | "request.forwarded" | "response.returned", body: Uint8Array | string): Promise<Check> {
  const expected = findEvent(document, type)?.body_hash;
  if (typeof expected !== "string") return { name: type, ok: false, detail: `no ${type} event with a body_hash` };
  const actual = await sha256Prefixed(body);
  return { name: type, ok: actual === expected, ...(actual === expected ? {} : { detail: `ours ${actual} != receipt ${expected}` }) };
}

export interface UpstreamVerified {
  result: string | null;
  required: boolean | null;
  session_id: string | null;
  model_id: string | null;
  reason: string | null;
}

/** sec.7.5: what the attested aggregator asserted about the upstream that served this call. */
export function readUpstreamVerified(document: ReceiptDocument): UpstreamVerified | null {
  const ev = findEvent(document, "upstream.verified");
  if (!ev) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { result: s(ev.result), required: typeof ev.required === "boolean" ? ev.required : null, session_id: s(ev.session_id), model_id: s(ev.model_id), reason: s(ev.reason) };
}

function push(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push(ok ? { name, ok } : { name, ok, detail });
}

// --- Gateway I/O ---------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Established {
  ok: boolean;
  checks: Check[];
  nonce: string;
  digest: string;
  keyset: WorkloadKeyset;
  report: AttestationReport;
  /** sha256 of the raw report bytes as served - the archival pointer for the quote. */
  report_sha256: string;
  established_at: number;
}

export interface EstablishOptions {
  base?: string;
  fetchImpl?: FetchLike;
  /** Optional: the attestation endpoint answers without a key today; sent when given. */
  apiKey?: string;
  nonce?: string;
  now?: number;
}

/**
 * Establish the workload identity once (sec.9.1): fetch a nonce-bound report and verify its
 * bindings. Reuse the result across calls until `not_after` or a changed
 * X-ACI-Keyset-Digest; a failed binding is returned with ok:false, never thrown.
 */
export async function establishWorkload(opts: EstablishOptions = {}): Promise<Established> {
  const base = opts.base ?? PHALA_ACI_BASE;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const nonce = opts.nonce ?? randomNonce();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetchImpl(`${base}/aci/attestation?nonce=${nonce}`, { method: "GET", headers });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`attestation fetch failed: HTTP ${res.status}`);
  const report = JSON.parse(new TextDecoder().decode(bytes)) as AttestationReport;
  const binding = await verifyReportBinding(report, nonce, opts.now);
  return {
    ok: binding.ok,
    checks: binding.checks,
    nonce,
    digest: binding.digest ?? "",
    keyset: binding.keyset ?? ({ not_after: 0, receipt_signing_keys: [] } as WorkloadKeyset),
    report,
    report_sha256: await sha256Hex(bytes),
    established_at: opts.now ?? Math.floor(Date.now() / 1000),
  };
}

export async function fetchReceipt(base: string, id: string, apiKey: string, fetchImpl: FetchLike, attempts = 4): Promise<ReceiptDocument> {
  let last = 0;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchImpl(`${base}/aci/receipts/${encodeURIComponent(id)}`, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
    if (res.ok) return (await res.json()) as ReceiptDocument;
    last = res.status;
    if (res.status !== 404 || i === attempts - 1) break;
    await new Promise((r) => setTimeout(r, 300 * (i + 1))); // a receipt finalizes when the response completes; give it a beat
  }
  throw new Error(`receipt fetch failed: HTTP ${last}`);
}

// --- The attested call ---------------------------------------------------------------

export interface AttestedCallOptions {
  apiKey: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** fill35: reasoning control for thinking models; unset sends nothing (fill33 request bytes). */
  reasoning?: ReasoningMode;
  /** sec.5.3 `provider.aci_verified: true` - the gateway refuses rather than serve unverified. Default true. */
  requireVerified?: boolean;
  base?: string;
  fetchImpl?: FetchLike;
  /** A workload already established by this process; fetched fresh when absent. */
  established?: Established;
  /**
   * Default true: a workload whose report binding failed gets NO prompt - the call throws
   * WorkloadNotEstablishedError before anything is sent (sec.9.1: what protects a prompt
   * happens before it is sent). false is for probes that want to see the receipt anyway.
   */
  requireEstablished?: boolean;
  now?: number;
}

export class WorkloadNotEstablishedError extends Error {
  constructor(public readonly established: Established) {
    super(`workload not established - prompt withheld: ${established.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
    this.name = "WorkloadNotEstablishedError";
  }
}

export interface AttestedChecks {
  report_binding: boolean;
  receipt_signature: boolean;
  receipt_document: boolean;
  request_hash: boolean;
  response_hash: boolean;
  /** null when the receipt carries no upstream.verified event (direct service, sec.7.5). */
  upstream_verified: boolean | null;
  chat_id_match: boolean;
}

/** The record a paid verdict carries (DJZS-AD-v0.1). Everything needed to re-verify offline. */
export interface AttestedDetection {
  scheme: typeof ATTESTED_DETECTOR_VERSION;
  provider: "phala-aci";
  api_version: typeof ACI_API_VERSION;
  gateway: string;
  model: string;
  model_served: string | null;
  nonce: string;
  workload_keyset_digest: string;
  receipt_key_id: string;
  repo_url: string | null;
  repo_commit: string | null;
  report_sha256: string;
  receipt_id: string;
  chat_id: string | null;
  served_at: number | null;
  /** sha256:<hex> of the request body bytes we sent - the prompt is committed through this. */
  request_sha256: string;
  /** sha256:<hex> of the response bytes we received off the wire. */
  response_sha256: string;
  /** bare-hex sha256 of the detector's text output (choices[0].message.content) - the value fill34 hashes into the verdict. */
  detector_output_sha256: string;
  /** fill35 telemetry: why generation stopped ("stop", "length" = the output budget ran out, ...). */
  finish_reason: string | null;
  /** fill35 telemetry: the gateway's usage block, when it sends one. reasoning_tokens counts against max_tokens. */
  usage: DetectionUsage | null;
  /** fill35 telemetry: characters of reasoning text returned beside the answer (0 when none came back). */
  reasoning_chars: number;
  /** fill35: the request configuration, as sent (the exact bytes are committed by request_sha256). */
  max_tokens: number;
  reasoning: ReasoningMode | null;
  upstream: UpstreamVerified | null;
  checks: AttestedChecks;
  /** All applicable checks true. An unverified call must never feed the engine silently. */
  verified: boolean;
  details: Check[];
  /** The signed receipt and the keyset it binds to - archived so the chain re-verifies without the gateway. */
  receipt: ReceiptDocument;
  keyset: WorkloadKeyset;
}

export interface DetectionUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface AttestedCallResult {
  text: string;
  detection: AttestedDetection;
  raw: { request_body: string; response_body: string; status: number; receipt_id: string | null; keyset_digest_header: string | null };
}

/** One non-streaming chat completion through the ACI gateway, with the full receipt chain verified. */
export async function attestedChatCompletion(opts: AttestedCallOptions): Promise<AttestedCallResult> {
  const base = opts.base ?? PHALA_ACI_BASE;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const model = opts.model ?? PHALA_DEFAULT_MODEL;
  const est = opts.established ?? (await establishWorkload({ base, fetchImpl, apiKey: opts.apiKey, now: opts.now }));
  if (!est.ok && (opts.requireEstablished ?? true)) throw new WorkloadNotEstablishedError(est);

  // The request body is serialized ONCE; these exact bytes are what the receipt must commit to.
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.reasoning) payload.reasoning = reasoningField(opts.reasoning);
  if (opts.requireVerified ?? true) payload.provider = { aci_verified: true };
  const requestBody = JSON.stringify(payload);

  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: requestBody,
  });
  const responseBytes = new Uint8Array(await res.arrayBuffer());
  const responseBody = new TextDecoder().decode(responseBytes);
  const receiptId = res.headers.get("x-receipt-id");
  const digestHeader = res.headers.get("x-aci-keyset-digest");
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}${receiptId ? ` (refusal receipt ${receiptId})` : ""}: ${responseBody.slice(0, 300)}`);
  if (!receiptId) throw new Error("gateway response carried no X-Receipt-Id header");

  let text = "";
  let chatId: string | null = null;
  let finishReason: string | null = null;
  let usage: DetectionUsage | null = null;
  let reasoningChars = 0;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  try {
    const parsed = JSON.parse(responseBody) as {
      id?: unknown;
      choices?: { finish_reason?: unknown; message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
    };
    chatId = typeof parsed.id === "string" ? parsed.id : null;
    const choice = parsed.choices?.[0];
    const c = choice?.message?.content;
    text = typeof c === "string" ? c : "";
    finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const r = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
    reasoningChars = typeof r === "string" ? r.length : 0;
    const u = parsed.usage;
    usage = u && typeof u === "object"
      ? { prompt_tokens: num(u.prompt_tokens), completion_tokens: num(u.completion_tokens), reasoning_tokens: num(u.completion_tokens_details?.reasoning_tokens) }
      : null;
  } catch {
    text = "";
  }

  const receipt = await fetchReceipt(base, receiptId, opts.apiKey, fetchImpl);
  const rv = await verifyReceipt(receipt, est.keyset, est.digest);
  const reqCheck = await checkBodyHash(receipt, "request.received", requestBody);
  const resCheck = await checkBodyHash(receipt, "response.returned", responseBytes);
  const upstream = readUpstreamVerified(receipt);
  const upstreamOk = upstream === null ? null : upstream.result === "verified" && typeof upstream.session_id === "string" && upstream.session_id.length > 0;
  const chatIdMatch = chatId !== null && receipt.chat_id === chatId;

  const sigOk = rv.checks.find((c) => c.name === "signature")?.ok === true;
  const docOk = rv.checks.filter((c) => c.name !== "signature").every((c) => c.ok);
  const checks: AttestedChecks = {
    report_binding: est.ok,
    receipt_signature: sigOk,
    receipt_document: docOk,
    request_hash: reqCheck.ok,
    response_hash: resCheck.ok,
    upstream_verified: upstreamOk,
    chat_id_match: chatIdMatch,
  };
  const details: Check[] = [
    ...est.checks.map((c) => ({ ...c, name: `report.${c.name}` })),
    ...rv.checks.map((c) => ({ ...c, name: `receipt.${c.name}` })),
    reqCheck,
    resCheck,
    { name: "upstream.verified", ok: upstreamOk !== false, ...(upstreamOk === false ? { detail: `result=${upstream?.result ?? "?"} required=${String(upstream?.required)} reason=${upstream?.reason ?? ""}` } : {}) },
    { name: "chat_id", ok: chatIdMatch, ...(chatIdMatch ? {} : { detail: `response id ${chatId ?? "(none)"} vs receipt chat_id ${String(receipt.chat_id)}` }) },
  ];
  // chat_id is advisory (a gateway may null it); everything else is required. A missing
  // upstream event (direct service) is not a failure - there is no second hop to attest.
  const verified = est.ok && sigOk && docOk && reqCheck.ok && resCheck.ok && upstreamOk !== false;

  const prov = est.report.attestation?.source_provenance ?? null;
  const detection: AttestedDetection = {
    scheme: ATTESTED_DETECTOR_VERSION,
    provider: "phala-aci",
    api_version: ACI_API_VERSION,
    gateway: base,
    model,
    model_served: upstream?.model_id ?? null,
    nonce: est.nonce,
    workload_keyset_digest: est.digest,
    receipt_key_id: receipt.key_id,
    repo_url: prov?.repo_url ?? null,
    repo_commit: prov?.repo_commit ?? null,
    report_sha256: est.report_sha256,
    receipt_id: receipt.receipt_id,
    chat_id: typeof receipt.chat_id === "string" ? receipt.chat_id : null,
    served_at: typeof receipt.served_at === "number" ? receipt.served_at : null,
    request_sha256: await sha256Prefixed(requestBody),
    response_sha256: await sha256Prefixed(responseBytes),
    detector_output_sha256: await sha256Hex(text),
    finish_reason: finishReason,
    usage,
    reasoning_chars: reasoningChars,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: opts.reasoning ?? null,
    upstream,
    checks,
    verified,
    details,
    receipt,
    keyset: est.keyset,
  };
  return { text, detection, raw: { request_body: requestBody, response_body: responseBody, status: res.status, receipt_id: receiptId, keyset_digest_header: digestHeader } };
}

// --- The ModelFn seam ----------------------------------------------------------------

/** Structurally identical to the extraction layer's ModelFn - no import, so this module stays dependency-free. */
export type DetectorFn = (prompt: string) => Promise<string>;

export interface PhalaDetectorOptions {
  apiKey: string;
  model?: string;
  base?: string;
  fetchImpl?: FetchLike;
  requireVerified?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** fill35: reasoning control for thinking models; unset sends nothing. */
  reasoning?: ReasoningMode;
  /** Every call's AttestedDetection lands here (N=3 consensus -> three records). */
  sink: AttestedDetection[];
  /** "throw" (default): an unverified call rejects, so the consensus extraction fails closed. "record": return the text regardless (probes only). */
  onUnverified?: "throw" | "record";
  now?: number;
}

export class UnverifiedDetectionError extends Error {
  constructor(public readonly detection: AttestedDetection) {
    super(`attested detection failed verification: ${detection.details.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
    this.name = "UnverifiedDetectionError";
  }
}

/**
 * Build a ModelFn that routes every detector call through the ACI gateway. The workload
 * is established once per instance (shared across the parallel consensus samples) and
 * re-established when the served X-ACI-Keyset-Digest changes or the keyset expires.
 */
export function buildPhalaDetector(opts: PhalaDetectorOptions): DetectorFn {
  const base = opts.base ?? PHALA_ACI_BASE;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  let establishing: Promise<Established> | null = null;
  const establish = (): Promise<Established> => {
    if (!establishing) {
      establishing = establishWorkload({ base, fetchImpl, apiKey: opts.apiKey, now: opts.now }).catch((e) => {
        establishing = null;
        throw e;
      });
    }
    return establishing;
  };
  return async (prompt: string): Promise<string> => {
    let est = await establish();
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (!(now < est.keyset.not_after)) {
      establishing = null;
      est = await establish();
    }
    const r = await attestedChatCompletion({ ...opts, prompt, base, fetchImpl, established: est });
    if (r.raw.keyset_digest_header && r.raw.keyset_digest_header !== est.digest) establishing = null; // sec.5.2: re-establish before the next call
    opts.sink.push(r.detection);
    if (!r.detection.verified && (opts.onUnverified ?? "throw") === "throw") throw new UnverifiedDetectionError(r.detection);
    return r.text;
  };
}
