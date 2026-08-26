// DJZS_SENTINEL: discovery-surfaces.v1 host=mcp.djzs.ai routes=llms.txt,.well-known/x402.json,agent-card,root
//
// discovery-surfaces.ts
// Agent-facing discovery surfaces served FROM THE RESOURCE HOST (mcp.djzs.ai).
// Target: djzs-trust-mcp/src/  ·  Mount: first in the worker router, before other routes
// Status: DRAFT-UNVERIFIED until deployed + probed per ENRICHMENT_RUNBOOK.md
//
// WHY THIS EXISTS
// The listing is registered by every documented condition (CDP facilitator settlement,
// discovery extension registered and emitted, CDP-linked payee) and is still not indexed
// at T+5d. The one untested variable on our side: facilitator metadata-enrichment engines
// are documented (for at least one production facilitator) to probe the MERCHANT DOMAIN
// roughly daily for llms.txt, agent well-knowns, and OpenGraph fields. mcp.djzs.ai
// currently serves none of them — the apex djzs.ai carries the manifest, the resource
// host carries nothing. This module closes that gap.
//
// Whether CDP's pipeline probes at all is HYPOTHESIS-GRADE. The fix is zero-regret
// regardless: llms.txt, a host-local manifest, an agent card, and OG metadata are pure
// gain for x402scan, the 402 Index, B402, and any future indexer.
//
// NO DRIFT BY CONSTRUCTION
// Every price, address, network and URL below is imported from http-x402-bazaar.v2.
// The advertised manifest cannot disagree with the live 402 challenge — a change to the
// route changes these surfaces in the same compile.

import {
  PAY_TO,
  NETWORK,
  USDC_BASE,
  EXPECTED_ATOMIC_AMOUNT as PRICE_ATOMIC,
  RESOURCE_URL,
  TERMS_URL,
  DESCRIPTION,
} from "./http-x402-bazaar.v2";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
// Root landing is CONTENT-NEGOTIATED at "/". It does not claim the path.
//
// "/" IS TAKEN (verified at integration 2026-08-25): index.ts registers
//   app.get("/", (c) => c.json({ name: "djzs-trust-mcp", version, status: "operational" }))
// as its liveness surface, and that JSON is load-bearing for anything already
// probing the host root. So the default at "/" is unchanged and is never
// shadowed: handleDiscoverySurfaces returns null for "/" and the existing
// handler answers.
//
// The ONE exception is a caller that explicitly announces text/html in its
// Accept header — a browser, or an enrichment engine fetching OpenGraph. Those
// get the landing; everyone else, including every JSON prober, gets the status
// JSON exactly as before. Crucially `Accept: */*` — curl's default, and what
// most machine probers send — does NOT count as announcing html. Neither does
// an absent or empty Accept. The negotiated response carries `Vary: Accept` so
// an edge cache cannot serve a browser's html to the next JSON prober.
//
// Nearly additive, but not strictly — and the exception is worth knowing. Any
// caller that already sent a browser-shaped Accept to "/" now gets html where it
// used to get the status JSON. Uptime monitors are the realistic case: several
// send `Accept: text/html,...` to look like a browser, and one asserting on
// `application/json` or on a body field would start failing at this deploy. If a
// monitor watches the host root, either point it at /health/x402 (which is what
// it should have been watching) or set its Accept to application/json.
export const NEGOTIATE_ROOT_LANDING = true;

export const HOST = "https://mcp.djzs.ai" as const;
export const APEX = "https://djzs.ai" as const;
export const SERVICE_NAME = "DJZS Audit Gate" as const;

// Real receipt from the 2026-08-20 production settlement. Both values are
// on-chain / response-verified. intent_sha256 is deliberately omitted rather
// than reproduced from a truncated log — no invented evidence.
const REAL_VERDICT_HASH =
  "0x343e465210b7367621553359e57da9ef32fcb7a2dae6f001b5cb513179e09908" as const;
const REAL_SETTLE_TX =
  "0x792ec25081910a6a4cb236705fa38e5349bcfbeb7149fc37bd2b1249c9676724" as const;

const PRICE_HUMAN = "2.00 USDC";

