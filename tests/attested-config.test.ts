/**
 * Offline test of fill35: the attested lane's request shape and finish-reason telemetry. No network, no key.
 *
 *   A. unset sends EXACTLY fill33's request bytes (no reasoning key, max_tokens 1024);
 *   B. reasoning "off" / "low" are encoded as the gateway's unified field, and the receipt still
 *      verifies - the request hash commits to the bytes actually sent, reasoning field included;
 *   C. finish_reason, usage and returned reasoning are captured; an EMPTY output under a verified
 *      receipt is recorded as such (EMPTY_OUTPUT_SHA256) - verification and parseability are
 *      different questions;
 *   D. the parsers and the detector switch: a bad PHALA_REASONING / PHALA_MAX_TOKENS refuses with
 *      detector_not_configured; good values reach the wire and the attested_detection block.
 */
import {
  attestedChatCompletion,
  computeKeysetDigest,
  computeReportData,
  DEFAULT_MAX_TOKENS,
  EMPTY_OUTPUT_SHA256,
  jcsBytes,
  parseMaxTokens,
  parseReasoningMode,
  reasoningField,
  sha256Prefixed,
  toHex,
  verifyReceipt,
  type AttestationReport,
  type FetchLike,
  type ReceiptDocument,
  type WorkloadKeyset,
} from "../djzs-trust-mcp/src/attested-detector";
import { createDetector, detectorFault, runDetected, type AttestedDetectionBlock } from "../djzs-trust-mcp/src/detector";
import { runVerifyPmTrade } from "../djzs-trust-mcp/src/verify-pm-trade";

