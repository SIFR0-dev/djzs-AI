/**
 * Offline test of the fill34 wire-in (DJZS-AD-v0.1 detector switch). No network, no key.
 *
 * What it proves:
 *   A. the switch: Anthropic by default; "phala" without PHALA_API_KEY fails closed (never a
 *      silent fallback); both fixed codes are in the Fault vocabulary;
 *   B. PARITY: the same extracted struct gives a byte-identical verdict_hash and an otherwise
 *      identical result through the attested lane and through a plain model function - the
 *      lane adds `attested_detection` and changes nothing else (PM and perp pipelines);
 *   C. the block: three verified receipts, each re-verifying offline under the archived keyset,
 *      and a binding hash that recomputes from (verdict_hash, intent_sha256, the detector
 *      output hashes, the receipt ids);
 *   D. a refusal (out of scope) carries no block and is unchanged;
 *   E. an unverified receipt rejects the whole extraction with the fixed code detector_unverified;
 *   F. the HTTP engine adapter: the block rides VerdictResult; a failure rejects from scopeCheck
 *      (the uncharged path); the Anthropic path through the adapter is unchanged.
 */
import {
  ATTESTED_BINDING_VERSION,
  attestedBindingHash,
  createDetector,
  detectorFault,
  DetectorUnavailableError,
  finishDetection,
  runDetected,
  type AttestedDetectionBlock,
  type DetectorHandle,
} from "../djzs-trust-mcp/src/detector";
import { runVerifyPmTrade } from "../djzs-trust-mcp/src/verify-pm-trade";
import { runVerifyPerpTrade } from "../djzs-trust-mcp/src/verify-perp-trade";
import { createEngineAdapter, intentSha256, renderIntentText } from "../djzs-trust-mcp/src/engine-adapter";
import { FAULTS } from "../djzs-trust-mcp/src/safe-error";
import { sha256Hex as djzsSha256Hex } from "../server/engine-v2/hash";
import {
  computeKeysetDigest,
  computeReportData,
  jcsBytes,
  sha256Hex,
  sha256Prefixed,
  toHex,
  UnverifiedDetectionError,
  verifyReceipt,
  type AttestationReport,
  type FetchLike,
  type ReceiptDocument,
  type WorkloadKeyset,
} from "../djzs-trust-mcp/src/attested-detector";

