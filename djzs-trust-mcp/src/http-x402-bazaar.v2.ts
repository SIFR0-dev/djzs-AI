// DJZS_SENTINEL: http-x402-bazaar.v2 payTo=0xc1923748669dFC3a79497d0403A90a275161eCCA network=eip155:8453 price=2000000
//
// http-x402-bazaar.v2.ts
// Plain-HTTP x402 v2 surface for verify_pm_trade — the Bazaar-indexable route.
// Target: djzs-trust-mcp/src/  ·  Mount: POST /x402/verify_pm_trade
// Status: DRAFT-UNVERIFIED until deployed + probed per DEPLOY_RUNBOOK.md
//
// Verified against live npm packages @ build time (2026-08-19):
//   @x402/core@2.23.0  @x402/evm@2.23.0  @x402/extensions@2.23.0
//
// Invariants encoded here (do not reorder without a ruling):
//   0. No payment header            -> 402 BEFORE the body is read, whatever its shape
//   1. Payment header present       -> verify, THEN validate the body (400, uncharged)
//   2. Payment verifies, OUT of scope -> refusal returned, settlePayment NEVER called (uncharged)
//   3. Payment verifies, IN scope   -> settle FIRST, then engine, then verdict + PAYMENT-RESPONSE
//   4. Engine throws after settle   -> AUDIT_ERROR verdict WITH settlement receipt (manual remediation)
//
// "LLM detects, TypeScript decides." Nothing in this file consults a model.

import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import type { PaymentRequirements } from "@x402/core/types";
import type { FacilitatorConfig } from "@x402/core/http";

// ------------------------------------------------------------------
// Canonical constants — content-verify these before every deploy.
// ------------------------------------------------------------------
export const PAY_TO = "0xc1923748669dFC3a79497d0403A90a275161eCCA" as const; // DJZS treasury
export const NETWORK = "eip155:8453" as const; // Base mainnet
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // USDC (Base)
/**
 * The quoted price, in USD. This is the INPUT to buildPaymentRequirements; the
 * atomic amount and the asset are COMPUTED from it (§14: never hand-build
 * requirements — `extra.name` is the EIP-712 domain and is network-dependent).
 */
export const PRICE_USD = 2.0;
/**
 * Post-condition, not an input. 2.00 USDC at 6 decimals. The computed amount is
 * checked against this before any challenge is issued, so a decimals/asset drift
 * in the price path fails closed instead of quoting a caller the wrong number.
 */
export const EXPECTED_ATOMIC_AMOUNT = "2000000" as const;
export const RESOURCE_URL = "https://mcp.djzs.ai/x402/verify_pm_trade" as const;
export const TERMS_URL = "https://djzs.ai/terms" as const;
export const MAX_TIMEOUT_SECONDS = 120;

// ------------------------------------------------------------------
// Engine adapter seam — DJ wires this to deterministic-engine.
// scopeCheck MUST be the same scope logic the MCP transport uses.
// ------------------------------------------------------------------
export interface ScopeResult {
  inScope: boolean;
  reason?: string; // populated on refusal; surfaced uncharged
}

export interface VerdictResult {
  verdict: "PASS" | "WAIT" | "FAIL";
  risk_score: number;
  flags: string[];
  verdict_hash: string;
  intent_sha256: string; // binding key — verdict_hash is not injective
  pol_certificate?: unknown;
}

export interface EngineAdapter {
  scopeCheck(intent: unknown): Promise<ScopeResult>;
  audit(intent: unknown): Promise<VerdictResult>;
}

// Loud default: route is inert until wired. Replace at integration.
export const NOT_WIRED: EngineAdapter = {
  async scopeCheck() {
    throw new Error("ENGINE_ADAPTER_NOT_WIRED: wire deterministic-engine before deploy");
  },
  async audit() {
    throw new Error("ENGINE_ADAPTER_NOT_WIRED: wire deterministic-engine before deploy");
  },
};