// -------------------------------------------------------------------
// /llms.txt — llmstxt.org convention
// ------------------------------------------------------------------
function llmsTxt(): string {
  return `# ${SERVICE_NAME}

> Deterministic adversarial logic audit for prediction-market trade intents. Paid per call over x402 (${PRICE_HUMAN} on Base). Out-of-scope requests are refused WITHOUT CHARGE. Audit, not advice.

Submit a trade intent; receive a verdict — PASS, WAIT, or FAIL — with a risk score, defect flags, a hash of the submitted intent, and an on-chain Proof-of-Logic receipt. A detection layer reads the intent, a deterministic TypeScript layer decides. One scope check governs both transports, so the MCP tool and the HTTP endpoint cannot drift apart.

The gate audits the internal logic of what you submitted. It does not predict whether a trade will make money.

## Paid endpoints

- [POST /x402/verify_pm_trade](${RESOURCE_URL}): Adversarial audit of one prediction-market trade intent. ${PRICE_HUMAN}, x402 exact scheme, network ${NETWORK}, asset USDC (${USDC_BASE}), paid to ${PAY_TO}. Body: {"intent":{"market","side","thesis","probability_basis","size_usd","bounds"}}. Unpaid requests receive a 402 challenge carrying the full input schema.

## Discovery

- [x402 manifest](${HOST}/.well-known/x402.json): Machine-readable resource, price, and schema declaration.
- [Agent card](${HOST}/.well-known/agent-card.json): A2A-style capability descriptor.
- [Terms of service](${TERMS_URL}): Binding on human and autonomous callers alike.

## How the money behaves

- Unpaid request -> HTTP 402 with a signed-payment challenge. No body required.
- Payment verifies but the intent is out of scope -> refusal returned, settlement never executed, no funds move. This is structural, not discretionary: the settle call is unreachable on the refusal path.
- Payment verifies and the intent is in scope -> settlement first, then the audit, then the verdict with a PAYMENT-RESPONSE receipt header.

## Receipts

A production audit settled on 2026-08-20 returned WAIT with risk 0 and the single flag unknown:invalidation_condition — the engine declined to clear its own advertised example intent because the invalidation condition did not resolve. Verdict hash ${REAL_VERDICT_HASH}; settlement ${REAL_SETTLE_TX} on ${NETWORK}.

## Operator

DJZS AI, LLC (California). Contact: legal@djzs.ai. Site: ${APEX}.
`;
}

