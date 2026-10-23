/**
 * Offline test of the attested-detector lane (DJZS-AD-v0.1). No network, no key.
 *
 * Part A pins the ACI spec test vectors (private-ai-gateway spec/test-vectors.md sec.1-sec.4)
 * byte-for-byte: keyset JCS -> digest, attestation statement -> report_data (nonce and
 * null), session id, body hashes, the receipt signing input, and a real Ed25519
 * signature under the vector's public key. Reproducing these is what proves an
 * independent implementation has the binding logic right.
 *
 * Part B runs the full call path against a synthetic gateway (stub fetch, a fresh
 * Ed25519 keypair generated in-test): the clean exchange verifies; then each tamper
 * case - response bytes swapped, foreign signing key, stale nonce, unverified upstream,
 * foreign keyset digest - fails exactly its own check and never verifies.
 *
 * Part C proves the ModelFn seam: N=3 consensus extraction through buildPhalaDetector
 * yields three receipts, each with detector_output_sha256 == sha256(model text), and an
 * unverified sample fails the extraction closed (rejects) instead of feeding the engine.
 */
import {
  attestationStatement,
  attestedChatCompletion,
  buildPhalaDetector,
  checkBodyHash,
  computeKeysetDigest,
  computeReportData,
  computeSessionId,
  establishWorkload,
  fromHex,
  jcsBytes,
  sha256Hex,
  sha256Prefixed,
  toHex,
  UnverifiedDetectionError,
  verifyReceipt,
  verifyReportBinding,
  WorkloadNotEstablishedError,
  type AttestationReport,
  type AttestedDetection,
  type FetchLike,
  type ReceiptDocument,
  type WorkloadKeyset,
} from "../djzs-trust-mcp/src/attested-detector";
import { extractAuditInputConsensus } from "../server/engine-v2/extraction-layer";