// ------------------------------------------------------------------
// Discovery declaration — this is the Bazaar listing content.
// Parameter descriptions are ranking inputs; keep them rich.
// ------------------------------------------------------------------
const discoveryExtensions = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    intent: {
      market: "KXBTC-26AUG29-T70000",
      side: "YES",
      thesis: "BTC closes above 70k by Aug 29 on ETF inflow continuation",
      probability_basis: "implied 0.41 vs model 0.55; basis: Kalshi mid, 2026-08-19T14:00Z",
      size_usd: 250,
      bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
    },
  },
  inputSchema: {
    type: "object",
    required: ["intent"],
    properties: {
      intent: {
        type: "object",
        description:
          "A prediction-market trade intent to be adversarially audited. The engine is deterministic: the LLM layer detects, TypeScript decides. Out-of-scope submissions are refused WITHOUT CHARGE — settlement only occurs for in-scope audits.",
        required: ["market", "side", "thesis"],
        properties: {
          market: {
            type: "string",
            description: "Venue ticker for the target market (e.g. a Kalshi series ticker).",
          },
          side: { type: "string", description: "Position side under audit (e.g. YES / NO / LONG / SHORT)." },
          thesis: {
            type: "string",
            description: "The claim being audited, stated plainly. Vague or unbounded theses draw flags.",
          },
          probability_basis: {
            type: "string",
            description:
              "Where the probability came from: named venue, instrument, and timestamp. Unknown basis is a flagged defect (M02 family).",
          },
          size_usd: { type: "number", description: "Intended position size in USD." },
          bounds: {
            type: "object",
            description: "Loss bound and exit condition. Unbounded intents cannot PASS.",
          },
        },
      },
    },
  },
  output: {
    // Flag strings are the ENGINE'S canonical taxonomy ids, verbatim — "DJZS-M03",
    // not "M03". One vocabulary: a shortened example is a second one waiting to drift.
    example: {
      verdict: "FAIL",
      risk_score: 75,
      flags: ["DJZS-M02", "DJZS-M01", "DJZS-M04", "unknown:probability_basis"],
      verdict_hash: "0xb1a2…9bb3",
      intent_sha256: "…binding key…",
      charged: true,
      terms: TERMS_URL,
    },
  },
});

// ------------------------------------------------------------------
// Resource server — lazy singleton (Workers isolate friendly).
// ------------------------------------------------------------------
export interface X402Env {
  FACILITATOR_URL: string; // CDP: https://api.cdp.coinbase.com/platform/v2/x402
  /**
   * Auth seam: the CDP mainnet facilitator requires request auth headers.
   * Wired at integration to `createCdpAuthHeaders(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`
   * from @coinbase/x402 (see the mount in index.ts).
   *
   * SHAPE CONFIRMED against @x402/core@2.23.0 (the runbook's "confirm the header
   * shape at integration time"): the callback takes NO path argument and returns an
   * object KEYED BY PATH — `{ verify?, settle?, supported?, bazaar? }`, each a headers
   * object. The earlier draft signature `(path) => Record<string,string>` was the flat
   * shape, which @x402/core rejects at runtime rather than silently dropping auth.
   * Typed off the library so a future drift is a compile error, not a 401 in production.
   */
  FACILITATOR_AUTH?: FacilitatorConfig["createAuthHeaders"];
}

/**
 * Build the resource server for THIS request.
 *
 * Constructed per request, never cached in module scope. `env.FACILITATOR_AUTH`
 * closes over request-scoped Worker secrets; a module-scope singleton would pin
 * the FIRST request's closure for the isolate's life, so a rotated CDP key would
 * keep signing with the retired one until the isolate recycled. Same doctrine the
 * /mcp transport and /x402/verify already follow: secrets live on the env binding.
 *
 * `initialize()` fetches the facilitator's supported kinds. It is not optional —
 * buildPaymentRequirements throws without it ("Make sure to call initialize()"),
 * and it is also the call that proves the CDP auth path signs.
 */
async function getServer(env: X402Env): Promise<x402ResourceServer> {
  const facilitator = new HTTPFacilitatorClient({
    url: env.FACILITATOR_URL,
    // createAuthHeaders seam — see DEPLOY_RUNBOOK step 1. Shape confirmed at
    // integration against @x402/core@2.23.0 (path-keyed; see X402Env above).
    ...(env.FACILITATOR_AUTH ? { createAuthHeaders: env.FACILITATOR_AUTH } : {}),
  });

  const server = new x402ResourceServer(facilitator);
  registerExactEvmScheme(server, {}); // exact scheme, server role
  server.registerExtension(bazaarResourceServerExtension);
  await server.initialize();
  return server;
}

export const DESCRIPTION =
  "DJZS adversarial logic audit of a prediction-market trade intent. Deterministic verdict (PASS/WAIT/FAIL) with risk score, defect flags, verdict_hash, and on-chain Proof-of-Logic receipt. Out-of-scope requests are refused WITHOUT CHARGE. Audit, not advice.";

/**
 * Build the payment requirements FROM THE LIBRARY (§14 standing rule).
 *
 * The scheme server computes `amount` (price x decimals) and `extra` (the EIP-712
 * domain: `name` is "USD Coin" on Base mainnet but "USDC" on Base Sepolia, and the
 * name is part of what the payer signs — a hardcoded value silently breaks every
 * payer on the other network). Only `termsOfService` is ours to add; user `extra`
 * merges AFTER the computed extra, so it cannot clobber name/version.
 *
 * 2.23.0 wire shape: lean requirements; resource metadata rides on ResourceInfo.
 * The field is `amount` in current @x402 (older catalogs show `maxAmountRequired`) —
 * one more reason not to hand-build this object.
 */