let ok = true;
const check = (label: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${label}${!pass && detail ? ` - ${detail}` : ""}`);
};
const subtle = globalThis.crypto.subtle;
const signer = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const KEYSET: WorkloadKeyset = { subject: null, not_after: 1800000000, receipt_signing_keys: [{ key_id: "k1", algo: "ed25519", public_key: toHex(new Uint8Array(await subtle.exportKey("raw", signer.publicKey))) }], e2ee_public_keys: [], tls_public_keys: [] };
const DIGEST = await computeKeysetDigest(KEYSET);
const NOW = 1750001000;

interface Reply { content: string; finish_reason?: string; usage?: unknown; reasoning?: string }
/** A synthetic ACI gateway that records every request body and answers with `reply`. */
function gateway(reply: Reply): { fetch: FetchLike; bodies: string[] } {
  const bodies: string[] = [];
  const receipts = new Map<string, ReceiptDocument>();
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes("/aci/attestation")) {
      const nonce = new URL(url).searchParams.get("nonce");
      const report: AttestationReport = { api_version: "aci/1", workload_keyset_digest: DIGEST, attestation: { tee_type: "tdx", workload_keyset: KEYSET, report_data: await computeReportData(DIGEST, nonce), source_provenance: { repo_url: null, repo_commit: null } } };
      return new Response(JSON.stringify(report), { status: 200 });
    }
    if (url.endsWith("/chat/completions")) {
      const requestBody = String(init?.body);
      bodies.push(requestBody);
      const id = `chatcmpl-${++n}`;
      const message: Record<string, unknown> = { role: "assistant", content: reply.content };
      if (reply.reasoning !== undefined) message.reasoning = reply.reasoning;
      const responseBody = JSON.stringify({ id, choices: [{ index: 0, message, finish_reason: reply.finish_reason ?? "stop" }], ...(reply.usage !== undefined ? { usage: reply.usage } : {}) });
      const unsigned = { api_version: "aci/1", receipt_id: `r-${n}`, chat_id: id, model: "demo", workload_keyset_digest: DIGEST, endpoint: "/v1/chat/completions", method: "POST", served_at: NOW, key_id: "k1",
        event_log: [{ type: "request.received", body_hash: await sha256Prefixed(requestBody) }, { type: "upstream.verified", result: "verified", required: true, model_id: "demo", session_id: "cd".repeat(32) }, { type: "response.returned", body_hash: await sha256Prefixed(responseBody) }] };
      const signature = toHex(new Uint8Array(await subtle.sign({ name: "Ed25519" }, signer.privateKey, jcsBytes(unsigned) as BufferSource)));
      receipts.set(`r-${n}`, { ...unsigned, signature });
      return new Response(responseBody, { status: 200, headers: { "x-receipt-id": `r-${n}`, "x-aci-keyset-digest": DIGEST } });
    }
    const m = url.match(/\/aci\/receipts\/([^/?]+)$/);
    if (m) { const r = receipts.get(decodeURIComponent(m[1])); return r ? new Response(JSON.stringify(r), { status: 200 }) : new Response("{}", { status: 404 }); }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, bodies };
}
const BASE = "https://gw.test/v1";

// --- A. unset = fill33's bytes ----------------------------------------------------------------------
console.log("A. unset configuration sends fill33's request bytes");
{
  const gw = gateway({ content: "{}" });
  const r = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw.fetch, now: NOW, base: BASE });
  check("request body is byte-identical to the fill33 shape", gw.bodies[0] === '{"model":"demo","messages":[{"role":"user","content":"ping"}],"max_tokens":1024,"temperature":0,"stream":false,"provider":{"aci_verified":true}}', gw.bodies[0]);
  check("detection records max_tokens 1024 and reasoning null", r.detection.max_tokens === DEFAULT_MAX_TOKENS && DEFAULT_MAX_TOKENS === 1024 && r.detection.reasoning === null);
  check("receipt verified", r.detection.verified);
}

// --- B. reasoning encodings --------------------------------------------------------------------------
console.log("B. reasoning control on the wire");
{
  const gw = gateway({ content: "{}" });
  const r = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw.fetch, now: NOW, base: BASE, reasoning: "off" });
  const body = JSON.parse(gw.bodies[0]);
  check(`"off" sends reasoning {enabled:false}`, JSON.stringify(body.reasoning) === '{"enabled":false}' && body.max_tokens === 1024);
  check(`"off": the receipt still verifies (the request hash covers the reasoning field)`, r.detection.verified && r.detection.checks.request_hash && r.detection.reasoning === "off");
  const gw2 = gateway({ content: "{}" });
  const r2 = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw2.fetch, now: NOW, base: BASE, reasoning: "low", maxTokens: 8192 });
  const b2 = JSON.parse(gw2.bodies[0]);
  check(`"low" + 8192 sends reasoning {effort:"low"} and max_tokens 8192`, JSON.stringify(b2.reasoning) === '{"effort":"low"}' && b2.max_tokens === 8192 && r2.detection.max_tokens === 8192 && r2.detection.verified);
  check("provider.aci_verified still rides every request", body.provider?.aci_verified === true && b2.provider?.aci_verified === true);
  check("reasoningField: off/low/medium/high", JSON.stringify(["off", "low", "medium", "high"].map((m) => reasoningField(m as "off"))) === '[{"enabled":false},{"effort":"low"},{"effort":"medium"},{"effort":"high"}]');
}

// --- C. telemetry ------------------------------------------------------------------------------------
console.log("C. finish_reason / usage / reasoning telemetry");
{
  const gw = gateway({ content: "", finish_reason: "length", reasoning: "thinking...", usage: { prompt_tokens: 3000, completion_tokens: 1024, completion_tokens_details: { reasoning_tokens: 1024 } } });
  const r = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw.fetch, now: NOW, base: BASE });
  const d = r.detection;
  check("finish_reason 'length' captured", d.finish_reason === "length");
  check("usage captured incl. reasoning_tokens", d.usage?.prompt_tokens === 3000 && d.usage?.completion_tokens === 1024 && d.usage?.reasoning_tokens === 1024);
  check("returned reasoning text measured (11 chars)", d.reasoning_chars === 11);
  check("an EMPTY output under a VERIFIED receipt: verified true, detector_output_sha256 = EMPTY_OUTPUT_SHA256", d.verified && r.text === "" && d.detector_output_sha256 === EMPTY_OUTPUT_SHA256);
  check("the receipt re-verifies offline", (await verifyReceipt(d.receipt, d.keyset, d.workload_keyset_digest)).ok);
  const gw2 = gateway({ content: "{}" });
  const r2 = await attestedChatCompletion({ apiKey: "k", prompt: "ping", model: "demo", fetchImpl: gw2.fetch, now: NOW, base: BASE });
  check("no usage block -> usage null, reasoning_chars 0, finish_reason stop", r2.detection.usage === null && r2.detection.reasoning_chars === 0 && r2.detection.finish_reason === "stop");
}

// --- D. parsers and the switch ----------------------------------------------------------------------
console.log("D. parsers and the detector switch");
{
  check("parseReasoningMode: unset/''/default -> undefined; OFF/low -> mode; junk -> null",
    parseReasoningMode(undefined) === undefined && parseReasoningMode("") === undefined && parseReasoningMode("default") === undefined &&
    parseReasoningMode(" OFF ") === "off" && parseReasoningMode("low") === "low" && parseReasoningMode("sideways") === null && parseReasoningMode("none") === null);
  check("parseMaxTokens: unset -> 1024; 8192 -> 8192; 0 / 1.5 / abc / 393217 -> null; 393216 ok",
    parseMaxTokens(undefined) === 1024 && parseMaxTokens(" ") === 1024 && parseMaxTokens("8192") === 8192 && parseMaxTokens("0") === null && parseMaxTokens("1.5") === null && parseMaxTokens("abc") === null && parseMaxTokens("393217") === null && parseMaxTokens("393216") === 393216);
  const refuse = (env: Record<string, string>) => { try { createDetector({ DJZS_DETECTOR: "phala", PHALA_API_KEY: "k", ...env }); return undefined; } catch (e) { return detectorFault(e); } };
  check("PHALA_REASONING=sideways refuses (detector_not_configured)", refuse({ PHALA_REASONING: "sideways" }) === "detector_not_configured");
  check("PHALA_MAX_TOKENS=0 / abc / 999999 refuse (detector_not_configured)", refuse({ PHALA_MAX_TOKENS: "0" }) === "detector_not_configured" && refuse({ PHALA_MAX_TOKENS: "abc" }) === "detector_not_configured" && refuse({ PHALA_MAX_TOKENS: "999999" }) === "detector_not_configured");
  check("valid values do not refuse", refuse({ PHALA_REASONING: "off", PHALA_MAX_TOKENS: "8192" }) === undefined);

  const PM_TEXT = "market: KXBTC-26AUG29-T70000\nside: YES\nthesis: BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it";
  const EXTRACTION = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market",
    leverage: { state: "absent" }, position_size: { state: "unknown" }, stop_loss: { state: "unknown" }, take_profit: { state: "unknown" },
    invalidation_condition: { state: "unknown" }, resolution_engagement: { state: "unknown" }, probability_basis: { state: "unknown" }, edge_claim: { state: "absent", quote: "everyone knows it" },
    data_sources: { state: "unknown" }, oracle_source: { state: "unknown" }, confidence: { state: "unknown" } };
  const gw = gateway({ content: JSON.stringify(EXTRACTION), finish_reason: "stop", usage: { prompt_tokens: 3000, completion_tokens: 300 } });
  const h = createDetector({ DJZS_DETECTOR: "phala", PHALA_API_KEY: "k", PHALA_REASONING: "off", PHALA_MAX_TOKENS: "2048" }, { fetchImpl: gw.fetch, now: NOW });
  const plain = (await runVerifyPmTrade(PM_TEXT, async () => JSON.stringify(EXTRACTION))) as Record<string, unknown>;
  const res = (await runDetected(() => runVerifyPmTrade(PM_TEXT, h.modelFn), h, PM_TEXT)) as Record<string, unknown>;
  const b = res.attested_detection as AttestedDetectionBlock;
  check("switch: all three requests carry reasoning off and max_tokens 2048", gw.bodies.length === 3 && gw.bodies.every((x) => { const o = JSON.parse(x); return JSON.stringify(o.reasoning) === '{"enabled":false}' && o.max_tokens === 2048; }));
  check("block records reasoning 'off', max_tokens 2048 and per-sample finish_reason", b.reasoning === "off" && b.max_tokens === 2048 && b.samples.length === 3 && b.samples.every((s) => s.finish_reason === "stop" && s.verified));
  check("verdict_hash unchanged by the request shape (same struct in, same hash out)", res.verdict_hash === plain.verdict_hash && typeof res.verdict_hash === "string");
}

console.log(ok ? "ATTESTED_CONFIG TEST PASS" : "ATTESTED_CONFIG TEST FAIL");
if (!ok) process.exit(1);