let ok = true;
const check = (label: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${label}${!pass && detail ? ` - ${detail}` : ""}`);
};
const subtle = globalThis.crypto.subtle;
const strip = (r: Record<string, unknown>) => { const { attested_detection: _a, ...rest } = r; return JSON.stringify(rest); };

// --- fixtures (the adapter-offline harness's PM pair; the perp pipeline test's perp pair) ---------
const PM_INTENT = {
  market: "KXBTC-26AUG29-T70000", side: "YES",
  thesis: "BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it",
  probability_basis: "gut feel, roughly a 60 percent chance", size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
};
const PM_EXTRACTION = {
  agent_type: "trader", intended_action: "buy YES on KXBTC-26AUG29-T70000", audit_context: "prediction_market",
  leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "present", value: "daily close below 66000" }, take_profit: { state: "unknown" },
  invalidation_condition: { state: "present", value: "daily close below 66000" }, resolution_engagement: { state: "unknown" },
  probability_basis: { state: "absent", quote: "gut feel, roughly a 60 percent chance" }, edge_claim: { state: "absent", quote: "everyone knows it" },
  data_sources: { state: "unknown" }, oracle_source: { state: "unknown" }, confidence: { state: "unknown" },
};
const F = (state: string, value?: unknown, quote?: string) => (state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state });
const PERP_INTENT = "Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000.";
const PERP_EXTRACTION = {
  agent_type: "trader", intended_action: "open", market_type: "perp",
  leverage: F("present", 10), position_size: F("present", 3000), stop_loss: F("present", 79800), take_profit: F("present", 73000),
  invalidation_condition: F("absent", undefined, "TP $73,000"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"),
  data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("absent", undefined, "x"),
  thesis_statement: F("present", "funding extreme, 82K rejected 4x"),
};

// --- synthetic ACI gateway (same constructions as tests/attested-detector.test.ts) -----------------
const signer = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const KEYSET: WorkloadKeyset = { subject: null, not_after: 1800000000, receipt_signing_keys: [{ key_id: "test-receipt-1", algo: "ed25519", public_key: toHex(new Uint8Array(await subtle.exportKey("raw", signer.publicKey))) }], e2ee_public_keys: [], tls_public_keys: [] };
const DIGEST = await computeKeysetDigest(KEYSET);
const NOW = 1750001000;
function makeGateway(modelText: string, tamper: "none" | "response_bytes" = "none"): { fetch: FetchLike; chatCalls: () => number } {
  const receipts = new Map<string, ReceiptDocument>();
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes("/aci/attestation")) {
      const nonce = new URL(url).searchParams.get("nonce");
      const report: AttestationReport = { api_version: "aci/1", workload_keyset_digest: DIGEST, attestation: { tee_type: "tdx", workload_keyset: KEYSET, report_data: await computeReportData(DIGEST, nonce), source_provenance: { repo_url: "https://example.invalid/gw.git", repo_commit: "0".repeat(40) }, evidence: { quote: "00" } }, service_capabilities: { serving: "aggregator" } };
      return new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/chat/completions")) {
      const requestBody = String(init?.body);
      const id = `chatcmpl-${++n}`;
      const responseBody = JSON.stringify({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: modelText }, finish_reason: "stop" }] });
      const hashed = tamper === "response_bytes" ? responseBody + " " : responseBody;
      const unsigned = { api_version: "aci/1", receipt_id: `rcpt-${n}`, chat_id: id, model: "demo", workload_keyset_digest: DIGEST, endpoint: "/v1/chat/completions", method: "POST", served_at: NOW + 1, key_id: "test-receipt-1",
        event_log: [{ type: "request.received", body_hash: await sha256Prefixed(requestBody) }, { type: "request.forwarded", body_hash: await sha256Prefixed(requestBody) }, { type: "upstream.verified", result: "verified", required: true, model_id: "demo-served", session_id: "ab".repeat(32) }, { type: "response.returned", body_hash: await sha256Prefixed(hashed) }] };
      const signature = toHex(new Uint8Array(await subtle.sign({ name: "Ed25519" }, signer.privateKey, jcsBytes(unsigned) as BufferSource)));
      receipts.set(`rcpt-${n}`, { ...unsigned, signature });
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/json", "x-receipt-id": `rcpt-${n}`, "x-aci-keyset-digest": DIGEST, "x-aci-version": "aci/1" } });
    }
    const m = url.match(/\/aci\/receipts\/([^/?]+)$/);
    if (m) { const r = receipts.get(decodeURIComponent(m[1])); return r ? new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } }) : new Response(`{"error":"not_found"}`, { status: 404 }); }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, chatCalls: () => n };
}
const PHALA_ENV = { DJZS_DETECTOR: "phala", PHALA_API_KEY: "test-phala-key" };
const phalaHandle = (gw: { fetch: FetchLike }) => createDetector(PHALA_ENV, { fetchImpl: gw.fetch, now: NOW });

// --- A. the switch --------------------------------------------------------------------------------
console.log("A. detector switch");
{
  const a = createDetector({ ANTHROPIC_API_KEY: "k" });
  check("default (DJZS_DETECTOR unset) is the Anthropic detector, empty sink", a.kind === "anthropic" && a.model === "claude-sonnet-4-6" && a.sink.length === 0);
  check(`DJZS_DETECTOR="anthropic" is the Anthropic detector`, createDetector({ ANTHROPIC_API_KEY: "k", DJZS_DETECTOR: "anthropic" }).kind === "anthropic");
  let e1: unknown = null; try { createDetector({}); } catch (e) { e1 = e; }
  check("no key at all: DetectorUnavailableError / detector_not_configured, message keeps the EXTRACTION_UNAVAILABLE prefix", e1 instanceof DetectorUnavailableError && e1.detail === "detector_not_configured" && e1.message.startsWith("EXTRACTION_UNAVAILABLE") && detectorFault(e1) === "detector_not_configured");
  let e2: unknown = null; try { createDetector({ DJZS_DETECTOR: "phala", ANTHROPIC_API_KEY: "k" }); } catch (e) { e2 = e; }
  check(`"phala" without PHALA_API_KEY fails CLOSED even with an Anthropic key present (no silent fallback)`, e2 instanceof DetectorUnavailableError && e2.detail === "detector_not_configured");
  const p = createDetector({ DJZS_DETECTOR: "phala", PHALA_API_KEY: "p", PHALA_MODEL: " demo-model " }, { fetchImpl: makeGateway("{}").fetch, now: NOW });
  check("phala handle: kind, trimmed PHALA_MODEL, sink ready", p.kind === "phala" && p.model === "demo-model" && Array.isArray(p.sink));
  check("Fault vocabulary carries detector_not_configured and detector_unverified", (FAULTS as readonly string[]).includes("detector_not_configured") && (FAULTS as readonly string[]).includes("detector_unverified"));
  check("detectorFault is undefined for a foreign error (callers rethrow it)", detectorFault(new Error("boom")) === undefined);
}

// --- B/C. parity and the block: PM ------------------------------------------------------------------
console.log("B. PM pipeline parity + block");
const pmText = renderIntentText(PM_INTENT);
const pmPlain = (await runVerifyPmTrade(pmText, async () => JSON.stringify(PM_EXTRACTION))) as Record<string, unknown>;
let pmBlock: AttestedDetectionBlock | undefined;
{
  const gw = makeGateway(JSON.stringify(PM_EXTRACTION));
  const h = phalaHandle(gw);
  const r = (await runDetected(() => runVerifyPmTrade(pmText, h.modelFn), h, pmText)) as Record<string, unknown>;
  check("PM: in scope, verdict_hash byte-identical to the plain-model run", r.in_scope === true && r.verdict_hash === pmPlain.verdict_hash && typeof r.verdict_hash === "string");
  check("PM: every other field identical (the lane adds attested_detection and nothing else)", strip(r) === strip(pmPlain) && r.attested_detection !== undefined);
  check("PM: exactly one N=3 extraction - three gateway calls", gw.chatCalls() === 3 && h.sink.length === 3);
  pmBlock = r.attested_detection as AttestedDetectionBlock;
  const b = pmBlock;
  check("block: scheme/provider/pins", b.scheme === "DJZS-AD-v0.1" && b.provider === "phala-aci" && b.workload_keyset_digest === DIGEST && b.receipt_key_id === "test-receipt-1" && b.repo_commit === "0".repeat(40) && b.model === "qwen/qwen3.8-27b");
  check("block: three samples, all verified, distinct receipts, model_served and session recorded", b.samples.length === 3 && b.samples.every((s) => s.verified && s.model_served === "demo-served" && s.session_id === "ab".repeat(32)) && new Set(b.samples.map((s) => s.receipt_id)).size === 3);
  const expectedOut = await sha256Hex(JSON.stringify(PM_EXTRACTION));
  check("block: detector_output_sha256 = sha256(model text) on every sample", b.samples.every((s) => s.detector_output_sha256 === expectedOut));
  check("block: binding fields = verdict_hash, intent_sha256 of the audited text, the three output hashes, the receipt ids", b.binding.version === ATTESTED_BINDING_VERSION && b.binding.verdict_hash === r.verdict_hash && b.binding.intent_sha256 === djzsSha256Hex(pmText) && b.binding.intent_sha256 === intentSha256(PM_INTENT) && /^0x[0-9a-f]{64}$/.test(b.binding.intent_sha256) && JSON.stringify(b.binding.detector_output_sha256) === JSON.stringify(b.samples.map((s) => s.detector_output_sha256)) && JSON.stringify(b.binding.receipt_ids) === JSON.stringify(b.samples.map((s) => s.receipt_id)));
  const recomputed = attestedBindingHash({ verdict_hash: b.binding.verdict_hash, intent_sha256: b.binding.intent_sha256, detector_output_sha256: b.binding.detector_output_sha256, receipt_ids: b.binding.receipt_ids });
  const manual = djzsSha256Hex(new TextDecoder().decode(jcsBytes({ v: "DJZS-AD-B1", verdict_hash: b.binding.verdict_hash, intent_sha256: b.binding.intent_sha256, detector_output_sha256: b.binding.detector_output_sha256, receipt_ids: b.binding.receipt_ids })));
  check("block: binding.hash recomputes (library and by hand), 0x-prefixed like verdict_hash", b.binding.hash === recomputed && b.binding.hash === manual && /^0x[0-9a-f]{64}$/.test(b.binding.hash));
  const foreign = attestedBindingHash({ verdict_hash: "0x" + "00".repeat(32), intent_sha256: b.binding.intent_sha256, detector_output_sha256: b.binding.detector_output_sha256, receipt_ids: b.binding.receipt_ids });
  check("block: a different verdict_hash gives a different binding", foreign !== b.binding.hash);
  let reverify = true;
  for (const s of b.samples) reverify &&= (await verifyReceipt(s.receipt, b.keyset, b.workload_keyset_digest)).ok;
  check("block: every archived receipt re-verifies offline under the archived keyset", reverify && (await computeKeysetDigest(b.keyset)) === b.workload_keyset_digest);
  check("block: no key material in the block", !JSON.stringify(b).includes("test-phala-key"));
  const anthropic: DetectorHandle = { kind: "anthropic", model: "stub", modelFn: async () => JSON.stringify(PM_EXTRACTION), sink: [] };
  const viaAnthropic = (await runDetected(() => runVerifyPmTrade(pmText, anthropic.modelFn), anthropic, pmText)) as Record<string, unknown>;
  check("Anthropic path through the same helper: result byte-identical, no attested_detection", JSON.stringify(viaAnthropic) === JSON.stringify(pmPlain) && !("attested_detection" in viaAnthropic));
  check("finishDetection is a no-op for a result without a verdict_hash", JSON.stringify(await finishDetection({ in_scope: true, x: 1 }, h, pmText)) === JSON.stringify({ in_scope: true, x: 1 }));
}

// --- B/C. parity and the block: perp ---------------------------------------------------------------
console.log("C. perp pipeline parity + block");
{
  const BRACKET = { side: "long" as const, entry: 100_000, stop: 99_000, target: 102_000, taker_fee_bps: 5, hit_rate_pct: 45 };
  const plain = (await runVerifyPerpTrade(PERP_INTENT, async () => JSON.stringify(PERP_EXTRACTION), BRACKET)) as Record<string, unknown>;
  const gw = makeGateway(JSON.stringify(PERP_EXTRACTION));
  const h = phalaHandle(gw);
  const r = (await runDetected(() => runVerifyPerpTrade(PERP_INTENT, h.modelFn, BRACKET), h, PERP_INTENT)) as Record<string, unknown>;
  check("perp: PASS in both lanes, verdict_hash byte-identical, mechanics identical", r.verdict === "PASS" && plain.verdict === "PASS" && r.verdict_hash === plain.verdict_hash && JSON.stringify(r.mechanics) === JSON.stringify(plain.mechanics));
  check("perp: every other field identical; block present with 3 verified samples", strip(r) === strip(plain) && (r.attested_detection as AttestedDetectionBlock).samples.length === 3 && (r.attested_detection as AttestedDetectionBlock).samples.every((s) => s.verified));
  check("perp: binding over the perp verdict_hash and sha256 of the perp intent text", (r.attested_detection as AttestedDetectionBlock).binding.verdict_hash === r.verdict_hash && (r.attested_detection as AttestedDetectionBlock).binding.intent_sha256 === djzsSha256Hex(PERP_INTENT));
  check("perp: blocks differ from the PM block (different receipts, different binding)", (r.attested_detection as AttestedDetectionBlock).binding.hash !== pmBlock?.binding.hash);
}

// --- D. refusal -------------------------------------------------------------------------------------
console.log("D. refusal carries no block");
{
  const plain = (await runVerifyPerpTrade(pmText, async () => JSON.stringify({ ...PM_EXTRACTION }))) as Record<string, unknown>;
  const gw = makeGateway(JSON.stringify({ ...PM_EXTRACTION }));
  const h = phalaHandle(gw);
  const r = (await runDetected(() => runVerifyPerpTrade(pmText, h.modelFn), h, pmText)) as Record<string, unknown>;
  check("a PM bet sent to the perp pipeline: in_scope:false, unchanged, no attested_detection (the refusal is free and unattested)", r.in_scope === false && plain.in_scope === false && JSON.stringify(r) === JSON.stringify(plain) && !("attested_detection" in r) && h.sink.length === 3);
}

// --- E. an unverified receipt ---------------------------------------------------------------------
console.log("E. unverified receipt fails closed");
{
  const gw = makeGateway(JSON.stringify(PM_EXTRACTION), "response_bytes");
  const h = phalaHandle(gw);
  let err: unknown = null;
  try { await runDetected(() => runVerifyPmTrade(pmText, h.modelFn), h, pmText); } catch (e) { err = e; }
  check("tampered response bytes: the extraction rejects with UnverifiedDetectionError -> fixed code detector_unverified; no verdict exists", err instanceof UnverifiedDetectionError && detectorFault(err) === "detector_unverified" && h.sink.some((d) => !d.verified));
}

// --- F. the HTTP engine adapter ---------------------------------------------------------------------
console.log("F. engine adapter (HTTP x402 routes)");
{
  const gw = makeGateway(JSON.stringify(PM_EXTRACTION));
  const adapter = createEngineAdapter(PHALA_ENV, undefined, runVerifyPmTrade, { fetchImpl: gw.fetch, now: NOW });
  const scope = await adapter.scopeCheck(PM_INTENT);
  const v = await adapter.audit(PM_INTENT);
  const b = (v as { attested_detection?: AttestedDetectionBlock }).attested_detection;
  check("adapter: in scope; audit() carries attested_detection with three verified samples", scope.inScope === true && b !== undefined && b.samples.length === 3 && b.samples.every((s) => s.verified));
  check("adapter: one extraction for scopeCheck + audit (three gateway calls, memoised)", gw.chatCalls() === 3);
  check("adapter: verdict_hash is the engine's (identical to the plain run); binding.intent_sha256 == the route's intent_sha256", v.verdict_hash === pmPlain.verdict_hash && b?.binding.intent_sha256 === v.intent_sha256 && b?.binding.verdict_hash === v.verdict_hash);
  const tampered = createEngineAdapter(PHALA_ENV, undefined, runVerifyPmTrade, { fetchImpl: makeGateway(JSON.stringify(PM_EXTRACTION), "response_bytes").fetch, now: NOW });
  let err: unknown = null; try { await tampered.scopeCheck(PM_INTENT); } catch (e) { err = e; }
  check("adapter: an unverified receipt rejects from scopeCheck (before settlement) with detector_unverified", detectorFault(err) === "detector_unverified");
  let keyErr: unknown = null; try { await createEngineAdapter({ DJZS_DETECTOR: "phala" }).scopeCheck(PM_INTENT); } catch (e) { keyErr = e; }
  check("adapter: phala selected without its key rejects from scopeCheck with detector_not_configured (EXTRACTION_UNAVAILABLE prefix kept)", detectorFault(keyErr) === "detector_not_configured" && (keyErr as Error).message.startsWith("EXTRACTION_UNAVAILABLE"));
  const legacy = createEngineAdapter({}, async () => JSON.stringify(PM_EXTRACTION));
  await legacy.scopeCheck(PM_INTENT);
  const lv = await legacy.audit(PM_INTENT) as Record<string, unknown>;
  check("adapter: the injected-model (Anthropic-shaped) path is unchanged - no attested_detection, same verdict_hash", !("attested_detection" in lv) && lv.verdict_hash === pmPlain.verdict_hash);
}

console.log(ok ? "ATTESTED_WIRE_IN TEST PASS" : "ATTESTED_WIRE_IN TEST FAIL");
if (!ok) process.exit(1);