async function requirements(server: x402ResourceServer): Promise<PaymentRequirements[]> {
  const reqs = await server.buildPaymentRequirements({
    scheme: "exact",
    payTo: PAY_TO,
    price: PRICE_USD,
    network: NETWORK,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { termsOfService: TERMS_URL },
  });

  // POST-CONDITIONS. Computed values are trusted only after they match what this
  // route intends to charge and in which asset. A mismatch is a config fault, not
  // a caller fault: refuse to quote rather than quote something unintended.
  const r = reqs[0];
  if (!r) throw new Error("PRICE_COMPUTE_FAILED: no requirements built for exact/" + NETWORK);
  if (r.amount !== EXPECTED_ATOMIC_AMOUNT) {
    throw new Error(`PRICE_COMPUTE_FAILED: amount ${r.amount} != expected ${EXPECTED_ATOMIC_AMOUNT}`);
  }
  if (r.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new Error(`PRICE_COMPUTE_FAILED: asset ${r.asset} != expected ${USDC_BASE}`);
  }
  return reqs;
}

// ------------------------------------------------------------------
// Handler — mount at POST /x402/verify_pm_trade in the worker router.
// ------------------------------------------------------------------
export async function handleX402VerifyPmTrade(
  request: Request,
  env: X402Env,
  engine: EngineAdapter = NOT_WIRED,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", allow: "POST" }, 405);
  }

  // DISCOVERY ORDERING (same fix HEAD 7634b42 applied to /x402/verify). The 402
  // challenge MUST be reachable regardless of body shape: registration probes and
  // indexers POST an empty or minimal body, and if validation runs first the
  // endpoint answers 400 and is classified UNPAID. NOTHING below reads the body
  // until a payment header has been presented and verified, so the challenge
  // cannot depend on it. Do not move body parsing above the challenge.
  let server: x402ResourceServer;
  let reqs: PaymentRequirements[];
  try {
    server = await getServer(env);
    reqs = await requirements(server);
  } catch (e) {
    // No challenge can be quoted: fail loudly, charge nobody.
    return json(
      { error: "FACILITATOR_UNAVAILABLE", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200), terms: TERMS_URL },
      503,
    );
  }

  // 1 — no payment: 402 challenge with discovery extension attached. Body unread.
  const sigHeader =
    request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT");
  if (!sigHeader) {
    const paymentRequired = await server.createPaymentRequiredResponse(
      reqs,
      { url: RESOURCE_URL, description: DESCRIPTION, serviceName: "DJZS Audit Gate", tags: ["audit", "prediction-markets", "trading", "verification"] },
      undefined,
      discoveryExtensions,
    );
    return new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      },
    });
  }

  // 2 — verify the payment authorization (no funds move here).
  let payload;
  try {
    payload = decodePaymentSignatureHeader(sigHeader);
  } catch {
    return json({ error: "malformed_payment_header", terms: TERMS_URL }, 400);
  }
  const verify = await server.verifyPayment(payload, reqs[0], discoveryExtensions);
  if (!verify?.isValid) {
    return json(
      { error: "payment_verification_failed", detail: verify?.invalidReason ?? "unknown", terms: TERMS_URL },
      402,
    );
  }

  // ── payment VERIFIED but NOT settled. ─────────────────────────────────────
  // 2a — the body is validated HERE, on the paid path only: after the challenge is
  // reachable by any prober, and before any engine work. A paying client with a
  // malformed body is refused with NOTHING SETTLED — settlePayment is unreachable
  // from this branch — so a bad request never costs the payer. This is the only
  // ordering that satisfies both the discovery probe and the money path.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", charged: false, settled: false, terms: TERMS_URL }, 400);
  }
  const intent = (body as Record<string, unknown> | null)?.["intent"];
  if (!intent || typeof intent !== "object") {
    return json(
      { error: "missing_intent", schema: "POST { intent: {…} }", charged: false, settled: false, terms: TERMS_URL },
      400,
    );
  }

  // 3 — SCOPE GATE. Refusal here is the uncharged path: settle is never called.
  const scope = await engine.scopeCheck(intent);
  if (!scope.inScope) {
    return json(
      {
        verdict: "REFUSED_SCOPE",
        reason: scope.reason ?? "out_of_scope",
        charged: false,
        settled: false,
        note: "Scope refusals are uncharged by design. See terms.",
        terms: TERMS_URL,
      },
      200,
    );
  }

  // 4 — settle FIRST (no free verdicts), then run the deterministic engine.
  const settle = await server.settlePayment(payload, reqs[0], discoveryExtensions);
  if (!settle?.success) {
    return json(
      { error: "settlement_failed", detail: settle?.errorReason ?? "unknown", charged: false, terms: TERMS_URL },
      402,
    );
  }

  let result: VerdictResult;
  try {
    result = await engine.audit(intent);
  } catch (e) {
    // Charged-but-errored: surfaced honestly with the receipt for manual remediation.
    return new Response(
      JSON.stringify({
        verdict: "AUDIT_ERROR",
        detail: e instanceof Error ? e.message : "engine_error",
        charged: true,
        remediation: "contact operator with intent_sha256 + settlement tx",
        terms: TERMS_URL,
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle),
        },
      },
    );
  }

  // 5 — verdict + settlement evidence.
  return new Response(
    JSON.stringify({ ...result, charged: true, terms: TERMS_URL }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle),
      },
    },
  );
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