let ok = true;
const check = (label: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${label}${!pass && detail ? ` - ${detail}` : ""}`);
};
const subtle = globalThis.crypto.subtle;

// --- Part A: spec vectors ------------------------------------------------------------
console.log("A. ACI spec test vectors (spec/test-vectors.md)");
const V_KEYSET: WorkloadKeyset = {
  subject: "dstack-app://example-app",
  not_after: 1800000000,
  receipt_signing_keys: [{ key_id: "receipt-1", algo: "ed25519", public_key: "8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394" }],
  e2ee_public_keys: [{ key_id: "e2ee-1", algo: "x25519-aes-256-gcm-hkdf-sha256", public_key: "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22" }],
  tls_public_keys: [{ spki_sha256: "c0".repeat(32), domain: "api.example.com" }],
};
const V_DIGEST = "sha256:53a5cd44b30dcc51999754c719f2628a041f174ecbf9662a6f8e898a10cd9371";
const V_NONCE = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
check("sec.1 keyset JCS form", new TextDecoder().decode(jcsBytes(V_KEYSET)) === `{"e2ee_public_keys":[{"algo":"x25519-aes-256-gcm-hkdf-sha256","key_id":"e2ee-1","public_key":"5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22"}],"not_after":1800000000,"receipt_signing_keys":[{"algo":"ed25519","key_id":"receipt-1","public_key":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}],"subject":"dstack-app://example-app","tls_public_keys":[{"domain":"api.example.com","spki_sha256":"${"c0".repeat(32)}"}]}`);
check("sec.1 workload_keyset_digest", (await computeKeysetDigest(V_KEYSET)) === V_DIGEST);
check("sec.2 statement bytes (nonce)", new TextDecoder().decode(attestationStatement(V_DIGEST, V_NONCE)) === `{"keyset_digest":"${V_DIGEST}","nonce":"${V_NONCE}","purpose":"aci.report_data.v1"}`);
check("sec.2 report_data (nonce) = df2174d2...", (await computeReportData(V_DIGEST, V_NONCE)) === "df2174d28130852b413646a3786927b93e94c11d770268b65def8bdba45cb49e");
check("sec.2 report_data (null nonce) = 0633919c...", (await computeReportData(V_DIGEST, null)) === "0633919ca3f00e97bafaa3304278eb22420cc3ff0d19f87dfca2d3f7508150bc");
let threw = false;
try { attestationStatement(V_DIGEST, "ABC"); } catch { threw = true; }
check("sec.2 a malformed caller nonce throws (never a silent null)", threw);
const V_SESSION = JSON.parse(`{"api_version":"aci/1","channel_binding":[{"origin":"https://upstream.example.com","spki_sha256":"${"d1".repeat(32)}","type":"tls_spki_sha256"}],"claims":{"extra":{"gpu_arch":"HOPPER","tcb_status":"UpToDate"},"gpu_attested":{"status":"unknown"},"model_weights_provenance":{"status":"unknown"},"os_known_good":{"status":"unknown"},"serving_software_known_good":{"status":"unknown"},"tcb_up_to_date":{"status":"unknown"},"tee_attested":{"reason":"example quote verified","source":"hardware_proven","status":"asserted"}},"endpoint":"https://upstream.example.com","established_at":1750000000,"evidence":{"data":"data:text/plain;base64,ZXhhbXBsZS1ldmlkZW5jZQ==","digest":"sha256:80d70e44d0ae1e829fd5f37c3ee4a60dfbea8d3aa18407ea3f34cf7ec91da34d"},"expires_at":1750003600,"upstream_name":"demo-upstream","verifier_id":"example/1"}`);
check("sec.3 session_id = 95ad1cb4...", (await computeSessionId(V_SESSION)) === "95ad1cb4dd25445808c2e9d116caf420b05703730b506395e8fc1ca6faeae28f");
check("sec.3 evidence digest", (await sha256Prefixed("example-evidence")) === "sha256:80d70e44d0ae1e829fd5f37c3ee4a60dfbea8d3aa18407ea3f34cf7ec91da34d");
const V_REQ = `{"messages":[{"content":"hi","role":"user"}],"model":"demo-model"}`;
const V_RES = `{"choices":[],"id":"chatcmpl-123"}`;
check("sec.4 request body_hash", (await sha256Prefixed(V_REQ)) === "sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b");
check("sec.4 response body_hash", (await sha256Prefixed(V_RES)) === "sha256:dedfffe5b14d031b8e2c01996d021a15293cb7c63b56be7e4be9e89b6f0a5f61");
// The served receipt, deliberately re-encoded with members out of JCS order and whitespace - any encoding must verify.
const V_RECEIPT = JSON.parse(`{
  "signature": "d5b005e093bde3b577faf270b7184b09e169cacb0ecb206b103bd2581f997db03da616175454b063323a23ac1dc68f1ce506c2a6eba8aa0561d5e724f0b80c03",
  "workload_keyset_digest": "${V_DIGEST}", "served_at": 1750000000, "receipt_id": "rcpt-0001", "model": "demo-model", "method": "POST", "key_id": "receipt-1",
  "event_log": [
    {"type": "request.received", "body_hash": "sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b"},
    {"type": "request.forwarded", "body_hash": "sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b"},
    {"type": "upstream.verified", "session_id": "95ad1cb4dd25445808c2e9d116caf420b05703730b506395e8fc1ca6faeae28f", "result": "verified", "required": true, "model_id": "demo-model"},
    {"type": "response.returned", "body_hash": "sha256:dedfffe5b14d031b8e2c01996d021a15293cb7c63b56be7e4be9e89b6f0a5f61"}
  ],
  "endpoint": "/v1/chat/completions", "chat_id": "chatcmpl-123", "api_version": "aci/1"
}`) as ReceiptDocument;
const { signature: _s, ...V_UNSIGNED } = V_RECEIPT;
check("sec.4 sha256(signing input) = 1bd328e6...", (await sha256Hex(jcsBytes(V_UNSIGNED))) === "1bd328e6880a5a12b3915af95ea32111310e04ab9e21ac3d71ce268e33b965c9");
const vr = await verifyReceipt(V_RECEIPT, V_KEYSET, V_DIGEST);
check("sec.4 Ed25519 signature verifies under receipt-1 (JCS of any encoding)", vr.ok, JSON.stringify(vr.checks));
check("sec.4 request/response hashes match the vector bodies", (await checkBodyHash(V_RECEIPT, "request.received", V_REQ)).ok && (await checkBodyHash(V_RECEIPT, "response.returned", V_RES)).ok);
const flipped = { ...V_RECEIPT, served_at: 1750000001 };
check("sec.4 one changed member breaks the signature", !(await verifyReceipt(flipped, V_KEYSET, V_DIGEST)).ok);
const V_REPORT: AttestationReport = { api_version: "aci/1", workload_keyset_digest: V_DIGEST, attestation: { tee_type: "tdx", workload_keyset: V_KEYSET, report_data: "df2174d28130852b413646a3786927b93e94c11d770268b65def8bdba45cb49e", evidence: { quote_b64: "AA==" } } };
check("sec.9.1 report binding verifies with the vector nonce (clock before not_after)", (await verifyReportBinding(V_REPORT, V_NONCE, 1750001000)).ok);
check("sec.9.1 report binding fails for another nonce", !(await verifyReportBinding(V_REPORT, "ff".repeat(32), 1750001000)).ok);
check("sec.9.1 report binding fails after not_after", !(await verifyReportBinding(V_REPORT, V_NONCE, 1800000001)).ok);

// --- Part B: synthetic gateway -------------------------------------------------------
console.log("B. synthetic gateway (stub fetch, in-test Ed25519 keys)");
async function keypair() {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { kp, publicHex: toHex(new Uint8Array(await subtle.exportKey("raw", kp.publicKey))) };
}
const signer = await keypair();
const foreign = await keypair();
const KEYSET: WorkloadKeyset = {
  subject: null,
  not_after: 1800000000,
  receipt_signing_keys: [{ key_id: "test-receipt-1", algo: "ed25519", public_key: signer.publicHex }],
  e2ee_public_keys: [],
  tls_public_keys: [],
};
const DIGEST = await computeKeysetDigest(KEYSET);
const NOW = 1750001000;
type Tamper = "none" | "response_bytes" | "foreign_key" | "stale_nonce" | "upstream_failed" | "foreign_digest";
const MODEL_TEXT = JSON.stringify({ hello: "world" });
function makeGateway(tamper: Tamper, modelText = MODEL_TEXT): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const receipts = new Map<string, ReceiptDocument>();
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.includes("/aci/attestation")) {
      const nonce = tamper === "stale_nonce" ? "ee".repeat(32) : new URL(url).searchParams.get("nonce");
      const report: AttestationReport = {
        api_version: "aci/1",
        workload_keyset_digest: DIGEST,
        attestation: { tee_type: "tdx", workload_keyset: KEYSET, report_data: await computeReportData(DIGEST, nonce), source_provenance: { repo_url: "https://example.invalid/gw.git", repo_commit: "0".repeat(40) }, evidence: { quote: "00" } },
        service_capabilities: { serving: "aggregator" },
      };
      return new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/chat/completions")) {
      const requestBody = String(init?.body);
      const id = `chatcmpl-${++n}`;
      const responseBody = JSON.stringify({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: modelText }, finish_reason: "stop" }] });
      const hashedResponse = tamper === "response_bytes" ? responseBody + " " : responseBody;
      const upstream = tamper === "upstream_failed"
        ? { type: "upstream.verified", result: "failed", required: false, model_id: "demo", reason: "no verified session" }
        : { type: "upstream.verified", result: "verified", required: true, model_id: "demo", session_id: "ab".repeat(32) };
      const unsigned = {
        api_version: "aci/1", receipt_id: `rcpt-${n}`, chat_id: id, model: "demo", workload_keyset_digest: tamper === "foreign_digest" ? "sha256:" + "11".repeat(32) : DIGEST,
        endpoint: "/v1/chat/completions", method: "POST", served_at: NOW + 1, key_id: "test-receipt-1",
        event_log: [
          { type: "request.received", body_hash: await sha256Prefixed(requestBody) },
          { type: "request.forwarded", body_hash: await sha256Prefixed(requestBody) },
          upstream,
          { type: "response.returned", body_hash: await sha256Prefixed(hashedResponse) },
        ],
      };
      const key = tamper === "foreign_key" ? foreign.kp.privateKey : signer.kp.privateKey;
      const signature = toHex(new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, jcsBytes(unsigned) as BufferSource)));
      receipts.set(`rcpt-${n}`, { ...unsigned, signature });
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/json", "x-receipt-id": `rcpt-${n}`, "x-aci-keyset-digest": DIGEST, "x-aci-version": "aci/1" } });
    }
    const m = url.match(/\/aci\/receipts\/([^/?]+)$/);
    if (m) {
      const r = receipts.get(decodeURIComponent(m[1]));
      return r ? new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } }) : new Response(`{"error":"not_found"}`, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

const clean = makeGateway("none");
const r0 = await attestedChatCompletion({ apiKey: "test-key", prompt: "ping", model: "demo", fetchImpl: clean.fetch, now: NOW, base: "https://gw.test/v1" });
check("clean exchange: text is the model content", r0.text === MODEL_TEXT);
check("clean exchange: verified, every check true", r0.detection.verified && Object.values(r0.detection.checks).every((v) => v === true), JSON.stringify(r0.detection.details.filter((c) => !c.ok)));
check("clean exchange: request_sha256 is over the exact bytes sent (prompt committed)", r0.detection.request_sha256 === (await sha256Prefixed(r0.raw.request_body)) && r0.raw.request_body.includes(`"content":"ping"`));
check("clean exchange: request carries provider.aci_verified=true by default", JSON.parse(r0.raw.request_body).provider?.aci_verified === true);
check("clean exchange: detector_output_sha256 = sha256(model text)", r0.detection.detector_output_sha256 === (await sha256Hex(MODEL_TEXT)));
check("clean exchange: record pins keyset digest, key id, repo_commit, receipt, session", r0.detection.workload_keyset_digest === DIGEST && r0.detection.receipt_key_id === "test-receipt-1" && r0.detection.repo_commit === "0".repeat(40) && r0.detection.receipt.receipt_id === "rcpt-1" && r0.detection.upstream?.session_id === "ab".repeat(32));
check("clean exchange: the archived receipt re-verifies offline from the record alone", (await verifyReceipt(r0.detection.receipt, r0.detection.keyset, r0.detection.workload_keyset_digest)).ok);
check("clean exchange: authorization header carried the key, nothing in the record does", r0.raw.request_body.includes("test-key") === false && JSON.stringify(r0.detection).includes("test-key") === false);

const tampers: [Tamper, keyof AttestedDetection["checks"]][] = [
  ["response_bytes", "response_hash"],
  ["foreign_key", "receipt_signature"],
  ["stale_nonce", "report_binding"],
  ["upstream_failed", "upstream_verified"],
  ["foreign_digest", "receipt_document"],
];
for (const [tamper, failing] of tampers) {
  const gw = makeGateway(tamper);
  // requireEstablished:false here so the stale-nonce case reaches the receipt and shows an ISOLATED failure; the default is tested next.
  const r = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw.fetch, now: NOW, base: "https://gw.test/v1", requireEstablished: false });
  const others = (Object.keys(r.detection.checks) as (keyof AttestedDetection["checks"])[]).filter((k) => k !== failing && k !== "chat_id_match");
  // foreign_digest also breaks the receipt->keyset binding only; report binding stays true. foreign_key breaks only the signature.
  check(`tamper ${tamper.padEnd(16)} -> ${failing} false, verified false`, r.detection.checks[failing] === false && !r.detection.verified, JSON.stringify(r.detection.checks));
  check(`tamper ${tamper.padEnd(16)} -> every other check still true (isolated failure)`, others.every((k) => r.detection.checks[k] === true), JSON.stringify(r.detection.checks));
}

{
  const gw = makeGateway("stale_nonce");
  let err: unknown = null;
  try { await attestedChatCompletion({ apiKey: "k", prompt: "SECRET-INTENT", model: "demo", fetchImpl: gw.fetch, now: NOW, base: "https://gw.test/v1" }); } catch (e) { err = e; }
  check("default: a failed report binding withholds the prompt - WorkloadNotEstablishedError before any /chat/completions call", err instanceof WorkloadNotEstablishedError && !gw.calls.some((u) => u.endsWith("/chat/completions")));
}

// --- Part C: the ModelFn seam --------------------------------------------------------
console.log("C. consensus extraction through the attested detector");
const F = (state: string, value?: unknown, quote?: string) => (state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state });
const EXTRACTION = {
  agent_type: "trader", intended_action: "open", market_type: "perp",
  leverage: F("present", 10), position_size: F("present", 3000), stop_loss: F("present", 79800), take_profit: F("present", 73000),
  invalidation_condition: F("absent", undefined, "TP $73,000"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"),
  data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("absent", undefined, "x"),
  thesis_statement: F("present", "funding extreme, 82K rejected 4x"),
};
const INTENT = "Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000.";
{
  const gw = makeGateway("none", JSON.stringify(EXTRACTION));
  const sink: AttestedDetection[] = [];
  const detector = buildPhalaDetector({ apiKey: "k", model: "demo", fetchImpl: gw.fetch, now: NOW, base: "https://gw.test/v1", sink });
  const r = await extractAuditInputConsensus(INTENT, detector, 3, "perp");
  check("N=3 consensus ran three attested calls -> three receipts", sink.length === 3 && new Set(sink.map((d) => d.receipt_id)).size === 3);
  check("one attestation established and shared across the parallel samples", gw.calls.filter((u) => u.includes("/aci/attestation")).length === 1);
  check("every receipt verified; detector_output_sha256 identical across samples and equal to sha256(text)", sink.every((d) => d.verified) && new Set(sink.map((d) => d.detector_output_sha256)).size === 1 && sink[0].detector_output_sha256 === (await sha256Hex(JSON.stringify(EXTRACTION))));
  check("the extraction itself is untouched by the lane (thesis present, leverage present)", r.input.thesis_statement.state === "present" && r.input.leverage.state === "present" && r.disagreements.length === 0);
  check("request_sha256 differs from a different prompt's (the prompt is in the hash preimage)", sink[0].request_sha256 !== r0.detection.request_sha256);
}
{
  const gw = makeGateway("response_bytes", JSON.stringify(EXTRACTION));
  const sink: AttestedDetection[] = [];
  const detector = buildPhalaDetector({ apiKey: "k", model: "demo", fetchImpl: gw.fetch, now: NOW, base: "https://gw.test/v1", sink });
  let rejected: unknown = null;
  try { await extractAuditInputConsensus(INTENT, detector, 3, "perp"); } catch (e) { rejected = e; }
  check("an unverified sample fails the consensus extraction CLOSED (UnverifiedDetectionError), never a silent verdict", rejected instanceof UnverifiedDetectionError && (rejected as UnverifiedDetectionError).detection.checks.response_hash === false);
  check("the failed receipt is still recorded in the sink for telemetry", sink.length >= 1 && sink.some((d) => !d.verified));
}
{
  const gw = makeGateway("foreign_key", JSON.stringify(EXTRACTION));
  const sink: AttestedDetection[] = [];
  const detector = buildPhalaDetector({ apiKey: "k", model: "demo", fetchImpl: gw.fetch, now: NOW, base: "https://gw.test/v1", sink, onUnverified: "record" });
  const text = await detector("probe");
  check(`onUnverified:"record" (probes only) returns the text and leaves verified=false in the record`, text === JSON.stringify(EXTRACTION) && sink.length === 1 && sink[0].verified === false && sink[0].checks.receipt_signature === false);
}
{
  const gw = makeGateway("none");
  const est = await establishWorkload({ base: "https://gw.test/v1", fetchImpl: gw.fetch, now: NOW });
  check("establishWorkload: binding ok, digest recomputed (not copied), keyset kept", est.ok && est.digest === DIGEST && est.keyset.receipt_signing_keys[0].key_id === "test-receipt-1");
  check("fromHex/toHex round trip and 0x tolerance", toHex(fromHex("0xDEADbeef")) === "deadbeef");
}

console.log(ok ? "ATTESTED_DETECTOR TEST PASS" : "ATTESTED_DETECTOR TEST FAIL");
if (!ok) process.exit(1);