// ------------------------------------------------------------------
// /.well-known/x402.json — host-local mirror, derived from route constants
// ------------------------------------------------------------------
function wellKnownX402(): unknown {
  return {
    x402Version: 2,
    publisher: "DJZS AI, LLC",
    canonical: `${HOST}/.well-known/x402.json`,
    termsOfService: TERMS_URL,
    resources: [
      {
        type: "http",
        resource: RESOURCE_URL,
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            asset: USDC_BASE,
            payTo: PAY_TO,
            amount: PRICE_ATOMIC,
            maxAmountRequired: PRICE_ATOMIC, // legacy catalogs read this name
            maxTimeoutSeconds: 120,
            mimeType: "application/json",
            resource: RESOURCE_URL,
            description: DESCRIPTION,
            outputSchema: {
              input: {
                method: "POST",
                type: "http",
                bodySchema: {
                  type: "object",
                  required: ["intent"],
                  properties: {
                    intent: {
                      type: "object",
                      required: ["market", "side", "thesis"],
                      properties: {
                        market: { type: "string", description: "Venue ticker for the target market." },
                        side: { type: "string", description: "Position side under audit." },
                        thesis: { type: "string", description: "The claim being audited, stated plainly." },
                        probability_basis: {
                          type: "string",
                          description: "Named venue, instrument, and timestamp the probability came from.",
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
              },
              output: {
                example: {
                  verdict: "WAIT",
                  risk_score: 0,
                  flags: ["unknown:invalidation_condition"],
                  verdict_hash: REAL_VERDICT_HASH,
                  charged: true,
                  settlement_tx: REAL_SETTLE_TX,
                },
              },
            },
            extra: {
              name: "USD Coin",
              version: "2",
              termsOfService: TERMS_URL,
              unchargedScopeRefusal: true,
            },
          },
        ],
      },
    ],
    notes:
      "Served from the resource host. The apex manifest at https://djzs.ai/.well-known/x402.json is the publisher-level copy; both are generated from the same route constants and cannot disagree with the live 402 challenge.",
  };
}

// ------------------------------------------------------------------
// /.well-known/agent-card.json — A2A-style descriptor
// DRAFT-UNVERIFIED against the current A2A schema; verify field names before
// relying on it for A2A interop. Harmless as a discovery breadcrumb regardless.
// ------------------------------------------------------------------
function agentCard(): unknown {
  return {
    name: SERVICE_NAME,
    description: DESCRIPTION,
    url: HOST,
    provider: { organization: "DJZS AI, LLC", url: APEX },
    version: "1.0.0",
    documentationUrl: `${HOST}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "verify_pm_trade",
        name: "Verify prediction-market trade intent",
        description:
          "Deterministic adversarial audit of one prediction-market trade intent. Returns PASS, WAIT, or FAIL with risk score, defect flags, and an on-chain Proof-of-Logic receipt. Out-of-scope submissions are refused without charge.",
        tags: ["audit", "prediction-markets", "trading", "verification", "x402"],
        examples: [
          'POST {"intent":{"market":"KXBTC-26AUG29-T70000","side":"YES","thesis":"BTC closes above 70k by Aug 29 on ETF inflow continuation","probability_basis":"Kalshi mid 0.41 vs model 0.55, 2026-08-19T14:00Z","size_usd":250,"bounds":{"max_loss_usd":250,"exit_condition":"daily close below 66000"}}}',
        ],
      },
    ],
    payments: {
      protocol: "x402",
      version: 2,
      scheme: "exact",
      network: NETWORK,
      asset: USDC_BASE,
      payTo: PAY_TO,
      amount: PRICE_ATOMIC,
      resource: RESOURCE_URL,
      termsOfService: TERMS_URL,
    },
  };
}

// ------------------------------------------------------------------
// / (negotiated) and /index.html — OpenGraph landing. Enrichment engines pull
// title/description here. See NEGOTIATE_ROOT_LANDING: at "/" this is served only
// to callers that explicitly announce text/html; /index.html serves it outright.
// og:image deliberately omitted: a fabricated or 404 image URL is worse than none.
// ------------------------------------------------------------------
function landingHtml(): string {
  const title = `${SERVICE_NAME} — deterministic trade-intent audit over x402`;
  const desc =
    "Pay-per-call adversarial logic audit for prediction-market trade intents. 2.00 USDC on Base via x402. Out-of-scope requests refused without charge. Audit, not advice.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${HOST}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SERVICE_NAME}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${HOST}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<style>
:root{--bg:#0a0a0a;--fg:#e6e6e6;--muted:#6e6e6e;--accent:#3dff88;--border:#1c1c1c;
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{font-family:var(--mono);background:var(--bg);color:var(--fg);font-size:14px;
line-height:1.7;padding:48px 20px 96px;max-width:760px;margin:0 auto}
a{color:var(--accent);text-decoration:none}
a:hover,a:focus-visible{text-decoration:underline;outline:1px solid var(--accent);outline-offset:2px}
.boot{border:1px solid var(--border);padding:18px 22px;color:var(--muted);font-size:12.5px;
white-space:pre-wrap;margin-bottom:48px}
.boot b{color:var(--accent);font-weight:600}
h1{font-size:20px;font-weight:600;text-transform:uppercase;letter-spacing:.02em;margin-bottom:10px}
.sub{color:var(--muted);font-size:12.5px;margin-bottom:44px}
h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:12px}
section{border-top:1px solid var(--border);padding:28px 0}
p{margin-bottom:12px}
p:last-child{margin-bottom:0}
.hard{border-left:2px solid var(--accent);padding-left:14px}
code{color:var(--accent);font-size:12.5px}
.end{margin-top:36px;color:var(--muted);font-size:12.5px}
</style>
</head>
<body>
<div class="boot"><b>// SYS_ID:</b> DJZS_AUDIT_GATE
<b>// PROTOCOL:</b> x402 v2 · exact · ${NETWORK}
<b>// PRICE:</b> ${PRICE_HUMAN} per audit
<b>// STATUS:</b> LIVE</div>

<h1>${SERVICE_NAME}</h1>
<p class="sub">A deterministic adversarial audit for prediction-market trade intents. Machines welcome; no account, no key, no subscription.</p>
<section>
<h2>What it does</h2>
<p>Submit a trade intent. Receive a verdict — PASS, WAIT, or FAIL — with a risk score, defect flags, a hash of the submitted intent, and an on-chain Proof-of-Logic receipt. A detection layer reads the intent; a deterministic TypeScript layer decides.</p>
<p class="hard">It audits the internal logic of what you submitted. It does not predict whether a trade will make money.</p>
</section>

<section>
<h2>How to call it</h2>
<p><code>POST ${RESOURCE_URL}</code></p>
<p>An unpaid request returns HTTP 402 with the full payment challenge and input schema — no body required. Pay with any x402 v2 exact-scheme client on Base and retry.</p>
</section>

<section>
<h2>Refusals are free</h2>
<p class="hard">If your intent is out of scope, the gate refuses and settlement is never executed — your signed authorization goes unredeemed and no funds move. This is structural: the settle call is unreachable on the refusal path, not withheld by courtesy.</p>
</section>

<section>
<h2>Receipts</h2>
<p>A production audit settled 2026-08-20 returned WAIT, risk 0, flag <code>unknown:invalidation_condition</code> — the engine declined to clear its own advertised example because the invalidation condition did not resolve. Settlement <code>${REAL_SETTLE_TX}</code>.</p>
</section>

<section>
<h2>Machine-readable</h2>
<p><a href="/llms.txt">/llms.txt</a> · <a href="/.well-known/x402.json">/.well-known/x402.json</a> · <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a> · <a href="${TERMS_URL}">terms of service</a></p>
</section>

<p class="end">DJZS AI, LLC · legal@djzs.ai · END_TRANSMISSION. //</p>
</body>
</html>
`;
}

// ------------------------------------------------------------------
// Handler — returns null for any path this module does not own,
// so it can be mounted first without shadowing existing routes.
// ------------------------------------------------------------------
export function handleDiscoverySurfaces(request: Request): Response | null {
  const url = new URL(request.url);
  const path = url.pathname;
  const isRead = request.method === "GET" || request.method === "HEAD";

  if (!isRead) return null;

  if (path === "/llms.txt") {
    return text(llmsTxt(), "text/plain; charset=utf-8");
  }
  if (path === "/.well-known/x402.json") {
    return json(wellKnownX402());
  }
  if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") {
    return json(agentCard());
  }
  // /index.html is unclaimed and is itself an explicit request for html, so it
  // serves the landing outright — no header games needed to see the page, and
  // nothing to shadow. NEGOTIATE_ROOT_LANDING governs "/" only.
  if (path === "/index.html") {
    return text(landingHtml(), HTML_CONTENT_TYPE);
  }

  // "/" is claimed by index.ts's status JSON. Hand back the landing ONLY to a
  // caller that explicitly announced html; otherwise return null and let the
  // existing handler answer. Vary: Accept is not optional here — without it a
  // shared cache can hand a browser's html to the next JSON prober.
  if (NEGOTIATE_ROOT_LANDING && path === "/" && acceptsHtml(request)) {
    return text(landingHtml(), HTML_CONTENT_TYPE, { vary: "Accept" });
  }

  return null;
}

/**
 * Does this request explicitly announce text/html?
 *
 * Word-boundary, case-insensitive. Deliberately NOT a wildcard match: a bare
 * wildcard Accept — curl's default, and what most machine probers send — is
 * false, which is the whole point. Announcing "anything" is not announcing html,
 * and treating it as such would shadow the status JSON for exactly the callers
 * that need it. An absent or empty Accept is likewise false and falls through.
 *
 * The literal has no /g flag: a global regex carries lastIndex between calls and
 * would make this return alternating answers for identical requests.
 */
const HTML_ACCEPT = /\btext\/html\b/i;

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return HTML_ACCEPT.test(accept);
}

const CACHE = "public, max-age=300";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8" as const;

/**
 * `extra` is merged last so a negotiated response can add `Vary: Accept` without
 * a second near-identical helper. Everything this module serves is cacheable and
 * carries the x-djzs-surface marker, which is what post-deploy probe E1 greps for
 * to prove these paths are answered here and not by some other route.
 */
function text(body: string, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": CACHE,
      "x-djzs-surface": "discovery",
      ...extra,
    },
  });
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE,
      "access-control-allow-origin": "*",
      "x-djzs-surface": "discovery",
    },
  });
}
