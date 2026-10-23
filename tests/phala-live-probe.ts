/**
 * Live probe of the attested-detector lane (DJZS-AD-v0.1) against Phala's ACI gateway.
 * ONE non-streaming chat completion capped at 32 output tokens (a thinking-mode model may
 * spend them on reasoning and return empty text - the receipt chain still verifies; rerun
 * with PHALA_MODEL=qwen/qwen-2.5-7b-instruct for a plain instruct model), then the full
 * receipt chain is verified by djzs-trust-mcp/src/attested-detector.ts. Run from the repo root:
 *
 *   PHALA_API_KEY=<key> npx tsx tests/phala-live-probe.ts
 *
 * Optional: PHALA_MODEL=<id> (default PHALA_DEFAULT_MODEL), PHALA_REQUIRE_VERIFIED=0
 * (drops provider.aci_verified - diagnostic only), PHALA_PROMPT="...".
 *
 * Prints a JSON summary and writes the full artifact (detection record, raw response,
 * attestation report, cited session) to tests/out/phala-probe-<utc>.json. The key is
 * never printed or written. Exit 0 only when the detection verified.
 *
 * What only this probe can tell us: that a LIVE receipt verifies under the spec
 * construction (Ed25519 over JCS), the gateway's current keyset digest / signing key /
 * repo_commit to pin, whether the serving upstream was a verified TEE session, and
 * which model id to carry. The offline test already pins the spec vectors; this is the
 * wire.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  attestedChatCompletion,
  computeSessionId,
  establishWorkload,
  PHALA_ACI_BASE,
  PHALA_DEFAULT_MODEL,
  ATTESTED_DETECTOR_VERSION,
} from "../djzs-trust-mcp/src/attested-detector";

const apiKey = process.env.PHALA_API_KEY ?? process.env.PHALA_AI_API_KEY ?? "";
if (!apiKey) {
  console.error("PHALA_API_KEY is not set (phala.com -> Confidential AI -> API keys). Nothing was sent.");
  process.exit(2);
}
const model = process.env.PHALA_MODEL ?? PHALA_DEFAULT_MODEL;
const requireVerified = process.env.PHALA_REQUIRE_VERIFIED !== "0";
const prompt = process.env.PHALA_PROMPT ?? "Reply with exactly one word: OK";
const t0 = Date.now();
const ms = () => `${Date.now() - t0}ms`;

// 1. Establish the workload identity (no key needed for the report; sent anyway).
const est = await establishWorkload({ base: PHALA_ACI_BASE, apiKey });
console.log(`[${ms()}] attestation: binding ${est.ok ? "OK" : "FAILED"} ${JSON.stringify(est.checks.filter((c) => !c.ok))}`);

// 2. One attested call.
let call;
try {
  // requireEstablished:false - a probe wants to see the receipt even when the binding failed (the detector never does).
  call = await attestedChatCompletion({ apiKey, prompt, model, maxTokens: 32, temperature: 0, requireVerified, base: PHALA_ACI_BASE, established: est, requireEstablished: false });
} catch (e) {
  console.error(`[${ms()}] call failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const d = call.detection;
console.log(`[${ms()}] chat: HTTP ${call.raw.status} receipt ${call.raw.receipt_id} text=${JSON.stringify(call.text)}`);

// 3. The cited session (sec.9.2 step 1): the id must recompute from the document's JCS form.
let session: { fetched: boolean; id_recomputes: boolean | null; upstream_name?: unknown; claims?: unknown; document?: unknown; error?: string } = { fetched: false, id_recomputes: null };
if (d.upstream?.session_id) {
  try {
    const res = await fetch(`${PHALA_ACI_BASE}/aci/sessions/${d.upstream.session_id}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
    if (res.ok) {
      const doc = (await res.json()) as Record<string, unknown>;
      const recomputed = await computeSessionId(doc);
      session = { fetched: true, id_recomputes: recomputed === d.upstream.session_id, upstream_name: doc.upstream_name, claims: doc.claims, document: doc };
    } else session = { fetched: false, id_recomputes: null, error: `HTTP ${res.status}` };
  } catch (e) {
    session = { fetched: false, id_recomputes: null, error: e instanceof Error ? e.message : String(e) };
  }
}
console.log(`[${ms()}] session: ${session.fetched ? `fetched, id ${session.id_recomputes ? "recomputes" : "DOES NOT recompute"}` : `not fetched${session.error ? ` (${session.error})` : ""}`}`);

// 4. Current TEE model list - the detector model is a ruling, not a default.
let teeModels: unknown = null;
try {
  const res = await fetch(`${PHALA_ACI_BASE}/models`, { headers: { Accept: "application/json" } });
  const j = (await res.json()) as { data?: { id: string; is_tee?: boolean; providers?: string[]; context_length?: number; pricing?: unknown }[] };
  teeModels = (j.data ?? []).filter((m) => m.is_tee).map((m) => ({ id: m.id, providers: m.providers, context_length: m.context_length, pricing: m.pricing }));
} catch {
  teeModels = null;
}

const summary = {
  scheme: ATTESTED_DETECTOR_VERSION,
  node: process.version,
  gateway: PHALA_ACI_BASE,
  model_requested: model,
  model_served: d.model_served,
  require_verified_sent: requireVerified,
  verified: d.verified,
  checks: d.checks,
  failing: d.details.filter((c) => !c.ok),
  pins: {
    workload_keyset_digest: d.workload_keyset_digest,
    receipt_key_id: d.receipt_key_id,
    receipt_public_key: d.keyset.receipt_signing_keys.find((k) => k.key_id === d.receipt_key_id)?.public_key ?? null,
    repo_url: d.repo_url,
    repo_commit: d.repo_commit,
    keyset_not_after: d.keyset.not_after,
    keyset_not_after_iso: new Date(d.keyset.not_after * 1000).toISOString(),
    serving: est.report.service_capabilities?.serving ?? null,
    report_sha256: d.report_sha256,
    keyset_digest_header: call.raw.keyset_digest_header,
  },
  receipt: { receipt_id: d.receipt_id, chat_id: d.chat_id, served_at: d.served_at, events: d.receipt.event_log.map((e) => e.type) },
  hashes: { request_sha256: d.request_sha256, response_sha256: d.response_sha256, detector_output_sha256: d.detector_output_sha256 },
  upstream: d.upstream,
  session: { fetched: session.fetched, id_recomputes: session.id_recomputes, upstream_name: session.upstream_name ?? null, claims: session.claims ?? null, error: session.error ?? null },
  text: call.text,
  tee_models: teeModels,
  elapsed: ms(),
};
console.log(JSON.stringify(summary, null, 2));

mkdirSync("tests/out", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = `tests/out/phala-probe-${stamp}.json`;
writeFileSync(outPath, JSON.stringify({ summary, detection: d, raw: { request_body: call.raw.request_body, response_body: call.raw.response_body, status: call.raw.status }, attestation_report: est.report, session_document: session.document ?? null }, null, 2));
console.log(`artifact: ${outPath}`);
console.log(d.verified ? "PHALA LIVE PROBE: VERIFIED" : "PHALA LIVE PROBE: NOT VERIFIED");
process.exit(d.verified ? 0 : 1);
