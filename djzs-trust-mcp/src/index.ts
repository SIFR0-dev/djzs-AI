import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Context, ExecutionContext } from "hono"
import { z } from "zod"
import { VERIFY_PM_TRADE_INPUT, buildAnthropicModelFn, runVerifyPmTrade } from "./verify-pm-trade"
import { VERIFY_PERP_TRADE_INPUT, runVerifyPerpTrade } from "./verify-perp-trade"
import { anchorPolCertificate, buildIrysUploadFn } from "./pol-certificate"
import { renderTargetSystem, verifyTargetSystemClaim, canonicalTargetSystemMessage, TARGET_SYSTEM_CLAIM_VERSION, UNVERIFIED_PREFIX } from "./target-system"
import { correctionsFor } from "./corrections"
import { makeCorrectionAnchorHandler, CORRECTION_ANCHOR_PATH } from "./correction-route"
import { registerSkills, SKILLS_EXTENSION_ID, SKILLS_EXTENSION_SETTINGS } from "./skills-over-mcp"
import {
  PAY_META_KEY, PAY_SESSION_RE, mintPayLink, payLinkText, payLinkDailyLimit, readPaidAudit, handlePayPage, handlePayPost,
  prunePaySessions, type PaidToolName, type PayPreflight, type ToolResultLike,
} from "./pay-link"

/**
 * Minimum scored audits before query_agent_trust reports a rate at all.
 * Ten is a judgement, not a derivation: below it the Wilson interval is wider
 * than the range of rates anyone would act on differently, so the number
 * carries no decision content while still inviting comparison.
 */
const MIN_SCORED_AUDITS = 10

/**
 * Wilson score interval, lower bound, 95% (z = 1.96).
 *
 * Chosen over the normal approximation because it stays inside [0,1] and does
 * not collapse to a point at 0 or n successes — exactly the small-sample cases
 * a trust query hits most. Returns 0 for n = 0 rather than dividing by it; that
 * path is unreachable behind MIN_SCORED_AUDITS and guarded anyway.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return Math.max(0, (centre - margin) / denom)
}
import { buildTrustWriter, describeWriterKey, checkWriterAuthorization, DJZS_TRUST_CONTRACT } from "./trust-writer"
import { logFault, reasonCode, addressOnly, hash32Only, type Fault } from "./safe-error"
import { withX402, normalizeNetwork } from "agents/x402"
import { createFacilitatorConfig, createCdpAuthHeaders } from "@coinbase/x402"
import { handleX402VerifyPmTrade, settlementUncertain, PAY_TO, PM_RESOURCE, PERP_RESOURCE, USDC_BASE, EXPECTED_ATOMIC_AMOUNT, type X402Env } from "./http-x402-bazaar.v2"
import { createEngineAdapter } from "./engine-adapter"
import { startSourceCheck, type SourcesBlock } from "./source-check"
import {
  handleTryExample, handleTryQuota, handleTryVerdict,
  TRY_ANON_DAILY_LIMIT, TRY_ANON_ID_RE, TRY_DAILY_LIMIT, TRY_GLOBAL_DAILY_LIMIT_DEFAULT, TRY_MAX_INTENT_BYTES, TRY_KINDS,
} from "./try-route"
import { handleTryMarkets } from "./try-markets"
import { handleTryMarket } from "./try-market-lookup"
import { runCheckThesis, CHECK_THESIS_DESCRIPTION, CHECK_THESIS_KINDS, CHECK_THESIS_MIN, CHECK_THESIS_MAX } from "./free-check-tool"
import { handleDiscoverySurfaces } from "./discovery-surfaces"
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server"
import { attesterBalance } from "./attest-worker"
import { anchorQ3, keyMatches, validateQ3AnchorRequest } from "./q3-anchor"
import { registerExactEvmScheme } from "@x402/evm/exact/server"
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http"

const IRYS_GRAPHQL_URL = "https://uploader.irys.xyz/graphql"
/**
 * PoL write target (Step 1, D3 ruling 2026-07-12: devnet first). Deliberate
 * asymmetry: the GraphQL query side above reads the MAINNET uploader index, so
 * devnet certs are NOT visible to query_pol_certificates. Mainnet cutover is
 * one [vars] flip (IRYS_NODE_URL) plus a funded key, sequenced by DJ.
 */
const DEFAULT_IRYS_NODE_URL = "https://devnet.irys.xyz"

/**
 * x402 payment configuration.
 * Step 2 (Path B, 2026-07-12): withX402 on the existing per-request McpServer.
 * Step 3 facilitator ruling (A10, 2026-07-14): the CDP facilitator, because the
 * public x402.org facilitator settles TESTNET ONLY (proven live: its /supported
 * lists no eip155:8453) and mainnet is the destination. DJ ruled the former
 * createAuthHeaders ban was a proxy for CUSTODY it never actually controlled;
 * CDP auth authenticates us to the facilitator, it does not custody funds.
 *
 * FLOW OF FUNDS UNCHANGED (non-custodial, Model A Scenario 1): payer -> recipient
 * via the payer's EIP-3009 signature; the facilitator submits transferWithAuth
 * and pays gas. The recipient is bound INSIDE the payer's signature, so no
 * facilitator can redirect, skim, or custody. What CDP adds is an account
 * relationship (accepted, for OFAC/KYT screening and a battle-tested settler),
 * NOT a custody hop.
 *
 * KEY CUSTODY: CDP_API_KEY_ID/SECRET are wrangler SECRETS read request-scoped
 * from env (never module-scope process.env); createFacilitatorConfig takes them
 * as explicit args, the same seam as buildAnthropicModelFn. The auth path
 * bundles under workerd (JWT via jose/WebCrypto; axios tree-shakes out) —
 * instrumented pre-code, throwaway Ed25519 key produced a real Bearer JWT.
 *
 * PRICE 2.00 USDC per audit (repriced 2026-07-16 from 0.25; payer cap moves 250000n -> 2000000n).
 * NETWORK: "base" = Base MAINNET, eip155:8453 (A11 Stage 3, 2026-07-14). CDP
 * settles it (proven via /supported); mainnet Irys anchoring proven in
 * isolation (cert 747n8SZq..., A11 Stage 2). Rehearse locally with one real
 * 2.00 USDC payment (pol-paid-call --network base) BEFORE any production
 * deploy; deploy behind /health/x402 with 5f021c66 named as rollback.
 * RECIPIENT: the dedicated treasury (EIP-55 verified 2026-07-14, matches the
 * one vetted in the reverted 33e6433; distinct from the operator wallet).
 * Committed as a SOURCE CONSTANT on purpose so the compliance grep sees the
 * money path; an env var would blind it.
 * FLOW OF FUNDS still non-custodial (Model A Scenario 1): the recipient is
 * bound inside the payer's EIP-3009 signature; CDP submits and pays gas.
 */
const X402_NETWORK = "base"
const X402_RECIPIENT: `0x${string}` = "0xc1923748669dFC3a79497d0403A90a275161eCCA"
const VERIFY_PM_TRADE_PRICE_USD = 2.00
const VERIFY_PERP_TRADE_PRICE_USD = 2.00 // same price, same rail — no second payment architecture

/**
 * Worker bindings. ANTHROPIC_API_KEY and IRYS_UPLOAD_KEY are wrangler SECRETS
 * (never in wrangler.toml). IRYS_NODE_URL is a plain [vars] entry.
 */
interface Env {
  ANTHROPIC_API_KEY?: string
  /** DJZS-SRC-v0.2 source check (Firecrawl). SECRET. Absent => cited sources report not_checked; audits unchanged. */
  FIRECRAWL_API_KEY?: string
  /** EVM private key hex signing PoL DataItems. Absent => anchoring reports "disabled"; audits still run. */
  IRYS_UPLOAD_KEY?: string
  /** Irys upload node. Defaults to devnet (D3 ruling); mainnet cutover flips this var. */
  IRYS_NODE_URL?: string
  /** Q3 study: bearer for POST /q3/anchor. SECRET. Absent => route returns 503 (anchoring disabled). */
  DJZS_Q3_ANCHOR_KEY?: string
  /** CDP facilitator API key id (A10). SECRET, request-scoped. Absent => paid tool cannot settle. */
  CDP_API_KEY_ID?: string
  MPP_SECRET_KEY?: string
  /** CDP facilitator API key secret (A10). SECRET, request-scoped. Never module-scope. */
  CDP_API_KEY_SECRET?: string
  /** Dedicated authorized-writer key for on-chain trust scores (Phase 3). SECRET. Absent => scoring skipped. */
  DJZS_WRITER_KEY?: string
  /** Base RPC for the score write (Phase 3). Plain var; defaults to https://mainnet.base.org. */
  BASE_RPC_URL?: string
  /** DJZS subgraph GraphQL query URL (Phase 3). SECRET (Studio URL carries an API key). Absent => query_agent_trust reports unavailable. */
  SUBGRAPH_URL?: string
  /**
   * HTTP x402 route network override, CAIP-2 or legacy name. Plain var, TEST ONLY.
   * Absent => the route uses X402_NETWORK (mainnet), identical to /mcp. Set to
   * "base-sepolia" / "eip155:84532" to exercise the route without touching mainnet.
   * The /mcp transport never reads this.
   */
  X402_HTTP_NETWORK?: string
  /**
   * Facilitator base URL for the Bazaar route (/x402/verify_pm_trade). Plain var,
   * OPTIONAL: absent => CDP_FACILITATOR_URL below, the same facilitator the /mcp
   * transport and /x402/verify already use. Present only so a rehearsal can point
   * the route at a different facilitator without a code change.
   */
  FACILITATOR_URL?: string
  /** EAS attester key (v2 receipt). SECRET. Absent => verdicts served, attestation skipped with eas_error. */
  DJZS_ATTESTER_KEY?: string
  /**
   * DJZSVerdictResolver address on Base (a [vars] entry, not a secret). Present => verdicts are
   * attested under EAS schema v3, whose resolver refuses any verdict the on-chain rule
   * (DJZSVerdictRule, DJZS-VR-v1.0) contradicts. Absent => schema v2, unchanged. VERDICT_RULE.md.
   */
  EAS_RESOLVER_ADDRESS?: string
  /**
   * Free-tier ceiling for POST /try/verdict: total free verdicts per UTC day across all wallets
   * (plain var; default 200 in try-route.ts). The per-wallet cap is fixed at 5 there.
   */
  TRY_GLOBAL_DAILY_LIMIT?: string
  /** Plain var. Free checks per UTC day through the MCP check_thesis tool, all callers together. Default 60. */
  TRY_MCP_DAILY_LIMIT?: string
  /** Plain var. Browser pay links minted per UTC day, all callers together (pay-link.ts). Default 300. */
  PAY_LINK_DAILY_LIMIT?: string
  /**
   * D1 telemetry database (wrangler binding TELEMETRY, db djzs-gate-telemetry).
   * OPTIONAL by design: absent binding => recording silently no-ops and every
   * surface still answers. Telemetry is never load-bearing for a response.
   *
   * Typed structurally rather than as D1Database because tsconfig sets
   * `"types": ["node"]`, so @cloudflare/workers-types globals are not in scope;
   * pulling them in to name one type would change global typings project-wide.
   * This describes exactly the surface used and nothing else.
   */
  TELEMETRY?: TelemetryDB
}

/** The slice of the D1 client this worker actually calls. See Env.TELEMETRY. */
interface TelemetryDB {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      /** Row read, used by the /try quota (try-route.ts). Telemetry writes never call it. */
      first<T = Record<string, unknown>>(): Promise<T | null>
    }
  }
}

/**
 * Build a fully-registered MCP server. Constructed PER REQUEST (see the /mcp route)
 * so tool handlers close over the request-time `env` — Workers secrets live only on
 * the env binding, never on module scope. The two registry tools are env-independent
 * and behave identically to before; verify_pm_trade needs env.ANTHROPIC_API_KEY.
 */
/**
 * Wrap a tool handler so an exception becomes a fixed-code isError result. Without it the MCP SDK
 * returns the exception's message to the caller, and agents/x402's withX402 returns
 * `Tool execution failed: ${String(e)}`: an Anthropic, Irys or RPC error body, URL included.
 * isError also keeps the paid tools UNCHARGED (withX402 settles only a non-error result).
 */
function guardTool<A extends unknown[], R>(tool: string, fn: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R | { content: { type: "text"; text: string }[]; isError: true }> => {
    try {
      return await fn(...a)
    } catch (e) {
      logFault(`mcp.${tool}`, e)
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ tool, error: "TOOL_ERROR", detail: "tool_error" satisfies Fault }) }],
        isError: true as const,
      }
    }
  }
}

/**
 * agents/x402 builds its payment-required and receipt results ITSELF, outside the tool callback, so
 * guardTool never sees them, and it relays the facilitator's `invalidReason`, `errorReason` and `payer`
 * verbatim in content[0].text and in _meta["x402/error"]. Rewrite them through the same shape rules the
 * HTTP routes use: a snake_case code or "PAYMENT_FAILED", an address-shaped payer, a hash-shaped tx.
 */
function cleanPaymentResult(r: any): unknown {
  const meta = r?._meta
  const err = meta?.["x402/error"]
  if (err && typeof err === "object") {
    const clean: Record<string, unknown> = { ...err, error: reasonCode(err.error, "PAYMENT_FAILED") }
    if ("payer" in err) {
      const p = addressOnly(err.payer)
      if (p) clean.payer = p
      else delete clean.payer
    }
    r._meta["x402/error"] = clean
    if (r.content?.[0]?.type === "text") r.content[0] = { type: "text", text: JSON.stringify(clean) } // the library stringifies this same payload
  }
  const rec = meta?.["x402/payment-response"]
  if (rec && typeof rec === "object") {
    r._meta["x402/payment-response"] = {
      success: rec.success === true,
      transaction: hash32Only(rec.transaction) ?? "",
      network: typeof rec.network === "string" && /^eip155:\d{1,12}$/.test(rec.network) ? rec.network : "",
      payer: addressOnly(rec.payer) ?? "",
    }
  }
  return r
}
function hardenPaidTool(tool: RegisteredTool): void {
  const inner = tool.handler as unknown as (...a: unknown[]) => Promise<unknown>
  tool.update({ callback: (async (...a: unknown[]) => cleanPaymentResult(await inner(...a))) as never })
}

/** True when the call carries any payment attempt, in _meta (the MCP x402 convention) or as a header. */
function hasPaymentAttempt(extra: unknown): boolean {
  const x = extra as { _meta?: Record<string, unknown>; requestInfo?: { headers?: Record<string, unknown> } } | undefined
  if (x?._meta?.["x402/payment"] !== undefined) return true
  const h = x?.requestInfo?.headers ?? {}
  return ["PAYMENT-SIGNATURE", "payment-signature", "X-PAYMENT", "x-payment"].some((k) => h[k] !== undefined)
}

/**
 * The browser pay link (pay-link.ts), wrapped OUTSIDE hardenPaidTool. When a call carries no payment at all and
 * the answer is the x402 PAYMENT_REQUIRED result, the answer gains a pay link: _meta["ai.djzs/pay"] plus one more
 * text item. _meta["x402/error"] and content[0] are untouched, so an x402 client pays exactly as before; the link
 * only adds a way in for a client with no wallet. Any failure here returns the original answer unchanged.
 */
function offerPayLink(tool: RegisteredTool, name: PaidToolName, env: Env): void {
  const inner = tool.handler as unknown as (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
  tool.update({
    callback: (async (args: Record<string, unknown>, extra: unknown) => {
      const r = (await inner(args, extra)) as ToolResultLike
      try {
        if (hasPaymentAttempt(extra)) return r
        const ch = r?._meta?.["x402/error"] as { error?: unknown; accepts?: unknown; resource?: unknown } | undefined
        if (r?.isError !== true || !ch || ch.error !== "PAYMENT_REQUIRED") return r
        const link = await mintPayLink(env.TELEMETRY, {
          tool: name, args, accepts: ch.accepts, resource: ch.resource, now: new Date(), dailyLimit: payLinkDailyLimit(env.PAY_LINK_DAILY_LIMIT),
        })
        if (!link) return r
        r._meta = { ...r._meta, [PAY_META_KEY]: link }
        r.content = [...(r.content ?? []), { type: "text", text: payLinkText(link) }]
        return r
      } catch (e) {
        logFault("mcp.pay_link", e)
        return r
      }
    }) as never,
  })
}

/**
 * The quote agents/x402 builds for a paid MCP tool (agents 0.17.3 dist/mcp/x402.js): exact scheme, the recipient
 * constant, the tool's price, maxTimeoutSeconds 300, no extra. A pay-page payment must match it or withX402
 * refuses it, so the preflight rebuilds it the same way and checks before a session is claimed.
 */
const X402_MCP_MAX_TIMEOUT_SECONDS = 300

/** Pay link step 1: the facilitator's verify on a freshly built quote. Moves no money. */
async function preflightPayLink(env: Env, tool: PaidToolName, payment: string): Promise<PayPreflight> {
  let payload: unknown
  try { payload = JSON.parse(atob(payment)) } catch { return { ok: false, code: "malformed_payment" } }
  const rs = new x402ResourceServer(new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)))
  registerExactEvmScheme(rs)
  await rs.initialize()
  const reqs = await rs.buildPaymentRequirements({
    scheme: "exact",
    payTo: X402_RECIPIENT,
    price: tool === "verify_perp_trade" ? VERIFY_PERP_TRADE_PRICE_USD : VERIFY_PM_TRADE_PRICE_USD,
    network: normalizeNetwork(X402_NETWORK) as `${string}:${string}`,
    maxTimeoutSeconds: X402_MCP_MAX_TIMEOUT_SECONDS,
  })
  const match = rs.findMatchingRequirements(reqs, payload as never)
  if (!match) return { ok: false, code: "quote_changed" }
  try {
    const vr = await rs.verifyPayment(payload as never, match)
    return vr.isValid ? { ok: true } : { ok: false, code: reasonCode(vr.invalidReason, "payment_invalid") }
  } catch (e) {
    if ((e as { name?: unknown })?.name === "VerifyError") return { ok: false, code: reasonCode((e as { invalidReason?: unknown }).invalidReason, "payment_invalid") }
    throw e
  }
}

/**
 * Pay link step 2: the paid tool itself, called in-process through a real MCP client and the real server, with
 * the browser's payment in _meta["x402/payment"]. Nothing is re-implemented: withX402 verifies, the handler audits
 * and anchors, and withX402 settles only a non-error result, exactly as for an agent paying over /mcp.
 */
async function callPaidToolInProcess(env: Env, tool: PaidToolName, args: Record<string, unknown>, payment: string): Promise<ToolResultLike> {
  const server = buildServer(env)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "djzs-pay-link", version: "1.0.0" })
  await client.connect(clientSide)
  try {
    return (await client.callTool({ name: tool, arguments: args, _meta: { "x402/payment": payment } }, undefined, { timeout: 240_000 })) as ToolResultLike
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Behavior hints, set from what the handlers do (2026-11-20):
 * - the two query tools only read the public Irys index / DJZS subgraph: read-only, repeatable,
 *   external (open world);
 * - the two paid audits settle a USDC payment, anchor a new permanent certificate under a fresh
 *   audit id and, with agent_address, append an on-chain trust-score record. Every one of those
 *   writes is additive (nothing is overwritten or deleted), so destructiveHint is false; a repeat
 *   call pays and anchors again, so idempotentHint is false.
 */
const READ_ONLY_EXTERNAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const PAID_AUDIT_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }

/**
 * Output schemas. Loose objects with only the fields the handlers always set marked required: a
 * paid result is validated AFTER settlement, so an over-strict schema would turn a paid verdict
 * into an error. Extra fields pass through.
 */
const POL_CERTIFICATES_OUTPUT = z.looseObject({
  total_returned: z.number().describe("Number of certificates in this response"),
  pass_count: z.number(),
  fail_count: z.number(),
  wait_count: z.number(),
  other_verdict_count: z.number().describe("Certificates whose verdict is none of PASS, FAIL, WAIT"),
  target_system_unverified_count: z.number().describe("Certificates whose target_system carries the unverified: prefix"),
  window: z.looseObject({
    from_ms: z.number().describe("Window start actually searched, Unix ms"),
    to_ms: z.number().describe("Window end, Unix ms"),
    note: z.string().optional(),
  }),
  notes: z.record(z.string(), z.string()).optional(),
  certificates: z.array(z.looseObject({
    irys_id: z.string().describe("Irys transaction id of the certificate"),
    irys_url: z.string().describe("Gateway URL to fetch the full certificate"),
    timestamp: z.unknown().describe("Index timestamp as returned by Irys"),
    verdict: z.string().describe("PASS, FAIL, WAIT, or unknown"),
    tier: z.string(),
    target_system: z.string().nullable().describe("Signed identifier, unverified:<value>, or null"),
    target_system_verified: z.boolean(),
    audit_id: z.string(),
    corrections: z.array(z.unknown()).describe("Correction Records anchored against this certificate"),
  })),
})

const CHECK_THESIS_OUTPUT = z.looseObject({
  status: z.string().describe("OK (a verdict follows), LIMIT_REACHED (free checks used up for today) or UNAVAILABLE"),
  free: z.boolean().describe("Always true: this tool never charges"),
  attested: z.boolean().optional().describe("Always false: no receipt is written"),
  verdict: z.string().optional().describe("PASS, WAIT, FAIL, or REFUSED_SCOPE when the thesis was sent as the wrong kind"),
  risk_score: z.number().optional(),
  flags: z.array(z.string()).optional(),
  unknown_fields: z.array(z.string()).optional(),
  verdict_hash: z.string().nullable().optional(),
})
const PAID_AUDIT_OUTPUT = z.looseObject({
  status: z.string().describe("PAID, PENDING, PROCESSING, REFUSED_SCOPE, UNCERTAIN, EXPIRED, NOT_FOUND or UNAVAILABLE"),
  pay_session: z.string(),
  tool: z.string().optional().describe("The paid tool that minted the link"),
  charged: z.boolean().nullable().optional().describe("true when paid, false when nothing was charged, null when it cannot be confirmed"),
  audit: z.looseObject({}).optional().describe("PAID: the paid tool's full result (verdict, flags, verdict_hash, certificate)"),
  payment: z.looseObject({}).optional().describe("PAID: the x402 settlement (transaction, network, payer)"),
  pay_url: z.string().optional().describe("PENDING: the link to give the user again"),
  expires_at: z.string().optional(),
  last_attempt: z.string().optional().describe("PENDING: the fixed code of the last refused payment attempt"),
  detail: z.string().optional(),
  remediation: z.string().optional(),
})

const GET_PAID_AUDIT_DESCRIPTION =
  "Collect the result of an audit the user paid for in a browser. When verify_pm_trade or verify_perp_trade is called without " +
  "an x402 payment, its answer carries a pay link and a pay_session, and the user pays 2.00 USDC on that page from their own " +
  "wallet. After the user says they paid, call this with the pay_session. Free and read-only. Returns status PAID with the " +
  "verdict and the receipt, PENDING (not paid yet), PROCESSING, REFUSED_SCOPE (not charged), UNCERTAIN or EXPIRED. " +
  "DO NOT use it to start an audit."

const AGENT_TRUST_OUTPUT = z.looseObject({
  agent: z.string().describe("The queried address, lowercased"),
  status: z.string().describe("no_history, INSUFFICIENT_HISTORY (under 10 scored audits, no rate returned) or OK"),
  trust: z.string().optional(),
  action: z.string().optional(),
  message: z.string().optional(),
  total_audits: z.number().optional(),
  scored_audits: z.number().optional().describe("PASS plus FAIL audits; WAIT is excluded"),
  pass_count: z.number().optional(),
  fail_count: z.number().optional(),
  wait_count: z.number().optional(),
  latest_verdict: z.unknown().optional(),
  latest_risk_score: z.number().optional(),
  flag_counts: z.record(z.string(), z.number()).optional(),
  subgraph_counters: z.looseObject({}).optional(),
  fail_rate: z.number().nullable().optional().describe("FAIL / scored_audits; null below the minimum history"),
  fail_rate_lower_bound_95: z.number().nullable().optional().describe("Wilson 95% lower bound on the fail rate"),
  detail: z.string().optional(),
  interpretation: z.string().optional(),
})

const TRADE_AUDIT_OUTPUT = z.looseObject({
  schema_version: z.string(),
  tool: z.string(),
  in_scope: z.boolean(),
  taxonomy: z.looseObject({}).optional().describe("Ruleset and extraction-contract versions and hashes the verdict ran under"),
  verdict: z.string().describe("PASS, WAIT or FAIL"),
  action: z.string().describe("PROCEED for PASS, HALT for WAIT, FAIL for FAIL"),
  risk_score: z.number(),
  flags: z.array(z.unknown()).optional().describe("Defects found, each with its DJZS code"),
  unknown_fields: z.array(z.unknown()).optional().describe("Fields that could not be resolved from the thesis text"),
  disagreements: z.unknown().optional(),
  verdict_hash: z.string().describe("Reproducible hash binding the verdict to its inputs"),
  tally: z.unknown().optional(),
  extraction_failsafe: z.boolean().optional(),
  halt_reason: z.string().optional().describe("Present on WAIT: what to clarify before re-auditing"),
  fail_reason: z.string().optional(),
  mechanics: z.looseObject({}).optional().describe("verify_perp_trade only: non-scoring execution mechanics"),
  pol_certificate: z.looseObject({}).optional().describe("Anchoring status and Irys id of the Proof-of-Logic certificate"),
  trust_score: z.looseObject({}).optional().describe("On-chain trust-score write status, when agent_address was given"),
  sources: z.looseObject({}).optional().describe("DJZS-SRC-v0.2, non-scoring: for each URL the thesis cites, whether the source carries the claim (supported, figure_not_in_source, span_figure_mismatch, no_supporting_span, unreachable, not_checked), read from the page or, for Polymarket event and FRED series links, from the source data itself (route), with the sha256 of what was read and when (fetched_at)"),
})

/**
 * Handshake metadata (MCP Implementation + server instructions), returned in the initialize result.
 * name/version are unchanged; the rest is what clients and directories display. The icons are the
 * djzs.ai site marks (an SVG plus the 512px PNG), served from the site Worker, not from this one.
 */
const SERVER_INFO = {
  name: "djzs-trust-mcp",
  version: "1.0.0",
  title: "DJZS Trade Audit",
  description:
    "Pre-execution audit for AI trading agents. Checks a prediction-market, perpetual or spot trade thesis for a stated reason, " +
    "a falsification condition and bounded risk before capital is committed, returns PASS, WAIT or FAIL with a reproducible " +
    "verdict hash, and looks up an agent's audit certificates and trust score.",
  websiteUrl: "https://djzs.ai",
  icons: [
    { src: "https://djzs.ai/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://djzs.ai/favicon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
}

const SERVER_INSTRUCTIONS = [
  "DJZS audits the reasoning behind a trade before it executes. It does not predict prices or place orders.",
  "1. Checking a counterparty agent (free, read-only): call query_agent_trust with its wallet address for its pass/fail record, and query_pol_certificates to read its individual audit certificates.",
  `2. Before opening, sizing or increasing a position: send the thesis in the user's own words. Prediction-market bets go to verify_pm_trade; perpetual and spot trades go to verify_perp_trade. Each audit costs ${VERIFY_PM_TRADE_PRICE_USD.toFixed(2)} USDC via x402 on Base and anchors a permanent certificate, so confirm with the user before calling. A thesis sent to the wrong tool is refused without charge.`,
  "2a. No wallet, or not ready to pay: call check_thesis. It is free, returns the same PASS, WAIT or FAIL with the reasons, and writes no receipt. It has a shared daily limit.",
  `2b. The user wants the paid receipt but this client cannot pay x402: the paid tool's payment-required answer also carries a pay link (_meta["${PAY_META_KEY}"] and the text). Give the user the link and the price, wait until they say they paid, then call get_paid_audit with the pay_session. Do not call the paid tool again to pay.`,
  "3. Act on the verdict: PASS (action PROCEED) means the thesis is complete and bounded; WAIT (action HALT) means fields named in halt_reason could not be resolved, so clarify and re-audit; FAIL means do not execute as stated until the flagged defects are fixed.",
  "A verdict grades whether the reasoning is stated, falsifiable and bounded, not whether the trade will win.",
].join("\n")

function buildServer(env: Env): McpServer {
  // A10: the facilitator is CDP, its config (url + createAuthHeaders JWT signer)
  // built from request-scoped secrets. createFacilitatorConfig takes the keys
  // explicitly, so nothing reads module-scope process.env. Absent keys yield a
  // config whose auth cannot sign -> the facilitator refuses -> the paid tool
  // errors BEFORE the handler runs (fail-closed: no free audit is ever served);
  // free tools are unaffected because withX402 gates only the paid tool.
  // capabilities.extensions: Skills over MCP (skills-over-mcp.ts), declared in the initialize result.
  const server = withX402(new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { extensions: { [SKILLS_EXTENSION_ID]: SKILLS_EXTENSION_SETTINGS } },
  }), {
    network: X402_NETWORK,
    recipient: X402_RECIPIENT,
    facilitator: createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
  })

  // Skills over MCP: skills/list, skills/get, and every skill file as a skill:// resource. Compiled-in text only.
  registerSkills(server)

  server.registerTool("query_pol_certificates", {
    title: "Query DJZS ProofOfLogic Certificates",
    description: `Query immutable ProofOfLogic certificates stored on Irys Datachain by DJZS Protocol. USE THIS TOOL when you need to verify audit history for an agent or project before delegating work, check FAIL verdicts, or retrieve certificates by Irys tx ID. DO NOT use for on-chain trust scores — use query_agent_trust for those.`,
    inputSchema: {
      targetSystem: z.string().optional().describe("Return only certificates whose Target-System tag equals this agent or project identifier (a project name or wallet address), matched exactly as written on the certificate"),
      verdict: z.enum(["PASS", "FAIL"]).optional().describe("Return only certificates with this audit outcome"),
      tier: z.enum(["micro", "founder", "treasury"]).optional().describe("Return only certificates carrying this tier tag"),
      limit: z.number().min(1).max(100).default(20).describe("Maximum number of certificates to return, newest first"),
      from_ms: z.number().int().optional().describe("Start of the search window, as Unix time in milliseconds. When omitted the server searches the last 14 days, then the last 3 days if the wider search fails; set it to reach older certificates, and it is used as given"),
      to_ms: z.number().int().optional().describe("End of the search window, as Unix time in milliseconds. When omitted it is one hour after the current time")
    },
    outputSchema: POL_CERTIFICATES_OUTPUT,
    annotations: READ_ONLY_EXTERNAL,
  }, guardTool("query_pol_certificates", async ({ targetSystem, verdict, tier, limit, from_ms, to_ms }) => {
    const tags: Array<{ name: string; values: string[] }> = [
      { name: "Protocol", values: ["ProofOfLogic"] },
      { name: "application-id", values: ["DJZS-Oracle"] }
    ]
    if (targetSystem) tags.push({ name: "Target-System", values: [targetSystem] })
    if (verdict) tags.push({ name: "verdict", values: [verdict] })
    if (tier) tags.push({ name: "tier", values: [tier] })

    // Irys mainnet GraphQL scans by timestamp, so an over-wide window TIMES OUT
    // (proven live 2026-07-15: 7d ~0.3s, 30d ~1.4s, 60d+ times out; write side
    // unaffected). The default path AUTO-NARROWS (14d -> 3d) so the tool
    // self-heals as the mainnet dataset grows instead of erroring; an explicit
    // from_ms is the caller's choice and is used as-is. addenda-8 / ab9c1d1.
    const now = Date.now()
    const toMs = to_ms ?? now + 3600 * 1000
    const windows: number[] = from_ms !== undefined ? [from_ms] : [now - 14 * 864e5, now - 3 * 864e5]

    let data: any = null
    let lastErr: any = null
    let usedFromMs = windows[0]
    for (const fromMs of windows) {
      const query = `query DJZSCerts($tags: [TagFilter!]!, $first: Int!) {
        transactions(tags: $tags, timestamp: {from: ${fromMs}, to: ${toMs}}, first: $first, order: DESC) {
          edges { node { id tags { name value } timestamp } }
        }
      }`
      const response = await fetch(IRYS_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { tags, first: limit } })
      })
      if (!response.ok) { lastErr = `irys_http_${response.status}`; continue }
      const j = await response.json() as any
      if (j.errors?.length) { lastErr = "irys_graphql_error"; continue }
      data = j.data
      usedFromMs = fromMs
      break
    }
    if (!data) {
      return { content: [{ type: "text" as const, text: `Irys query failed on all windows (pass a narrower from_ms/to_ms): ${lastErr}` }], isError: true }
    }

    const certs = await Promise.all(data.transactions.edges.map(async ({ node }: any) => {
      const t: Record<string, string> = {}
      for (const tag of node.tags) t[tag.name] = tag.value
      // Ruling 2026-09-13: target_system is a SIGNED claim or null. Anything
      // unsigned — which is every value written before this rule — renders
      // behind the `unverified:` prefix, here and on every other surface.
      // Re-verified from the signature at read time, never trusted from the
      // tags: the Irys query filters on tag names and does not constrain the
      // uploader, so tags alone prove nothing about who wrote them.
      const target_system = await renderTargetSystem(t)
      return {
        irys_id: node.id,
        irys_url: `https://gateway.irys.xyz/${node.id}`,
        timestamp: node.timestamp,
        verdict: t["verdict"] ?? "unknown",
        tier: t["tier"] ?? "unknown",
        target_system,
        target_system_verified: target_system !== null && !target_system.startsWith(UNVERIFIED_PREFIX),
        audit_id: t["audit-id"] ?? "unknown",
        // Populated once a Correction Record naming this certificate is anchored.
        corrections: correctionsFor(t["audit-id"], node.id)
      }
    }))

    // WAIT IS COUNTED. The previous summary counted only PASS and FAIL, so a
    // WAIT certificate vanished between the two: a 100-cert page reading
    // 51 PASS / 48 FAIL silently dropped one, and pass+fail != total_returned
    // was the only trace. Every verdict now has a counter and the residual is
    // named rather than implied.
    const countOf = (v: string) => certs.filter((c: any) => c.verdict === v).length
    const pass_count = countOf("PASS"), fail_count = countOf("FAIL"), wait_count = countOf("WAIT")
    const out = {
        total_returned: certs.length,
        pass_count, fail_count, wait_count,
        other_verdict_count: certs.length - pass_count - fail_count - wait_count,
        target_system_unverified_count: certs.filter((c: any) => !c.target_system_verified && c.target_system !== null).length,
        window: { from_ms: usedFromMs, to_ms: toMs, note: "certs outside this window need an explicit from_ms" },
        notes: {
          target_system: `A bare value is a claim signed by its subject address (${TARGET_SYSTEM_CLAIM_VERSION}). An "${UNVERIFIED_PREFIX}" prefix means the certificate carries the value with no verifying signature — it is the caller's assertion, not evidence, and names no verified relationship to whatever it names.`,
          corrections: "A non-empty corrections array lists Correction Records anchored against this certificate. The certificate itself is immutable and is never rewritten."
        },
        certificates: certs
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], structuredContent: out }
  }))

  server.registerTool("query_agent_trust", {
    title: "Query Agent Trust Score",
    description: `Query an agent's DJZS trust score, aggregated on-chain (Base mainnet) from its audit history and indexed via the DJZS subgraph. USE BEFORE delegating work, releasing escrow, or executing agent transactions. Returns scored_audits, pass/fail counts, the raw fail rate, and a Wilson 95% lower bound on it, plus latest verdict/risk and DJZS-S01/DJZS-X01 flag counts. WAIT verdicts are abstentions: they are excluded from BOTH the numerator and the denominator of the fail rate and are reported separately as wait_count. Below 10 scored audits the tool returns INSUFFICIENT_HISTORY and NO rate - a 0-of-0 record is not evidence of reliability and must not compare as better than a 3-of-50. This tool returns evidence, not a decision: it applies no threshold and emits no HALT. Interpreting the bound against your own risk tolerance is the caller's job.`,
    inputSchema: {
      agentAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").describe("Wallet address of the agent whose audit record you want, such as a counterparty you are about to delegate work to or pay")
    },
    outputSchema: AGENT_TRUST_OUTPUT,
    annotations: READ_ONLY_EXTERNAL,
  }, guardTool("query_agent_trust", async ({ agentAddress }) => {
    const jsonText = (o: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }], structuredContent: o })
    if (!env.SUBGRAPH_URL) {
      return { ...jsonText({ status: "unavailable", detail: "SUBGRAPH_URL not configured on this Worker; trust index not wired." }), isError: true }
    }
    const id = agentAddress.toLowerCase()
    // audits{verdict} is queried because the SUBGRAPH'S OWN COUNTERS CANNOT
    // EXPRESS A WAIT. djzs-subgraph/src/trust-score.ts handleScoreUpdated reads:
    //     let isPassing = event.params.verdict == "PASS";
    //     if (isPassing) { agent.passCount = ... } else { agent.failCount = ... }
    // an else-branch, so every non-PASS verdict — WAIT included — increments
    // failCount. A WAIT is an abstention, not a failure, and counting it as one
    // overstates the fail rate of any agent that ever got one. Recomputing from
    // the per-audit verdicts fixes this at the read layer, without a subgraph
    // redeploy and without rewriting already-indexed history.
    const query = `query($id: ID!) {
      agent(id: $id) {
        id totalAudits passCount failCount latestVerdict latestRiskScore
        audits(first: 1000) { verdict }
        flags(first: 1000) { code }
      }
    }`
    let agent: Record<string, unknown> | null
    try {
      const resp = await fetch(env.SUBGRAPH_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { id } })
      })
      if (!resp.ok) return { ...jsonText({ status: "error", detail: `subgraph_http_${resp.status}` }), isError: true }
      const j = await resp.json() as { data?: { agent: Record<string, unknown> | null }, errors?: unknown[] }
      if (j.errors?.length) return { ...jsonText({ status: "error", detail: "subgraph_graphql_error" satisfies Fault }), isError: true }
      agent = j.data?.agent ?? null
    } catch (e) {
      logFault("mcp.subgraph", e)
      return { ...jsonText({ status: "error", detail: "subgraph_unreachable" satisfies Fault }), isError: true }
    }

    if (!agent) {
      // No history is NOT a silent PASS: the caller has no basis to trust yet.
      return jsonText({ agent: id, status: "no_history", trust: "unknown", action: "NO_HISTORY",
        message: "No DJZS audit history for this agent; nothing to trust or distrust yet." })
    }

    const verdicts = Array.isArray(agent.audits)
      ? (agent.audits as Array<{ verdict: string }>).map((a) => String(a.verdict ?? "").toUpperCase())
      : []
    const totalAudits = Number(agent.totalAudits ?? 0)
    const passCount = verdicts.filter((v) => v === "PASS").length
    const failCount = verdicts.filter((v) => v === "FAIL").length
    const waitCount = verdicts.filter((v) => v === "WAIT").length
    // A WAIT is the engine declining to rule. It is evidence about the thesis,
    // not about the agent, so it enters neither side of the rate.
    const scoredAudits = passCount + failCount
    const codes = Array.isArray(agent.flags) ? (agent.flags as Array<{ code: string }>).map((f) => f.code) : []
    const s01 = codes.filter((c) => c === "DJZS-S01").length
    const x01 = codes.filter((c) => c === "DJZS-X01").length

    const base = {
      agent: id,
      total_audits: totalAudits,
      scored_audits: scoredAudits,
      pass_count: passCount,
      fail_count: failCount,
      wait_count: waitCount,
      latest_verdict: agent.latestVerdict ?? "unknown",
      latest_risk_score: Number(agent.latestRiskScore ?? 0),
      flag_counts: { "DJZS-S01": s01, "DJZS-X01": x01 },
      // Reported so a reader can see the discrepancy rather than discover it.
      subgraph_counters: {
        passCount: Number(agent.passCount ?? 0),
        failCount: Number(agent.failCount ?? 0),
        note: "On-chain index counters. Their failCount is an else-branch on verdict != PASS, so it absorbs WAIT verdicts. The counts above are recomputed from per-audit verdicts and are the ones to use.",
      },
    }

    // MINIMUM EVIDENCE. Below 10 scored audits no rate is returned at all, not
    // even a caveated one: a rate printed beside a caveat still gets compared,
    // and a fresh agent at 0-of-0 would sort ahead of a real one at 3-of-50.
    // Refusing the number is the only version of this that cannot be misread.
    if (scoredAudits < MIN_SCORED_AUDITS) {
      return jsonText({
        ...base,
        status: "INSUFFICIENT_HISTORY",
        fail_rate: null,
        fail_rate_lower_bound_95: null,
        detail: `${scoredAudits} scored audit(s); ${MIN_SCORED_AUDITS} required before a rate is reported. No rate is returned rather than an unreliable one.`,
      })
    }

    const failRate = failCount / scoredAudits
    return jsonText({
      ...base,
      status: "OK",
      fail_rate: Number(failRate.toFixed(4)),
      // Lower bound on the TRUE fail rate at 95%. Small samples pull it toward
      // zero, which is why it is reported next to the raw rate rather than
      // instead of it.
      fail_rate_lower_bound_95: Number(wilsonLowerBound(failCount, scoredAudits).toFixed(4)),
      interpretation:
        "No threshold is applied here and no action is returned. As a starting point a lower bound above 0.3, or DJZS-S01/DJZS-X01 firing more than once, is worth refusing on - but that is a recommendation for the caller to weigh against their own exposure, not a rule this tool enforces.",
    })
  }))

  // The free check for a client with no wallet (2026-11-24): the same pipeline as POST /try/verdict, in-process,
  // on a shared daily row. Not attested, not anchored, not charged. free-check-tool.ts says why and how.
  server.registerTool("check_thesis", {
    title: "Check a Trade Thesis for Free",
    description: CHECK_THESIS_DESCRIPTION,
    inputSchema: {
      kind: z.enum(CHECK_THESIS_KINDS).describe("prediction_market for a bet on a Kalshi or Polymarket style market; perp_or_spot for a perpetual or spot trade."),
      thesis: z.string().min(CHECK_THESIS_MIN).max(CHECK_THESIS_MAX).describe("The thesis in the user's own words: the venue and market or instrument, the side, the size or price, the reason, the source of any odds or data, and what would prove it wrong. Do not rewrite or improve it; the check reads what the user actually wrote."),
    },
    outputSchema: CHECK_THESIS_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guardTool("check_thesis", async ({ kind, thesis }) => runCheckThesis({ kind, thesis }, env)))

  // The other half of the pay link (2026-11-24, pay-link.ts): read the outcome of an audit paid in the browser.
  // Free and read-only; it never runs an audit or moves money.
  server.registerTool("get_paid_audit", {
    title: "Collect a Paid Audit",
    description: GET_PAID_AUDIT_DESCRIPTION,
    inputSchema: {
      pay_session: z.string().regex(PAY_SESSION_RE, "a pay_session is ps_ followed by 22 characters")
        .describe("The pay_session from the pay link that verify_pm_trade or verify_perp_trade returned (ps_ followed by 22 characters)"),
    },
    outputSchema: PAID_AUDIT_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guardTool("get_paid_audit", async ({ pay_session }) => {
    const o = await readPaidAudit(env.TELEMETRY, pay_session, new Date())
    const isError = o.status === "NOT_FOUND" || o.status === "UNAVAILABLE"
    return { content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }], structuredContent: o, ...(isError ? { isError: true as const } : {}) }
  }))

  // Step 2 (Path B ruling 2026-07-12): the ONLY paid tool. The handler body is
  // the Step 1 handler byte-identical; withX402 owns the 402/verify/settle
  // cycle in-band, and the free registry tools above are untouched.
  // S6a: `paidTool` builds its tool config as {description, inputSchema,
  // annotations, _meta} and passes NO top-level `title` (agents 0.17.3,
  // dist/mcp/x402.js:36-43), which is why verify_pm_trade was the only tool
  // without one while both free tools have it. It DOES return the RegisteredTool,
  // so the title is set through the SDK's documented `update()` rather than by
  // reaching into server internals. annotations.title is left untouched for
  // clients that read the older field.
  const verifyPmTradeTool = server.paidTool(
    "verify_pm_trade",
    // ASCII ONLY in this description: it travels inside the x402 payment
    // resource, and the agents client wrapper base64-encodes the payment
    // payload with bare btoa, which throws "Invalid character" on any code
    // point above 0xFF (rehearsal finding 2026-07-12; U+2192 arrows crashed
    // every agents-based payer). Upstream bug candidate; ruled: paid-tool
    // descriptions stay ASCII.
    `Deterministic pre-execution audit of a prediction-market trade thesis, run before capital is committed. USE THIS TOOL before opening, sizing, or increasing any prediction-market position, and whenever a user or an upstream agent asks whether a thesis is sound, carries a falsification condition, or has a sourced probability basis. Audits against the calibrated DJZS-M taxonomy (M01 narrative/resolution gap, M02 falsification absent, M03 probability unsourced, M04 consensus-as-edge advisory) and returns PASS->PROCEED, WAIT->HALT, or FAIL with the flagged defects and a reproducible verdict_hash. DO NOT use to retrieve past verdicts or certificates - use query_pol_certificates for those. DO NOT use for an agent's historical trust score - use query_agent_trust for that. DO NOT use for spot, perpetuals, or equities: out-of-scope submissions are refused WITHOUT CHARGE. Audit before act. Paid tool: ${VERIFY_PM_TRADE_PRICE_USD} USDC per audit via x402 on Base.`,
    VERIFY_PM_TRADE_PRICE_USD,
    {
      ...VERIFY_PM_TRADE_INPUT,
      // D4 ruling 2026-07-12: optional; feeds ONLY the Target-System tag on the
      // anchored certificate. Extraction input and hash preimage untouched.
      // AMENDED 2026-09-13: a value alone is no longer enough. It is written to
      // the certificate only alongside a signature by the subject address over
      // canonicalTargetSystemMessage(value, subject); otherwise the field is
      // omitted entirely. A free-text box on a permanent record is how a
      // certificate came to name a company with no involvement in the audit.
      target_system: z.string().min(1).max(128).optional()
        .describe("Agent or project name to record on the anchored certificate. It is stored ONLY when target_system_subject and target_system_signature are also sent and the signature verifies; otherwise it is DISCARDED, not stored"),
      target_system_subject: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()
        .describe("Wallet address that signed the target_system claim; the server checks that target_system_signature recovers to it"),
      target_system_signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional()
        .describe(`Signature by target_system_subject proving the claim: EIP-191 personal_sign over the text "${TARGET_SYSTEM_CLAIM_VERSION} target-system claim\\nsubject: <lowercased subject>\\ntarget_system: <value>"`),
      // D1 ruling 2026-07-16: optional 0x agent wallet. Present => this audit's
      // verdict is written on-chain to that agent's DJZS trust score (fail-open,
      // after the cert anchors). Absent => Irys cert only, no on-chain score.
      // Never touches the verdict_hash preimage.
      agent_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").optional()
        .describe("Optional agent wallet (0x). If set, this audit updates that agent's on-chain DJZS trust score")
    },
    { title: "Verify Prediction-Market Trade", ...PAID_AUDIT_HINTS },
    guardTool("verify_pm_trade", async ({ intent, target_system, target_system_subject, target_system_signature, agent_address }) => {
    if (!env.ANTHROPIC_API_KEY) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          tool: "verify_pm_trade",
          error: "ANTHROPIC_API_KEY secret not configured on this Worker — extraction cannot run."
        }, null, 2) }],
        isError: true
      }
    }
    const modelFn = buildAnthropicModelFn(env.ANTHROPIC_API_KEY)
    // DJZS-SRC-v0.2: started beside extraction; attached to the response only. Not scored.
    const sourcesP: Promise<SourcesBlock> = startSourceCheck(env, intent)
    const result = await runVerifyPmTrade(intent, modelFn)

    // OUT-OF-SCOPE = NOT CHARGED. The agents/x402 middleware settles payment
    // only when the tool result carries no isError flag (settlePayment guard
    // in agents dist/mcp/x402.js). Surfacing in_scope:false as an error makes
    // the middleware skip settlement, so a refused audit is a free refusal.
    // The reason string still travels in content.
    if (result.in_scope === false) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: true
      }
    }

    // Step 1 PoL anchor: strictly AFTER the audit result exists; nothing here
    // can reach the verdict_hash preimage. FAIL OPEN: an anchoring failure
    // annotates the response and never blocks or mutates the verdict.
    let pol_certificate: Record<string, unknown> | undefined
    if (result.in_scope === true) {
      if (!env.IRYS_UPLOAD_KEY) {
        pol_certificate = {
          status: "disabled",
          detail: "IRYS_UPLOAD_KEY secret not configured; result not anchored."
        }
      } else {
        const nodeUrl = env.IRYS_NODE_URL ?? DEFAULT_IRYS_NODE_URL
        try {
          const anchored = await anchorPolCertificate(
            {
              result,
              intent,
              targetSystemClaim: await verifyTargetSystemClaim({
                value: target_system, subject: target_system_subject, signature: target_system_signature,
              }),
              auditId: crypto.randomUUID(),
              issuedAtMs: Date.now()
            },
            env.IRYS_UPLOAD_KEY,
            buildIrysUploadFn(nodeUrl)
          )
          pol_certificate = { status: "anchored", node: nodeUrl, ...anchored }
        } catch (e) {
          logFault("mcp.anchor", e)
          pol_certificate = { status: "error", detail: "anchor_failed" satisfies Fault }
        }
      }
    }

    // Phase 3 on-chain trust score (D1-D3): strictly AFTER the verdict and the
    // Irys anchor. FAIL-OPEN and downstream of verdict_hash — nothing here feeds
    // the hash preimage. Written only when in_scope, an agent_address was given,
    // and a certificate actually anchored (so the on-chain record links to a
    // real cert via irysTxId). Any failure annotates; it never blocks the audit.
    let trust_score: Record<string, unknown> | undefined
    if (result.in_scope === true && agent_address) {
      const anchoredId =
        pol_certificate && pol_certificate.status === "anchored" ? String(pol_certificate.irys_id) : undefined
      if (!anchoredId) {
        trust_score = { status: "skipped", reason: "no anchored certificate to link the on-chain score to" }
      } else {
        const writeScore = buildTrustWriter(env.DJZS_WRITER_KEY, env.BASE_RPC_URL)
        const flagCodes = Array.isArray(result.flags)
          ? (result.flags as Array<Record<string, unknown>>).map((f) => String(f.code ?? f))
          : []
        trust_score = await writeScore({
          agentAddress: agent_address,
          riskScore: Number(result.risk_score ?? 0),
          verdict: String(result.verdict ?? ""),
          flags: flagCodes,
          irysTxId: anchoredId,
        })
      }
    }

    let response: Record<string, unknown> = result
    if (pol_certificate) response = { ...response, pol_certificate }
    if (trust_score) response = { ...response, trust_score }
    response = { ...response, sources: await sourcesP }
    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }], structuredContent: response }
    })
  )

  // S6a — top-level title, alongside the annotations.title kept above.
  hardenPaidTool(verifyPmTradeTool)
  offerPayLink(verifyPmTradeTool, "verify_pm_trade", env)
  verifyPmTradeTool.update({
    title: "Verify Prediction-Market Trade",
  })
  // paidTool takes no outputSchema; set it on the RegisteredTool (update() would rebuild it from a raw
  // shape, which drops the loose-object setting). Validated only on non-error results.
  verifyPmTradeTool.outputSchema = TRADE_AUDIT_OUTPUT

  // verify_perp_trade — Phase 1 (2026-09-08). Cloned from the verify_pm_trade block above at fill time; same payment rail, same PoL/trust pipeline, perp extraction prompt + perp engine path.
  const verifyPerpTradeTool = server.paidTool(
    "verify_perp_trade",
    // ASCII ONLY in this description: it travels inside the x402 payment
    // resource, and the agents client wrapper base64-encodes the payment
    // payload with bare btoa, which throws "Invalid character" on any code
    // point above 0xFF (rehearsal finding 2026-07-12; U+2192 arrows crashed
    // every agents-based payer). Upstream bug candidate; ruled: paid-tool
    // descriptions stay ASCII.
    `Deterministic pre-execution audit of a perpetual or spot TRADE thesis (direction, size, leverage, entry, stop, target, venue, and the REASON), run before capital is committed. USE THIS TOOL before opening, sizing, or increasing any perpetual or spot position. Returns PASS / WAIT / FAIL with a reproducible verdict hash. A position stated with no thesis FAILS (DJZS-S01); an unbounded position FAILS (DJZS-X01); an unresolvable stop or thesis WAITs. Prediction-market bets are refused here (use verify_pm_trade) and are not charged. Price 2.00 USDC per audit on Base.`,
    VERIFY_PERP_TRADE_PRICE_USD,
    {
      ...VERIFY_PERP_TRADE_INPUT,
      // D4 ruling 2026-07-12: optional; feeds ONLY the Target-System tag on the
      // anchored certificate. Extraction input and hash preimage untouched.
      // AMENDED 2026-09-13: a value alone is no longer enough. It is written to
      // the certificate only alongside a signature by the subject address over
      // canonicalTargetSystemMessage(value, subject); otherwise the field is
      // omitted entirely. A free-text box on a permanent record is how a
      // certificate came to name a company with no involvement in the audit.
      target_system: z.string().min(1).max(128).optional()
        .describe("Agent or project name to record on the anchored certificate. It is stored ONLY when target_system_subject and target_system_signature are also sent and the signature verifies; otherwise it is DISCARDED, not stored"),
      target_system_subject: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()
        .describe("Wallet address that signed the target_system claim; the server checks that target_system_signature recovers to it"),
      target_system_signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional()
        .describe(`Signature by target_system_subject proving the claim: EIP-191 personal_sign over the text "${TARGET_SYSTEM_CLAIM_VERSION} target-system claim\\nsubject: <lowercased subject>\\ntarget_system: <value>"`),
      // D1 ruling 2026-07-16: optional 0x agent wallet. Present => this audit's
      // verdict is written on-chain to that agent's DJZS trust score (fail-open,
      // after the cert anchors). Absent => Irys cert only, no on-chain score.
      // Never touches the verdict_hash preimage.
      agent_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").optional()
        .describe("Optional agent wallet (0x). If set, this audit updates that agent's on-chain DJZS trust score")
    },
    { title: "Verify Perpetual or Spot Trade", ...PAID_AUDIT_HINTS },
    guardTool("verify_perp_trade", async ({ intent, bracket, target_system, target_system_subject, target_system_signature, agent_address }) => {
    if (!env.ANTHROPIC_API_KEY) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          tool: "verify_perp_trade",
          error: "ANTHROPIC_API_KEY secret not configured on this Worker — extraction cannot run."
        }, null, 2) }],
        isError: true
      }
    }
    const modelFn = buildAnthropicModelFn(env.ANTHROPIC_API_KEY)
    // bracket feeds only the non-scoring mechanics block (break-even hit rate); never the verdict or its hash.
    // DJZS-SRC-v0.2: started beside extraction; attached to the response only. Not scored.
    const sourcesP: Promise<SourcesBlock> = startSourceCheck(env, intent)
    const result = await runVerifyPerpTrade(intent, modelFn, bracket)

    // OUT-OF-SCOPE = NOT CHARGED. The agents/x402 middleware settles payment
    // only when the tool result carries no isError flag (settlePayment guard
    // in agents dist/mcp/x402.js). Surfacing in_scope:false as an error makes
    // the middleware skip settlement, so a refused audit is a free refusal.
    // The reason string still travels in content.
    if (result.in_scope === false) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: true
      }
    }

    // Step 1 PoL anchor: strictly AFTER the audit result exists; nothing here
    // can reach the verdict_hash preimage. FAIL OPEN: an anchoring failure
    // annotates the response and never blocks or mutates the verdict.
    let pol_certificate: Record<string, unknown> | undefined
    if (result.in_scope === true) {
      if (!env.IRYS_UPLOAD_KEY) {
        pol_certificate = {
          status: "disabled",
          detail: "IRYS_UPLOAD_KEY secret not configured; result not anchored."
        }
      } else {
        const nodeUrl = env.IRYS_NODE_URL ?? DEFAULT_IRYS_NODE_URL
        try {
          const anchored = await anchorPolCertificate(
            {
              result,
              intent,
              targetSystemClaim: await verifyTargetSystemClaim({
                value: target_system, subject: target_system_subject, signature: target_system_signature,
              }),
              auditId: crypto.randomUUID(),
              issuedAtMs: Date.now()
            },
            env.IRYS_UPLOAD_KEY,
            buildIrysUploadFn(nodeUrl)
          )
          pol_certificate = { status: "anchored", node: nodeUrl, ...anchored }
        } catch (e) {
          logFault("mcp.anchor", e)
          pol_certificate = { status: "error", detail: "anchor_failed" satisfies Fault }
        }
      }
    }

    // Phase 3 on-chain trust score (D1-D3): strictly AFTER the verdict and the
    // Irys anchor. FAIL-OPEN and downstream of verdict_hash — nothing here feeds
    // the hash preimage. Written only when in_scope, an agent_address was given,
    // and a certificate actually anchored (so the on-chain record links to a
    // real cert via irysTxId). Any failure annotates; it never blocks the audit.
    let trust_score: Record<string, unknown> | undefined
    if (result.in_scope === true && agent_address) {
      const anchoredId =
        pol_certificate && pol_certificate.status === "anchored" ? String(pol_certificate.irys_id) : undefined
      if (!anchoredId) {
        trust_score = { status: "skipped", reason: "no anchored certificate to link the on-chain score to" }
      } else {
        const writeScore = buildTrustWriter(env.DJZS_WRITER_KEY, env.BASE_RPC_URL)
        const flagCodes = Array.isArray(result.flags)
          ? (result.flags as Array<Record<string, unknown>>).map((f) => String(f.code ?? f))
          : []
        trust_score = await writeScore({
          agentAddress: agent_address,
          riskScore: Number(result.risk_score ?? 0),
          verdict: String(result.verdict ?? ""),
          flags: flagCodes,
          irysTxId: anchoredId,
        })
      }
    }

    let response: Record<string, unknown> = result
    if (pol_certificate) response = { ...response, pol_certificate }
    if (trust_score) response = { ...response, trust_score }
    response = { ...response, sources: await sourcesP }
    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }], structuredContent: response }
    })
  )

  // S6a — top-level title, alongside the annotations.title kept above.
  hardenPaidTool(verifyPerpTradeTool)
  offerPayLink(verifyPerpTradeTool, "verify_perp_trade", env)
  verifyPerpTradeTool.update({
    title: "Verify Perpetual or Spot Trade",
  })
  verifyPerpTradeTool.outputSchema = TRADE_AUDIT_OUTPUT

  return server
}

/**
 * Exported ALONGSIDE the default export, not instead of it: the default stays
 * {fetch, scheduled} exactly as the runtime needs. The named export exists so
 * test/correction-anchor.test.mjs can drive routes through `app.request()`
 * offline, with a stubbed env and no network — a route that can only be
 * exercised by deploying is a route nobody tests before deploying.
 */
export const app = new Hono<{ Bindings: Env }>()

// Hono's default handler console.errors the raw error object (a thrown key-material message would reach the log
// unscrubbed). Same answer as the default, logged through logFault.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  logFault("route.unhandled", err)
  return c.text("Internal Server Error", 500)
})

/** The six paths the enrichment recorder observes. Nothing else is recorded. */
const ENRICHMENT_PATHS = new Set([
  "/",
  "/index.html",
  "/llms.txt",
  "/.well-known/x402.json",
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
])

/**
 * Record one surface_fetch row. Fire-and-forget, off the response path, and
 * incapable of affecting the response.
 *
 * Three layers of guard, because telemetry must never be able to break a surface:
 *   1. c.executionCtx ACCESS itself is wrapped — Hono throws when there is no
 *      execution context (it is not merely undefined), so reading it outside a
 *      Worker request would throw synchronously inside the middleware.
 *   2. The enqueue is wrapped, so a waitUntil that rejects synchronously cannot
 *      escape into the handler.
 *   3. The D1 promise carries its own .catch, so a failed INSERT settles quietly
 *      instead of surfacing as an unhandled rejection in the isolate.
 * Nothing here is awaited: the response is already decided before this is called.
 *
 * EVERY caller is recorded — browser, crawler, monitor, script. Whether a row is
 * "non-browser" is decided at QUERY time, by eyeballing the distinct User-Agent /
 * Accept distribution (DEPLOY_RUNBOOK Step 10). Discarding at the edge would throw
 * away the exact evidence the E3 branches are keyed on, and the classification is
 * a heuristic that must stay auditable and revisable after the fact.
 *
 * No IP address is captured — see the PRIVACY note in schema/gate-telemetry.sql.
 */
function recordSurfaceFetch(c: Context<{ Bindings: Env }>, path: string, branch: string): void {
  let ctx: ExecutionContext | undefined
  try {
    ctx = c.executionCtx
  } catch {
    return // no execution context (tests, non-Worker host): nothing to defer onto
  }
  if (!ctx || typeof ctx.waitUntil !== "function") return

  const db = c.env?.TELEMETRY
  if (!db) return // binding absent => telemetry is simply off

  try {
    const req = c.req.raw
    const cf = (req as unknown as { cf?: Record<string, unknown> }).cf
    const asn = cf?.asn
    ctx.waitUntil(
      db
        .prepare(
          "INSERT INTO surface_fetch (ts, path, branch, method, user_agent, accept, cf_country, cf_asn, ray) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          new Date().toISOString(),
          path,
          branch,
          req.method,
          req.headers.get("user-agent"),
          req.headers.get("accept"),
          typeof cf?.country === "string" ? cf.country : null,
          asn === undefined || asn === null ? null : String(asn),
          req.headers.get("cf-ray"),
        )
        .run()
        .catch(() => {}),
    )
  } catch {
    // Telemetry is never load-bearing. Swallow and serve.
  }
}

/**
 * Agent-facing discovery surfaces — MOUNTED FIRST, before every other route.
 *
 * Hono dispatches in registration order, so "first" here is positional, not
 * decorative: this must stay above app.all("/mcp") or a later-registered route
 * would win the match for any path they share.
 *
 * WHAT IT OWNS. handleDiscoverySurfaces answers, and returns null for everything
 * else — a null falls through to next() untouched, so no existing route can be
 * shadowed:
 *   /llms.txt, /.well-known/x402.json, /.well-known/agent-card.json
 *     (plus the /.well-known/agent.json alias)  -> always answered here
 *   /index.html                                 -> always answered here (the OG
 *     landing; the path is unclaimed, and it is itself an explicit html request)
 *   "/"                                         -> CONTENT-NEGOTIATED. The landing
 *     is returned ONLY when the caller's Accept matches text/html. Otherwise null,
 *     and app.get("/") below answers with the operational status JSON exactly as
 *     it always has. A bare wildcard Accept and an absent Accept both fall
 *     through to JSON.
 *     The negotiated html carries Vary: Accept.
 *
 * Read-only: non-GET/HEAD methods return null, so POST /x402/verify_pm_trade and
 * app.all("/mcp") are unreachable from here regardless of path.
 *
 * IT ALSO RECORDS. For the six enrichment paths only, one surface_fetch row is
 * written per request via waitUntil — after the branch is known, never awaited,
 * and unable to alter or delay the response. At "/" the branch distinguishes which
 * side answered ('landing' vs 'status'); the other five record as 'surface'. This
 * is the instrument the E3 pre-commitment in EVIDENCE.log is keyed on: without it
 * branches A, B and C cannot be told apart.
 */
app.use("*", async (c, next) => {
  const d = handleDiscoverySurfaces(c.req.raw)

  const path = new URL(c.req.url).pathname
  if (ENRICHMENT_PATHS.has(path)) {
    recordSurfaceFetch(c, path, path === "/" ? (d ? "landing" : "status") : "surface")
  }

  if (d) return d
  return next()
})
// Per-request MCP server so verify_pm_trade's handler can read the ANTHROPIC_API_KEY
// secret from c.env. Streamable-HTTP transport via @hono/mcp (the stable, documented
// MCP-over-Hono adapter): build server → connect transport → handleRequest(c).
// The registry tools are unchanged; the health route is unchanged.
app.all("/mcp", async (c) => {
  const transport = new StreamableHTTPTransport()
  await buildServer(c.env).connect(transport)
  return (await transport.handleRequest(c)) ?? c.text("Bad Request", 400)
})
app.get("/", (c) => c.json({ name: "djzs-trust-mcp", version: "1.0.0", status: "operational" }))

/**
 * The pay page (pay-link.ts). GET shows the exact thesis and price from the stored session; POST takes the
 * browser's signed x402 payment and makes the paid MCP call in-process. Same-origin page, so no CORS. The work is
 * also handed to waitUntil so a closed tab does not cut a payment off between the audit and the settlement.
 */
const PAY_EXPECT = {
  network: normalizeNetwork(X402_NETWORK),
  chainId: 8453,
  amount: EXPECTED_ATOMIC_AMOUNT,
  asset: USDC_BASE,
  payTo: X402_RECIPIENT,
}
app.get("/pay/:id", (c) => handlePayPage(c.env.TELEMETRY, c.req.param("id"), new Date(), PAY_EXPECT))
app.post("/pay/:id", async (c) => {
  const env = c.env
  const work = handlePayPost(c.req.raw, env.TELEMETRY, c.req.param("id"), {
    preflight: (tool, payment) => preflightPayLink(env, tool, payment),
    callPaidTool: (tool, args, payment) => callPaidToolInProcess(env, tool, args, payment),
  }, () => new Date())
  try { c.executionCtx.waitUntil(work.then(() => {}, () => {})) } catch { /* no execution context outside a Worker */ }
  return work
})

/**
 * Deploy-gate boot assertion (A10 / spec A9 deploy doctrine). The outage of
 * 2026-07-13 was a resource server asking a facilitator for a network it did
 * not settle; this route is the ONE probe that would have caught it. It builds
 * the same CDP facilitator config the paid tool uses, calls getSupported() (which
 * signs a real CDP JWT — so a 200 here also proves the auth path works end to
 * end), and reports whether the configured network is actually advertised.
 * Reads nothing but env; moves no money. Probe it immediately after every deploy.
 */
app.get("/health/x402", async (c) => {
  const env = c.env
  const caip2 = normalizeNetwork(X402_NETWORK)
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: false,
      network_supported: false,
      detail: "CDP_API_KEY_ID/SECRET not set; paid tool cannot settle."
    }, 503)
  }
  try {
    const client = new HTTPFacilitatorClient(
      createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
    )
    const supported = await client.getSupported()
    // Attester health (v2 receipts). Zero ETH here silently decouples receipt from attestation.
    const attester = await (async () => {
      if (!env.DJZS_ATTESTER_KEY) return { configured: false }
      try {
        const b = await attesterBalance({ DJZS_ATTESTER_KEY: env.DJZS_ATTESTER_KEY, BASE_RPC_URL: env.BASE_RPC_URL })
        return { configured: true, address: b.address, eth: b.eth, low: b.low }
      } catch (e) {
        logFault("health.attester", e)
        return { configured: true, error: "attester_balance_unavailable" satisfies Fault }
      }
    })()
    const kinds = (supported?.kinds ?? []) as Array<{ network?: string }>
    const networkSupported = kinds.some((k) => k.network === caip2)
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: true,
      network_supported: networkSupported,
      advertised_networks: [...new Set(kinds.map((k) => k.network).filter(Boolean))],
      attester
    }, networkSupported ? 200 : 502)
  } catch (e) {
    logFault("health.x402", e)
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: true,
      network_supported: false,
      detail: "facilitator_unavailable" satisfies Fault
    }, 502)
  }
})

/**
 * Q3 daily anchor (2026-09-02). Authenticated. Accepts the day's record hashes, computes
 * the Merkle root, signs with IRYS_UPLOAD_KEY (the same funded key PoL certificates use)
 * and uploads to Irys. Nothing is metered; nothing touches the audit path. One call per day.
 * Auth: header X-DJZS-Anchor-Key must equal the DJZS_Q3_ANCHOR_KEY secret (constant-time).
 */
app.post("/q3/anchor", async (c) => {
  const env = c.env
  if (!env.DJZS_Q3_ANCHOR_KEY || !env.IRYS_UPLOAD_KEY) return c.json({ error: "q3 anchoring not configured" }, 503)
  if (!keyMatches(c.req.header("X-DJZS-Anchor-Key"), env.DJZS_Q3_ANCHOR_KEY)) return c.json({ error: "unauthorized" }, 401)
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: "invalid JSON" }, 400) }
  const v = validateQ3AnchorRequest(body)
  if (!v.ok) return c.json({ error: v.error }, 400)
  try {
    const out = await anchorQ3(v.req, env.IRYS_UPLOAD_KEY, env.IRYS_NODE_URL ?? DEFAULT_IRYS_NODE_URL)
    return c.json({ status: "anchored", date: v.req.date, protocol_version: v.req.protocol_version, ...out })
  } catch (e) {
    logFault("q3.anchor", e)
    return c.json({ status: "error", detail: "anchor_failed" satisfies Fault }, 502)
  }
})

/**
 * Writer-key diagnostic (2026-08-04). Answers, in ONE free GET, the question the
 * skip reason used to blur: is DJZS_WRITER_KEY absent, malformed, or fine — and
 * if fine, is its derived address actually authorized on the contract?
 *
 * Deliberately NOT routed through verify_pm_trade: the writer is constructed only
 * inside `in_scope === true && agent_address`, so an out-of-scope call returns
 * before construction and would log nothing. This route needs no MCP call, no
 * payment negotiation, and no key material to leave the Worker.
 *
 * Reads env + one eth_call. Moves no money, signs nothing, echoes no secret.
 */
// Public error hygiene: /health/writer must never echo raw transport errors.
// Every outcome is a FIXED string, unknowns included. Raw messages can carry the RPC URL
// (which embeds the API key) or pasted terminal content - both have happened - and the
// scrub-and-truncate this replaced still let a provider hostname through (ruled 2026-10-20).
const classifyRpcError = (s: unknown): string => {
  const t = String(s ?? "")
  if (!t) return "ok"
  if (/rate limit|429/i.test(t)) return "rpc error: over rate limit"
  if (/invalid url/i.test(t)) return "config error: BASE_RPC_URL malformed"
  if (/timeout|timed out/i.test(t)) return "rpc error: timeout"
  if (/401|403|unauthorized|authenticated/i.test(t)) return "rpc error: auth rejected by provider"
  if (/nonce/i.test(t)) return "rpc error: nonce conflict"
  if (/no result/i.test(t)) return "rpc error: no result"
  return "rpc error: unclassified"
}

/**
 * POST /corrections/anchor — anchor a Correction Record, Worker-side.
 *
 * The handler lives in correction-route.ts so it can be driven offline by
 * test/correction-anchor.test.mjs; index.ts cannot be imported from Node (a
 * pre-existing module-scope TDZ in http-x402-bazaar.v2.ts that esbuild reorders
 * away in the shipped bundle). Registration stays here, one line, and the test
 * asserts this line exists rather than assuming it.
 *
 * KEY CUSTODY: IRYS_UPLOAD_KEY is a Worker secret and never leaves the Worker.
 * The operator proves intent with DJZS_Q3_ANCHOR_KEY, the same header and
 * constant-time compare as /q3/anchor. Distinct from /q3/anchor on purpose:
 * that route commits a merkle root of hashes and publishes no document, so a
 * correction anchored through it would be less retrievable than the certificate
 * it corrects.
 */
app.post(CORRECTION_ANCHOR_PATH, makeCorrectionAnchorHandler(DEFAULT_IRYS_NODE_URL))

app.get("/health/writer", async (c) => {
  const diag = describeWriterKey(c.env.DJZS_WRITER_KEY)
  const base = { contract: DJZS_TRUST_CONTRACT, expected_writer_prefix: "0x41c2304b", key_state: diag.state }

  if (diag.state === "absent") {
    return c.json({ ...base, detail: diag.detail, remedy: "secret never deployed; re-deploy it from settings" }, 503)
  }
  if (diag.state === "malformed") {
    return c.json({
      ...base, detail: diag.detail,
      hex_length: diag.hex_length, has_0x_prefix: diag.has_0x_prefix,
      remedy: "stored value is damaged; re-enter it (expect 64 hex chars, no whitespace)"
    }, 503)
  }

  const auth = await checkWriterAuthorization(diag.address, c.env.BASE_RPC_URL)
  return c.json({
    ...base,
    derived_writer_address: diag.address,
    hex_length: diag.hex_length,
    has_0x_prefix: diag.has_0x_prefix,
    authorized_on_contract: auth.authorized,
    authorization_detail: classifyRpcError(auth.detail),
    matches_expected_prefix: diag.address.toLowerCase().startsWith(base.expected_writer_prefix.toLowerCase())
  }, auth.authorized === true ? 200 : 502)
})

/* ────────────────────────────────────────────────────────────────────────────
 * HTTP x402 transport (2026-08-09). Makes the SAME gate payable by HTTP x402
 * clients (Base MCP, MetaMask Agent Wallet, x402-axios) alongside /mcp.
 *
 * WHY THE LOW-LEVEL x402ResourceServer AND NOT x402HTTPResourceServer:
 * agents/x402 exposes no HTTP wrapper (its exports are normalizeNetwork,
 * withX402, withX402Client only). Of the two remaining options,
 * x402HTTPResourceServer.processHTTPRequest/processSettlement does support a
 * verify-then-settle split, but it wraps route matching and paywall concerns we
 * do not need. The low-level buildPaymentRequirements -> findMatchingRequirements
 * -> verifyPayment -> [handler] -> settlePayment sequence is EXACTLY what
 * agents/dist/mcp/x402.js:44-137 already does, so this route and /mcp share one
 * settlement discipline rather than two implementations that can drift apart.
 *
 * FREE REFUSAL IS THE LOAD-BEARING PROPERTY (regression guard):
 * settlePayment runs only after the audit returns AND only when
 * result.in_scope === true. An out-of-scope intent is answered 402 and NEVER
 * settled. This mirrors the MCP path's isError guard, which is what makes a
 * refused audit free. Any charge-on-access middleware that settles before the
 * handler would reintroduce the prior incident and must not be used here.
 *
 * Constants are shared with /mcp verbatim: X402_RECIPIENT, the 2.00 USDC price,
 * and createFacilitatorConfig(CDP keys). Only the NETWORK may be overridden, via
 * the X402_HTTP_NETWORK var, so the route can be exercised on Base Sepolia.
 * ──────────────────────────────────────────────────────────────────────────── */

const X402_HTTP_RESOURCE = "https://mcp.djzs.ai/x402/verify"

/**
 * PoL anchor + on-chain trust write, identical in behaviour to the block inside
 * the verify_pm_trade MCP handler. Duplicated rather than extracted because the
 * /mcp route is explicitly not to be modified in this change; the two copies
 * should be collapsed into one helper in a follow-up (see the note in the diff
 * summary) — divergence here is the same failure mode that produced the
 * PASS/PROCEED vocabulary bug.
 */
async function anchorAndScore(
  env: Env,
  result: Record<string, unknown>,
  intent: string,
  /**
   * Target-System claim as supplied by the caller. Verified HERE, not at the
   * call site: an unverified claim reaching this helper is the only way an
   * unsigned value can land on a permanent certificate, so the check lives
   * where the write happens rather than somewhere a future caller can skip.
   */
  target_system_claim: { value?: string; subject?: string; signature?: string } | undefined,
  agent_address: string | undefined,
  /** Settlement payer, where the transport knows it. The claim must recover to this address. */
  payer?: string,
): Promise<{ pol_certificate?: Record<string, unknown>; trust_score?: Record<string, unknown> }> {
  // INTRINSIC SCOPE PRECONDITION (ruling 2026-08-10). The /mcp copy guards each
  // block inline with `result.in_scope === true`; hoisting that guard to the call
  // site would have left this helper looking general-purpose while carrying an
  // implicit precondition — a future caller could anchor a permanent certificate
  // for an audit that was never in scope. Enforced here, not assumed from
  // ordering. Full consolidation with /mcp is deliberately deferred to its own
  // isolated change after the mainnet push.
  if (result.in_scope !== true) return {}

  let pol_certificate: Record<string, unknown> | undefined
  if (!env.IRYS_UPLOAD_KEY) {
    pol_certificate = { status: "disabled", detail: "IRYS_UPLOAD_KEY secret not configured; result not anchored." }
  } else {
    const nodeUrl = env.IRYS_NODE_URL ?? DEFAULT_IRYS_NODE_URL
    try {
      const anchored = await anchorPolCertificate(
        {
          result,
          intent,
          targetSystemClaim: await verifyTargetSystemClaim(target_system_claim, payer),
          auditId: crypto.randomUUID(),
          issuedAtMs: Date.now(),
        },
        env.IRYS_UPLOAD_KEY,
        buildIrysUploadFn(nodeUrl),
      )
      pol_certificate = { status: "anchored", node: nodeUrl, ...anchored }
    } catch (e) {
      logFault("x402.anchor", e)
      pol_certificate = { status: "error", detail: "anchor_failed" satisfies Fault }
    }
  }

  let trust_score: Record<string, unknown> | undefined
  if (agent_address) {
    const anchoredId =
      pol_certificate && pol_certificate.status === "anchored" ? String(pol_certificate.irys_id) : undefined
    if (!anchoredId) {
      trust_score = { status: "skipped", reason: "no anchored certificate to link the on-chain score to" }
    } else {
      // This runs AFTER settlement. buildTrustWriter derives an account from DJZS_WRITER_KEY and throws for a
      // scalar outside the curve order, so a bad secret must degrade the receipt, never lose a paid verdict.
      try {
        const writeScore = buildTrustWriter(env.DJZS_WRITER_KEY, env.BASE_RPC_URL)
        const flagCodes = Array.isArray(result.flags)
          ? (result.flags as Array<Record<string, unknown>>).map((f) => String(f.code ?? f))
          : []
        trust_score = await writeScore({
          agentAddress: agent_address,
          riskScore: Number(result.risk_score ?? 0),
          verdict: String(result.verdict ?? ""),
          flags: flagCodes,
          irysTxId: anchoredId,
        })
      } catch (e) {
        logFault("x402.trust_write", e)
        trust_score = { status: "error", error_class: "unknown", detail: "trust_write_failed" satisfies Fault }
      }
    }
  }
  return { pol_certificate, trust_score }
}

/**
 * Machine-readable discovery contract (OpenAPI 3.1), served from the endpoint's
 * OWN origin (mcp.djzs.ai) because that is where x402scan and other crawlers
 * look — https://x402scan.com/discovery/spec. The static site cannot satisfy it;
 * a doc served from djzs.ai describes a different origin than the one that
 * answers 402.
 *
 * FREE + UNAUTHENTICATED, same class as /health/x402: no payment negotiation, no
 * secret read, no env access, no I/O. A frozen literal returned as-is, so this
 * route cannot fail the way /health/x402 can.
 *
 * payTo is DELIBERATELY ABSENT. The treasury is advertised at runtime in the 402
 * challenge (X402_RECIPIENT, built by buildPaymentRequirements below); runtime
 * behavior is authoritative over static metadata, so the address has exactly one
 * source of truth and static discovery data can never drift into naming a stale
 * recipient. Do not add it here.
 */
const OPENAPI_DOC = {
  "openapi": "3.1.0",
  "info": {
    "title": "DJZS Protocol: verify_pm_trade · verify_perp_trade",
    "version": "1.0.0",
    "summary": "Deterministic pre-execution audit of a prediction-market or perpetual/spot trade thesis.",
    "description": "DJZS audits the thesis, not the transaction. Wallet-layer tooling checks whether a transfer is safe; nothing checks whether the reasoning behind it holds. verify_pm_trade and verify_perp_trade read the thesis behind a trade and score its claims against a frozen taxonomy (narrative/resolution gap, falsification absent, probability unsourced, consensus-as-edge), returning a verdict, the codes that fired, a risk score, and a hash anyone can recompute from the submitted text. Out-of-scope requests are refused free: no payment settles.",
    "contact": {
      "name": "DJZS AI, LLC",
      "email": "username@djzs.ai",
      "url": "https://djzs.ai"
    },
    "license": { "name": "MIT" },
    "x-guidance": "Submit the reasoning behind a prospective prediction-market position as free text in the `intent` field. A well-formed thesis states the claim and its outcome, a SOURCED probability with a citation, the falsification condition, and the edge versus the market price. A consensus-only thesis with no source returns FAIL (DJZS-M03 PROBABILITY_UNSOURCED) and no order should be placed. Abstention is a first-class outcome. The audit reads reasoning only: it does not read markets, verify quoted prices, or check whether an instrument has already settled. Informational only, not financial advice: see https://djzs.ai/legal."
  },
  "servers": [
    { "url": "https://mcp.djzs.ai", "description": "Production (Base mainnet)" }
  ],
  "paths": {
    "/x402/verify_perp_trade": {
      "post": {
        "operationId": "verifyPerpTrade",
        "summary": "Audit a perpetual or spot trade thesis",
        "description": "Returns PASS, WAIT, or FAIL with the DJZS-LF codes that fired and a reproducible verdict_hash. A position stated with no thesis FAILS (DJZS-S01); an unbounded position FAILS (DJZS-X01). Prediction-market bets are refused without charge. Paid: 2.00 USDC on Base over x402; refusals free.",
        "tags": ["audit"],
        "x-payment-info": { "price": { "mode": "fixed", "currency": "USD", "amount": "2.00" }, "protocols": [{ "x402": {} }] },
        "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["intent"], "properties": { "intent": { "type": "object", "required": ["instrument", "side", "thesis"], "properties": { "instrument": { "type": "string" }, "side": { "type": "string", "enum": ["LONG", "SHORT"] }, "thesis": { "type": "string" }, "leverage": { "type": "number" }, "entry": { "type": "number" }, "stop_loss": { "type": "number" }, "take_profit": { "type": "number" }, "invalidation": { "type": "string" }, "size_usd": { "type": "number" }, "venue": { "type": "string" }, "data_sources": { "type": "string", "description": "Where the inputs came from. Bound into intent_hash. Social or sentiment-only sourcing is flagged (DJZS-I01), not blocked." } } } } } } } },
        "responses": { "402": { "description": "x402 payment challenge" } }
      }
    },
    "/x402/verify": {
      "post": {
        "operationId": "verifyPmTrade",
        "summary": "Audit a prediction-market trade thesis",
        "description": "Returns PASS, WAIT, or FAIL with the taxonomy codes that fired and a reproducible verdict_hash. Paid: 2.00 USDC on Base mainnet over x402 (exact scheme). An unpaid request returns HTTP 402 with the payment challenge. Out-of-scope submissions are refused without settling payment.",
        "tags": ["audit"],
        "x-payment-info": {
          "price": { "mode": "fixed", "currency": "USD", "amount": "2.00" },
          "protocols": [{ "x402": {} }]
        },
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["intent"],
                "properties": {
                  "intent": {
                    "type": "string",
                    "minLength": 10,
                    "description": "The prediction-market trade thesis, in free text. State the claim, a sourced probability with citation, the falsification condition, and the edge versus the market price.",
                    "examples": [
                      "Market X resolves YES. Falsified if event Y occurs by date Z. Sourced probability 0.62 per [source]; the market prices 0.55, so the edge is +7pts."
                    ]
                  },
                  "target_system": {
                    "type": "string",
                    "description": "Optional label for the venue or system the thesis targets. Recorded on the certificate."
                  },
                  "agent_address": {
                    "type": "string",
                    "pattern": "^0x[a-fA-F0-9]{40}$",
                    "description": "Optional EVM address. When supplied, the verdict is written to a public on-chain trust record on Base. This record is permanent and cannot be deleted."
                  }
                },
                "additionalProperties": false
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Audit complete. Payment settled.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "schema_version": { "type": "string", "const": "DJZS-ENGINE-V2" },
                    "tool": { "type": "string", "const": "verify_pm_trade" },
                    "in_scope": { "type": "boolean" },
                    "taxonomy": {
                      "type": "object",
                      "description": "Frozen taxonomy and weight hashes the verdict was computed under. Pin these to reproduce verdict_hash.",
                      "properties": {
                        "perp": { "type": "string" },
                        "pm": { "type": "string" },
                        "weights_hash": { "type": "string" },
                        "taxonomy_hash": { "type": "string" },
                        "pm_weights_hash": { "type": "string" },
                        "pm_taxonomy_hash": { "type": "string" }
                      }
                    },
                    "verdict": { "type": ["string", "null"], "enum": ["PASS", "WAIT", "FAIL", null] },
                    "action": { "type": "string", "enum": ["PROCEED", "HALT", "FAIL"] },
                    "risk_score": { "type": "number", "description": "0-100 aggregate risk weight." },
                    "flags": {
                      "type": "array",
                      "description": "Fired taxonomy findings as full objects; `code` carries the taxonomy id, e.g. DJZS-M03.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "code": { "type": "string", "description": "Taxonomy id, e.g. DJZS-M03." },
                          "name": { "type": "string" },
                          "severity": { "type": "string", "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
                          "weight": { "type": "number" },
                          "evidence": { "type": "string", "description": "Verbatim quote from the submitted intent that fired this code." }
                        }
                      }
                    },
                    "unknown_fields": { "type": "array", "items": { "type": "string" } },
                    "disagreements": { "type": "array", "items": { "type": "string" } },
                    "verdict_hash": { "type": "string", "description": "Reproducible sha256 of the canonicalized verdict." },
                    "extraction_failsafe": { "type": "boolean" },
                    "halt_reason": { "type": "string", "description": "Optional. Emitted only when action is HALT: which fields were unresolvable from the intent, and what to clarify before re-auditing." },
                    "pol_certificate": {
                      "description": "ProofOfLogic anchoring outcome. Fails open by design: an anchoring failure annotates the response and never blocks or mutates the verdict, so handle all three variants.",
                      "oneOf": [
                        {
                          "type": "object",
                          "required": ["status", "irys_id", "gateway_url"],
                          "properties": {
                            "status": { "const": "anchored" },
                            "node": { "type": "string" },
                            "irys_id": { "type": "string" },
                            "gateway_url": { "type": "string", "description": "Public gateway URL of the permanent certificate." }
                          }
                        },
                        {
                          "type": "object",
                          "required": ["status", "detail"],
                          "properties": {
                            "status": { "const": "disabled" },
                            "detail": { "type": "string", "description": "Anchoring not configured on this deployment; the verdict is unaffected." }
                          }
                        },
                        {
                          "type": "object",
                          "required": ["status", "detail"],
                          "properties": {
                            "status": { "const": "error" },
                            "detail": { "type": "string" }
                          }
                        }
                      ]
                    },
                    "trust_score": {
                      "description": "On-chain trust-record write outcome. Present only when agent_address was supplied. Fails open like pol_certificate; skipped is the common case, so handle all three variants.",
                      "oneOf": [
                        {
                          "type": "object",
                          "required": ["status", "tx_hash", "contract"],
                          "properties": {
                            "status": { "const": "written" },
                            "tx_hash": { "type": "string" },
                            "contract": { "type": "string" }
                          }
                        },
                        {
                          "type": "object",
                          "required": ["status", "reason"],
                          "properties": {
                            "status": { "const": "skipped" },
                            "reason": { "type": "string", "description": "Why no write was attempted, e.g. no anchored certificate to link the score to." }
                          }
                        },
                        {
                          "type": "object",
                          "required": ["status", "error_class", "detail"],
                          "properties": {
                            "status": { "const": "error" },
                            "error_class": { "type": "string" },
                            "detail": { "type": "string" }
                          }
                        }
                      ]
                    },
                    "settlement": {
                      "type": "object",
                      "description": "The settled x402 payment for this audit.",
                      "properties": {
                        "transaction": { "type": "string" },
                        "network": { "type": "string", "description": "CAIP-2 network id, e.g. eip155:8453." }
                      }
                    }
                  }
                }
              }
            }
          },
          "402": { "description": "Payment Required" },
          "400": { "description": "Malformed request body." },
          "503": { "description": "Payment facilitator or extraction backend unavailable." }
        }
      }
    },
    "/health/x402": {
      "get": {
        "operationId": "healthX402",
        "summary": "Payment configuration health",
        "description": "Free. Reports the configured network, facilitator status, and whether the network is supported.",
        "tags": ["health"],
        "responses": { "200": { "description": "OK" } }
      }
    }
  },
  "tags": [
    { "name": "audit", "description": "Paid reasoning audits." },
    { "name": "health", "description": "Free status endpoints." }
  ]
} as const

// 2026-09-15: /x402/verify_pm_trade is the canonical PM path named by x402.json, llms.txt, and the agent card;
// /x402/verify is the legacy alias. Document both so no discovery surface names a door the others do not.
//
// 2026-11-23: the canonical path no longer inherits the alias's BODY or RESPONSES. The two doors take different
// requests: /x402/verify reads `intent` as free text (app.post("/x402/verify") above, string >= 10 chars), while
// /x402/verify_pm_trade reads `intent` as an OBJECT and refuses a string with 400 missing_intent, and an object
// without market/side/thesis with 400 intent_unbindable (handleX402VerifyPmTrade, steps 2a and 3a). Spreading the
// legacy operation copied the string schema onto the canonical door, so every client that built its request from
// this document built one the route refuses. Only description, tags and x-payment-info are still shared.
//
// The object schema below mirrors PmIntentLike (djzs-intent.ts) and the route's own 402 discovery schema
// (http-x402-bazaar.v2.ts, discoveryExtensions); test/openapi.bundle.test.mjs fails if the required sets diverge.
// The example IS the one the 402 challenge publishes (extensions.bazaar.info.input.body), so the two cannot drift.
//
// Both paid doors run the same handler (handleX402VerifyPmTrade; the perp route passes PERP_RESOURCE and the perp
// adapter), so they answer with the same bodies: PAID_ROUTE_RESPONSES documents both. The perp door's 200 used to say
// "verdict, action, risk_score, flags, unknown_fields, verdict_hash, receipt", which is not what it returns.
const PM_INTENT_OBJECT_SCHEMA = {
  type: "object",
  description:
    "A prediction-market trade intent. Every key is read: the object is rendered as one `key: value` line per key, keys sorted, and that text is what is checked. market, side and thesis bind the receipt (intent_hash); without them the route answers 400 intent_unbindable and nothing is charged. Other keys are allowed and are read too.",
  required: ["market", "side", "thesis"],
  properties: {
    market: { type: "string", description: "Venue market id: a Kalshi ticker or a Polymarket market id." },
    side: { type: "string", description: "The side taken, e.g. YES or NO." },
    thesis: {
      type: "string",
      description:
        "Why the position is right, in plain words: the claim, the event that would prove it wrong, and where your odds come from.",
    },
    venue: { type: "string", description: "Venue name, e.g. Kalshi or Polymarket. Bound into intent_hash; empty when absent." },
    probability_basis: {
      type: "string",
      description: "Where your probability comes from: a checkable source and the time you read it.",
    },
    size_usd: { type: "number", minimum: 0, description: "Intended size in USD. A negative size cannot be bound (400, uncharged)." },
    bounds: {
      type: "object",
      description: "The loss you accept and the condition that ends the position.",
      properties: {
        max_loss_usd: { type: "number", minimum: 0 },
        exit_condition: { type: "string" },
      },
    },
  },
} as const

const PAID_ROUTE_RESPONSES = {
  "200": {
    description:
      "Either the verdict (payment settled, charged: true, receipt attested on Base) or a scope refusal (verdict REFUSED_SCOPE, nothing settled). The settlement is also in the PAYMENT-RESPONSE header (base64 JSON); an MPP payment adds Payment-Receipt.",
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              type: "object",
              title: "Verdict",
              required: ["verdict", "risk_score", "flags", "verdict_hash", "intent_sha256", "intent_hash", "eas_uid", "eas_tx", "eas_schema", "charged", "settlement_tx", "terms"],
              properties: {
                verdict: { type: "string", enum: ["PASS", "WAIT", "FAIL"] },
                risk_score: { type: "number", description: "Sum of the weights of the codes that fired." },
                flags: {
                  type: "array",
                  items: { type: "string" },
                  description: "Codes that fired (e.g. DJZS-M03), then unknown:<field> for each field the check could not settle.",
                },
                verdict_hash: { type: "string", description: "Recomputable fingerprint of the verdict." },
                intent_sha256: { type: "string", description: "sha256 of the rendered text that was checked." },
                intent_hash: { type: "string", description: "EIP-712 binding key written into the attestation." },
                tally: {
                  type: "object",
                  description: "The inputs to the verdict rule (DJZS-VR-v1.0).",
                  properties: {
                    ruleset: { type: "string" },
                    codes: { type: "array", items: { type: "string" } },
                    unknown_count: { type: "integer" },
                    bounded: { type: "boolean" },
                    thesis_present: { type: "boolean" },
                  },
                },
                sources: { type: "object", description: "Source check (DJZS-SRC). Non-scoring: never part of the verdict, its hash or the attestation." },
                eas_uid: { type: ["string", "null"], description: "EAS attestation on Base, payer as recipient. null when eas_error is set." },
                eas_tx: { type: ["string", "null"] },
                eas_schema: { type: "string" },
                eas_error: {
                  type: "string",
                  enum: ["attester_not_configured", "attestation_failed"],
                  description: "Present only when the attestation write failed. The verdict still stands and the payment is still recorded.",
                },
                charged: { type: "boolean", const: true },
                settlement_tx: { type: ["string", "null"], description: "The USDC transfer on Base." },
                terms: { type: "string" },
              },
            },
            {
              type: "object",
              title: "Scope refusal",
              required: ["verdict", "reason", "charged", "settled"],
              properties: {
                verdict: { type: "string", const: "REFUSED_SCOPE" },
                reason: { type: "string" },
                charged: { type: "boolean", const: false },
                settled: { type: "boolean", const: false },
                note: { type: "string" },
                terms: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
  "400": {
    description: "Refused before any money moved: invalid_json, missing_intent (intent is not an object), intent_unbindable (a required field is missing, or a value cannot be bound: market, side and thesis on verify_pm_trade; instrument, side and thesis on verify_perp_trade), malformed_payment_header.",
  },
  "402": { description: "Payment Required" },
  "405": { description: "method_not_allowed. GET and HEAD return the 402 challenge; OPTIONS is the CORS preflight." },
  "500": { description: "verdict AUDIT_ERROR: the payment settled but the check failed after it. charged: true; the body carries settlement_tx. Contact the operator with it and intent_sha256." },
  "502": { description: "SETTLEMENT_UNCERTAIN: the facilitator did not confirm and the transfer may have gone out (charged: null). Do not sign a second payment until you have looked up settlement_tx or your wallet." },
  "503": { description: "AUDIT_UNAVAILABLE or FACILITATOR_UNAVAILABLE. Nothing charged." },
} as const

{
  const paths = OPENAPI_DOC.paths as Record<string, Record<string, unknown>>;
  const legacy = paths["/x402/verify"];
  const challengeExample = (PM_RESOURCE.extensions as unknown as { bazaar?: { info?: { input?: { body?: unknown } } } })
    .bazaar?.info?.input?.body;
  paths["/x402/verify_pm_trade"] = {
    post: {
      ...(legacy.post as Record<string, unknown>),
      operationId: "verifyPmTradeCanonical",
      summary: "Audit a prediction-market trade thesis (canonical path; /x402/verify is the legacy alias)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["intent"], properties: { intent: PM_INTENT_OBJECT_SCHEMA } },
            ...(challengeExample ? { example: challengeExample } : {}),
          },
        },
      },
      responses: PAID_ROUTE_RESPONSES,
    },
  };
  // The perp door: same bodies, and the example its own 402 challenge publishes.
  const perpPost = paths["/x402/verify_perp_trade"].post as Record<string, unknown>;
  const perpExample = (PERP_RESOURCE.extensions as unknown as { bazaar?: { info?: { input?: { body?: unknown } } } })
    .bazaar?.info?.input?.body;
  const perpMedia = ((perpPost["requestBody"] as { content: Record<string, Record<string, unknown>> }).content)["application/json"];
  if (perpExample) perpMedia["example"] = perpExample;
  perpPost["responses"] = { ...PAID_ROUTE_RESPONSES, "402": { description: "Payment Required" } };
  // The legacy alias keeps its free-text contract, and now says which door takes which shape.
  const legacyPost = legacy.post as Record<string, unknown>;
  legacyPost["summary"] = "Audit a prediction-market trade thesis, free text (legacy alias; prefer /x402/verify_pm_trade)";
}
// 2026-11-02: MPP (Machine Payments Protocol) is accepted on the two verdict routes beside x402.
// mpp.dev discovery convention: x-payment-info.offers[] per paid operation and x-service-info.docs.llms at the
// root. The runtime 402 is authoritative; this is advisory. /x402/verify (legacy alias) stays x402-only.
{
  const doc = OPENAPI_DOC as unknown as Record<string, unknown>
  doc["x-service-info"] = {
    categories: ["trading", "audit", "ai"],
    docs: { homepage: "https://djzs.ai", apiReference: "https://docs.djzs.ai", llms: "/llms.txt" },
  }
  const paths = OPENAPI_DOC.paths as unknown as Record<string, { post: Record<string, unknown> }>
  const mppOffer = {
    amount: EXPECTED_ATOMIC_AMOUNT,
    currency: USDC_BASE,
    description: "One audit. USDC on Base (chain 8453), EIP-3009 authorization, settled through the same facilitator as x402.",
    intent: "charge",
    method: "evm",
  }
  for (const p of ["/x402/verify_pm_trade", "/x402/verify_perp_trade"]) {
    const post = paths[p].post
    const info = (post["x-payment-info"] as Record<string, unknown> | undefined) ?? {}
    post["x-payment-info"] = { ...info, protocols: [{ x402: {} }, { mpp: { method: "evm", intent: "charge" } }], offers: [mppOffer] }
    post["responses"] = {
      ...(post["responses"] as Record<string, unknown>),
      "402": { description: "Payment challenge, two protocols on one response: x402 v2 (PAYMENT-REQUIRED header and JSON body) and MPP (WWW-Authenticate: Payment, evm/charge). Pay with either; one settlement." },
    }
  }
}
// 2026-11-23: the FREE check is in the contract. POST /try/verdict runs the same pipeline as the paid routes and
// attests nothing; its CORS is open, so an in-page API runner (the docs' "Test it") can call it directly. The
// two reads beside it are GET /try/quota and GET /try/example. Limits come from try-route.ts, never retyped here.
// /try/markets and /try/market serve the djzs.ai home page and stay undocumented here on purpose.
// x-guidance named only the free-text door; it now names all three, since the canonical paid door takes an object.
{
  const doc = OPENAPI_DOC as unknown as Record<string, unknown>
  const info = doc["info"] as Record<string, unknown>
  info["x-guidance"] =
    "Three doors, one engine. Free: POST /try/verdict with { kind, intent: { thesis } } and a 32-hex `anon` id you keep, " +
    `${TRY_ANON_DAILY_LIMIT} checks per id per UTC day; nothing is attested. Paid: POST /x402/verify_pm_trade with an OBJECT intent ` +
    "{ market, side, thesis, ... } or /x402/verify_perp_trade with { instrument, side, thesis, ... }, 2.00 USDC on Base, " +
    "and the verdict is attested on EAS. Legacy: POST /x402/verify takes the prediction-market thesis as free text. " +
    "A well-formed prediction-market thesis states the claim, a SOURCED probability with a citation, the event that would prove it wrong, " +
    "and the edge versus the market price. A consensus-only thesis with no source returns FAIL (DJZS-M03 PROBABILITY_UNSOURCED) and no order should be placed. " +
    "Abstention is a first-class outcome. The audit reads reasoning only: it does not read markets, verify quoted prices, or check whether an instrument has already settled. " +
    "Informational only, not financial advice: see https://djzs.ai/legal."

  const tags = doc["tags"] as Array<Record<string, string>>
  doc["tags"] = [
    ...tags,
    { name: "free", description: "Free checks: same engine and rulesets as the paid routes, capped per caller and per day, nothing attested. CORS open." },
  ]

  const err = (codes: readonly string[], extra: Record<string, unknown> = {}) => ({
    type: "object",
    required: ["ok", "error"],
    properties: { ok: { type: "boolean", const: false }, error: { type: "string", enum: codes }, ...extra },
  })
  const jsonBody = (schema: unknown) => ({ content: { "application/json": { schema } } })
  const quota = {
    type: "object",
    properties: {
      day: { type: "string", format: "date" },
      limit: { type: "integer" },
      used: { type: "integer" },
      remaining: { type: "integer" },
      resets_at: { type: "string", format: "date-time" },
    },
  }
  const receiptOffer = {
    type: "object",
    description: "How to buy the attested version of this check on the paid route.",
    properties: {
      price: { type: "string" }, network: { type: "string" }, url: { type: "string" },
      ruleset: { type: "string" }, what: { type: "string" }, how: { type: "string" },
    },
  }

  const TRY_ANON_PLACEHOLDER = "REPLACE-with-your-own-id-from-openssl-rand-hex-16"
  const paths = OPENAPI_DOC.paths as unknown as Record<string, Record<string, unknown>>
  paths["/try/verdict"] = {
    post: {
      operationId: "tryVerdict",
      summary: "Free check of a trade thesis (PASS, WAIT or FAIL; nothing attested)",
      description:
        "The same engine and rulesets as the paid routes, with nothing written anywhere. Identify the caller one of two ways. " +
        `(1) anon: a 32-character lowercase hex id you generate once and keep (openssl rand -hex 16), ${TRY_ANON_DAILY_LIMIT} checks per id per UTC day. ` +
        `(2) A wallet: address, day and an EIP-191 signature over the text GET /try/quota returns as message_format, ${TRY_DAILY_LIMIT} checks per wallet per UTC day. ` +
        `Fresh ids do not get past the global cap (default ${TRY_GLOBAL_DAILY_LIMIT_DEFAULT} free checks per UTC day across all callers). ` +
        "The anon in the example is a placeholder, not an id: replace it with your own. Sent as is it returns 400 bad_anon_id and uses nothing. " +
        "A scope refusal (a perp trade sent as kind pm, or the reverse) still uses one of the day's checks.",
      tags: ["free"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["kind", "intent"],
              properties: {
                kind: { type: "string", enum: TRY_KINDS, description: "pm for a prediction-market bet, perp for a perp or spot trade." },
                intent: {
                  type: "object",
                  description: `The thesis to check, at most ${TRY_MAX_INTENT_BYTES} bytes serialized. { "thesis": "..." } is enough; other keys are allowed and are read too.`,
                  properties: { thesis: { type: "string" } },
                },
                anon: { type: "string", pattern: TRY_ANON_ID_RE.source, description: "Your id for the wallet-free path: 32 lowercase hex characters you generate once and keep (openssl rand -hex 16). Send it without address." },
                address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Wallet path: the signing address." },
                day: { type: "string", format: "date", description: "Wallet path: the server's UTC day, from GET /try/quota." },
                signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$", description: "Wallet path: EIP-191 personal_sign over message_format filled with address, day and intent_sha256." },
              },
            },
            // The anon is a PLACEHOLDER on purpose, never a valid id. A valid id here would be one quota bucket
            // shared by every reader who presses "Test it", and it would run dry within the first few presses of the
            // day. A placeholder fails the pattern, so the route answers 400 bad_anon_id ("anon must be 32 lowercase
            // hex characters") before any slot is taken. test/openapi.bundle.test.mjs holds both halves of that.
            example: {
              kind: "pm",
              anon: TRY_ANON_PLACEHOLDER,
              intent: {
                // Deliberately a narrative with no source and no exit: the kind of thesis the check exists to stop.
                // Real markets with live prices come from GET /try/example.
                thesis:
                  "Buying YES on Bitcoin closing the year above 100k. Everyone on my feed says the breakout is coming and the ETF flows look strong.",
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "ok: true. A verdict, or verdict REFUSED_SCOPE (with a reason) when the thesis does not read as the kind named.",
          ...jsonBody({
            type: "object",
            required: ["ok", "kind", "verdict", "intent_sha256", "quota", "attested"],
            properties: {
              ok: { type: "boolean", const: true },
              kind: { type: "string", enum: TRY_KINDS },
              verdict: { type: "string", enum: ["PASS", "WAIT", "FAIL", "REFUSED_SCOPE"] },
              reason: { type: "string", description: "REFUSED_SCOPE only." },
              risk_score: { type: "number" },
              flags: { type: "array", items: { type: "string" }, description: "Codes that fired, then unknown:<field> for each unsettled field." },
              flags_detail: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    code: { type: "string" }, name: { type: "string" }, description: { type: "string" },
                    severity: { type: "string" }, weight: { type: "number" }, evidence: { type: "string" },
                  },
                },
              },
              unknown_fields: { type: "array", items: { type: "string" } },
              unsettled: {
                type: "array",
                description: "WAIT only: per unknown field, what the three readings did and which of your sentences they pointed at.",
                items: { type: "object" },
              },
              verdict_hash: { type: ["string", "null"] },
              intent_sha256: { type: "string" },
              intent_hash: { type: ["string", "null"], description: "The binding key the paid route would attest, or null when the intent lacks the fields it needs." },
              tally: { type: "object" },
              taxonomy: { type: "object" },
              ruleset: { type: "string" },
              quota,
              attested: { type: "boolean", const: false },
              receipt: receiptOffer,
              note: { type: "string" },
              terms: { type: "string" },
            },
          }),
        },
        "400": {
          description: "Malformed request. day_mismatch returns the server's day.",
          ...jsonBody(err(["invalid_json", "bad_kind", "missing_intent", "bad_anon_id", "bad_address", "bad_signature_format", "day_mismatch"], { detail: { type: "string" } })),
        },
        "401": {
          description: "The signature does not recover to address. The body includes signed_text_expected.",
          ...jsonBody(err(["bad_signature"], { signed_text_expected: { type: "string" } })),
        },
        "405": { description: "method_not_allowed. POST and OPTIONS only." },
        "413": { description: `intent_too_large: the intent is over ${TRY_MAX_INTENT_BYTES} bytes serialized.`, ...jsonBody(err(["intent_too_large"])) },
        "429": {
          description: "This id or wallet used today's checks, or the global daily cap is reached. Carries resets_at and the paid receipt offer; the paid routes still work.",
          ...jsonBody(err(["wallet_quota_exhausted", "free_tier_exhausted_today"], { resets_at: { type: "string", format: "date-time" }, receipt: receiptOffer })),
        },
        "500": { description: "engine_contract_violation." },
        "503": {
          description: "The check could not run. A failed run gives the slot back (slot_released: true).",
          ...jsonBody(err(["audit_unavailable", "quota_store_unavailable", "try_unavailable"], { slot_released: { type: "boolean" } })),
        },
      },
    },
  }
  paths["/try/quota"] = {
    get: {
      operationId: "tryQuota",
      summary: "Free checks left today, and the text a wallet signs",
      description:
        "With anon: checks left for that id today. With address: checks left for that wallet. With neither: the signing template " +
        "(message_format), the server's current UTC day, the global allowance left, and the paid receipt offers.",
      tags: ["free"],
      parameters: [
        { name: "anon", in: "query", required: false, schema: { type: "string", pattern: TRY_ANON_ID_RE.source } },
        { name: "address", in: "query", required: false, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
      ],
      responses: {
        "200": {
          description: "ok: true.",
          ...jsonBody({
            type: "object",
            required: ["ok", "day", "resets_at", "limit", "message_format", "kinds", "receipt"],
            properties: {
              ok: { type: "boolean", const: true },
              day: { type: "string", format: "date" },
              resets_at: { type: "string", format: "date-time" },
              limit: { type: "integer", description: `Per caller per UTC day: ${TRY_ANON_DAILY_LIMIT} for an anon id, ${TRY_DAILY_LIMIT} for a wallet.` },
              limit_wallet: { type: "integer", description: "anon queries only: the wallet path's limit." },
              anon: { type: "string" },
              address: { type: "string" },
              used: { type: "integer" },
              remaining: { type: "integer" },
              global_remaining: { type: "integer" },
              message_format: { type: "string", description: "The EIP-191 text a wallet signs; fill {address}, {day}, {intent_sha256}." },
              kinds: { type: "array", items: { type: "string", enum: TRY_KINDS } },
              receipt: { type: "object", properties: { pm: receiptOffer, perp: receiptOffer } },
              terms: { type: "string" },
            },
          }),
        },
        "400": { description: "bad_anon_id or bad_address.", ...jsonBody(err(["bad_anon_id", "bad_address"])) },
        "405": { description: "method_not_allowed. GET and OPTIONS only." },
        "503": { description: "quota_store_unavailable.", ...jsonBody(err(["quota_store_unavailable"])) },
      },
    },
  }
  paths["/try/example"] = {
    get: {
      operationId: "tryExample",
      summary: "Curated real markets with live prices, each with a ready thesis",
      description:
        "Only markets that are still open are served, so the list can be empty: that is a true answer, not an error. " +
        "Each example's thesis can be sent as the intent of POST /try/verdict (kind pm). Cached for 60 seconds.",
      tags: ["free"],
      parameters: [{ name: "id", in: "query", required: false, description: "One example by id. Omit for all open examples.", schema: { type: "string" } }],
      responses: {
        "200": {
          description: "ok: true.",
          ...jsonBody({
            type: "object",
            required: ["ok", "examples"],
            properties: {
              ok: { type: "boolean", const: true },
              examples: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" }, venue: { type: "string" }, market_id: { type: "string" }, url: { type: "string" },
                    title: { type: "string" }, side: { type: "string" }, closes: { type: "string" },
                    price: {
                      type: "object",
                      properties: {
                        yes_bid: { type: "number" }, yes_ask: { type: "number" },
                        live: { type: "boolean", description: "false when the venue could not be reached and a snapshot was used." },
                        as_of: { type: "string" },
                      },
                    },
                    thesis: { type: "string" },
                  },
                },
              },
            },
          }),
        },
        "404": { description: "unknown_example. The body lists the valid ids.", ...jsonBody(err(["unknown_example"], { ids: { type: "array", items: { type: "string" } } })) },
        "405": { description: "method_not_allowed. GET and OPTIONS only." },
      },
    },
  }
}
// CORS open: the document is public and carries no credentials. A docs site that loads it by URL (GitBook's
// OpenAPI block, Scalar) fetches it from the reader's browser, which refuses a cross-origin response without this.
app.get("/openapi.json", (c) => c.json(OPENAPI_DOC, 200, { "Access-Control-Allow-Origin": "*" }))

app.post("/x402/verify", async (c) => {
  const env = c.env
  const network = normalizeNetwork(env.X402_HTTP_NETWORK ?? X402_NETWORK)

  // DISCOVERY ORDERING (x402scan registration probes, 2026-08-18). The 402
  // challenge MUST be reachable regardless of body shape: a prober posts an
  // empty or minimal body, and if schema validation runs first the endpoint
  // answers 400 and is classified UNPAID. Body parsing therefore happens AFTER
  // payment verification (below), never before the challenge is issued.
  // Nothing here reads the body, so the challenge cannot depend on it.
  //
  // Same facilitator config object the MCP transport builds, from the same secrets.
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)),
  )
  registerExactEvmScheme(resourceServer)
  try {
    await resourceServer.initialize()
  } catch (e) {
    logFault("x402.legacy.facilitator", e)
    return c.json({ error: "FACILITATOR_UNAVAILABLE", detail: "facilitator_unavailable" satisfies Fault }, 503)
  }

  let requirements
  try {
    requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      payTo: X402_RECIPIENT,
      price: VERIFY_PM_TRADE_PRICE_USD,
      network,
      maxTimeoutSeconds: 300,
    })
  } catch {
    return c.json({ x402Version: 2, error: "PRICE_COMPUTE_FAILED" }, 503)
  }

  const resourceInfo = {
    url: X402_HTTP_RESOURCE,
    description: `Deterministic pre-execution audit of a prediction-market trade thesis. ${VERIFY_PM_TRADE_PRICE_USD} USDC per audit.`,
    mimeType: "application/json",
  }
  /** 402 + PAYMENT-REQUIRED header (v2 wire) and the same JSON body older clients read. */
  const paymentRequired = (reason: string, extraFields: Record<string, unknown> = {}) => {
    const payload = { x402Version: 2, error: reason, resource: resourceInfo, accepts: requirements, ...extraFields }
    let headers: Record<string, string> = {}
    try {
      headers = { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(payload as never) }
    } catch {
      /* body alone still satisfies clients that read accepts from JSON */
    }
    return c.json(payload, 402, headers)
  }

  const token = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT")
  if (!token) return paymentRequired("PAYMENT_REQUIRED")

  let paymentPayload
  try {
    paymentPayload = decodePaymentSignatureHeader(token)
  } catch {
    return paymentRequired("INVALID_PAYMENT")
  }
  const matchingReq = resourceServer.findMatchingRequirements(requirements, paymentPayload)
  if (!matchingReq) return paymentRequired("INVALID_PAYMENT")

  try {
    const vr = await resourceServer.verifyPayment(paymentPayload, matchingReq)
    if (!vr.isValid) return paymentRequired(reasonCode(vr.invalidReason, "INVALID_PAYMENT"), { payer: addressOnly(vr.payer) })
  } catch {
    return paymentRequired("INVALID_PAYMENT")
  }

  // ── payment VERIFIED but NOT settled. ─────────────────────────────────────
  // The body is validated HERE, after the challenge is reachable but before any
  // engine work. A paying client with a malformed body is still refused, and
  // refused with NOTHING SETTLED — settlePayment is unreachable from this branch,
  // so a bad request never costs the payer and never reaches runVerifyPmTrade.
  // This is the only ordering that satisfies both the discovery probe (challenge
  // before validation) and the money path (no engine work on an unvalidated body).
  let body: { intent?: unknown; agent_address?: unknown; target_system?: unknown; target_system_subject?: unknown; target_system_signature?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "BAD_REQUEST", detail: "body must be JSON" }, 400)
  }
  const intent = typeof body.intent === "string" ? body.intent : ""
  if (intent.length < 10) {
    return c.json({ error: "BAD_REQUEST", detail: "intent must be a string of at least 10 characters" }, 400)
  }
  const agent_address = typeof body.agent_address === "string" ? body.agent_address : undefined
  const target_system_claim = {
    value: typeof body.target_system === "string" ? body.target_system : undefined,
    subject: typeof body.target_system_subject === "string" ? body.target_system_subject : undefined,
    signature: typeof body.target_system_signature === "string" ? body.target_system_signature : undefined,
  }

  // ── the audit runs first. ─────────────────────────────────────────────────
  if (!env.ANTHROPIC_API_KEY) {
    return c.json({ error: "EXTRACTION_UNAVAILABLE", detail: "ANTHROPIC_API_KEY not configured" }, 503)
  }
  let result: Record<string, unknown>
  try {
    result = (await runVerifyPmTrade(intent, buildAnthropicModelFn(env.ANTHROPIC_API_KEY))) as unknown as Record<string, unknown>
  } catch (e) {
    // Handler failure is NOT the payer's fault: refuse and do not settle.
    logFault("x402.legacy.audit", e)
    return paymentRequired("AUDIT_FAILED", { detail: "extraction_failed" satisfies Fault })
  }

  // OUT-OF-SCOPE = NOT CHARGED. Same rule as /mcp, enforced by returning before
  // settlePayment is ever reached. Do not move this below the settle call.
  if (result.in_scope === false) {
    return c.json({ x402Version: 2, error: "OUT_OF_SCOPE", settled: false, ...result }, 402)
  }

  // ── in scope: settle now ──────────────────────────────────────────────────
  let settle
  try {
    settle = await resourceServer.settlePayment(paymentPayload, matchingReq)
  } catch (e) {
    // Same rule as the canonical routes (R2): a throw means the transfer may be broadcast. A 402 with a
    // fresh challenge would invite a second payment, so answer 502 SETTLEMENT_UNCERTAIN instead.
    const t = (e as { transaction?: unknown; payer?: unknown }) ?? {}
    logFault("x402.legacy.settle", e, { payer: t.payer, transaction: t.transaction })
    return settlementUncertain({ payer: t.payer, transaction: t.transaction })
  }
  if (!settle.success) {
    // success:false WITH a transaction hash is settlement_pending (broadcast, not yet confirmed) or a
    // reverted / mismatched transfer: the transfer exists, so this is uncertain too.
    if (typeof settle.transaction === "string" && settle.transaction !== "") {
      logFault("x402.legacy.settle", new Error(`success:false with a transaction (${reasonCode(settle.errorReason)})`), { payer: settle.payer, transaction: settle.transaction })
      return settlementUncertain({ payer: settle.payer, transaction: settle.transaction })
    }
    return paymentRequired(reasonCode(settle.errorReason, "SETTLEMENT_FAILED"))
  }

  // The payer is passed as the expected subject: on this transport the settling
  // address is cryptographically established, so the claim must recover to it.
  // A claim signed by any other key is discarded rather than downgraded.
  const { pol_certificate, trust_score } = await anchorAndScore(
    env, result, intent, target_system_claim, agent_address,
    (settle as { payer?: string }).payer,
  )

  let response: Record<string, unknown> = result
  if (pol_certificate) response = { ...response, pol_certificate }
  if (trust_score) response = { ...response, trust_score }

  let headers: Record<string, string> = {}
  try {
    headers = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) }
  } catch {
    /* verdict still returns; the tx is also echoed in the body below */
  }
  return c.json({ ...response, settlement: { transaction: settle.transaction, network: settle.network } }, 200, headers)
})

/**
 * CDP facilitator base URL. Committed as a SOURCE CONSTANT for the same reason
 * X402_RECIPIENT is: the compliance grep must be able to see where payment
 * verification and settlement are sent. Identical to the url @coinbase/x402's
 * createFacilitatorConfig() builds, which is what /mcp and /x402/verify use.
 */
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"

/**
 * POST /x402/verify_pm_trade — the Bazaar-indexable plain-HTTP surface
 * (DEPLOY_RUNBOOK Step 1). Same gate, same price, same treasury as /mcp and
 * /x402/verify; what is new is the discovery extension on the 402 challenge and
 * the object-shaped intent.
 *
 * The handler owns the payment invariants (challenge -> verify -> SCOPE GATE ->
 * settle -> engine); this mount owns only the two seams it needs:
 *
 *   FACILITATOR_AUTH — CDP's own auth-header helper, given the request-scoped
 *     secrets by NAME (CDP_API_KEY_ID / CDP_API_KEY_SECRET). Values are never read,
 *     logged, or copied here; the helper signs a CDP JWT per facilitator path.
 *     Absent secrets => unauthenticated facilitator calls => the facilitator
 *     refuses => no audit is served free.
 *
 *   engineAdapter — built PER REQUEST so the extraction key comes off c.env and the
 *     adapter's one-extraction memo cannot outlive the request.
 *
 * The try/catch is the uncharged-failure net: the adapter throws from scopeCheck
 * (misconfigured key, extraction outage) strictly BEFORE settlePayment is reachable,
 * so a 503 here has always cost the caller nothing.
 */
// S1 + S4: registered with `app.all`, not `app.post`. The handler has always
// carried a method guard, but Hono never dispatched anything but POST here, so
// GET / HEAD / OPTIONS died at the router with a 404 and the guard was dead code.
// A live paid endpoint that 404s to a crawler reads as a dead endpoint. Method
// policy — challenge-only GET/HEAD, 204 preflight, 405 for the rest — is decided
// in ONE place, inside handleX402VerifyPmTrade.
app.all("/x402/verify_pm_trade", async (c) => {
  const env = c.env
  const x402Env: X402Env = {
    FACILITATOR_URL: env.FACILITATOR_URL ?? CDP_FACILITATOR_URL,
    FACILITATOR_AUTH: createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
    MPP_SECRET_KEY: env.MPP_SECRET_KEY,
    ATTESTER_KEY: env.DJZS_ATTESTER_KEY,
    BASE_RPC_URL: env.BASE_RPC_URL,
    EAS_RESOLVER_ADDRESS: env.EAS_RESOLVER_ADDRESS,
  }
  try {
    return await handleX402VerifyPmTrade(c.req.raw, x402Env, createEngineAdapter(env))
  } catch (e) {
    // handleX402VerifyPmTrade answers its own failures and owns what settled and what did not.
    // This is the last resort, so it claims nothing about the money.
    logFault("x402.route", e)
    return c.json({ error: "AUDIT_UNAVAILABLE", detail: "audit_unavailable" satisfies Fault }, 503)
  }
})

// /try: the FREE, wallet-capped preview of the paid audit (ruling 2026-09-27, "sell the receipt").
// Same pipeline, same verdict fields, nothing attested; the response carries the paid route's offer.
// Quota lives in D1 (TELEMETRY); without the binding the route fails closed. Details in try-route.ts.
app.all("/try/quota", (c) => handleTryQuota(c.req.raw, c.env))
app.all("/try/example", (c) => handleTryExample(c.req.raw))
// Markets trading today, for the home page's starter buttons. Public venue reads only: no model, no key, no D1.
app.all("/try/markets", (c) => handleTryMarkets(c.req.raw))
// Which market is this id? Venue title and open/closed/settled, for the receipt's market id box. No model, no price.
app.all("/try/market", (c) => handleTryMarket(c.req.raw))
app.all("/try/verdict", async (c) => {
  try {
    return await handleTryVerdict(c.req.raw, c.env)
  } catch (e) {
    logFault("try.route", e)
    return c.json({ ok: false, error: "try_unavailable", detail: "audit_unavailable" satisfies Fault }, 503)
  }
})

// POST /x402/verify_perp_trade — the perp/spot Bazaar surface (Phase 1b, 2026-09-09). Same handler, same payment invariants;
// only the ResourceSpec (URL, description, discovery schema, ruleset version) and the engine runner differ.
app.all("/x402/verify_perp_trade", async (c) => {
  const env = c.env
  const x402Env: X402Env = {
    FACILITATOR_URL: env.FACILITATOR_URL ?? CDP_FACILITATOR_URL,
    FACILITATOR_AUTH: createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
    MPP_SECRET_KEY: env.MPP_SECRET_KEY,
    ATTESTER_KEY: env.DJZS_ATTESTER_KEY,
    BASE_RPC_URL: env.BASE_RPC_URL,
    EAS_RESOLVER_ADDRESS: env.EAS_RESOLVER_ADDRESS,
  }
  try {
    return await handleX402VerifyPmTrade(c.req.raw, x402Env, createEngineAdapter(env, undefined, runVerifyPerpTrade as unknown as typeof runVerifyPmTrade), PERP_RESOURCE)
  } catch (e) {
    // handleX402VerifyPmTrade answers its own failures and owns what settled and what did not.
    // This is the last resort, so it claims nothing about the money.
    logFault("x402.route", e)
    return c.json({ error: "AUDIT_UNAVAILABLE", detail: "audit_unavailable" satisfies Fault }, 503)
  }
})

// ------------------------------------------------------------------
// Scheduled full-catalog Bazaar scan.
// ------------------------------------------------------------------
// Same scan as scripts/bazaar-scan.zsh, on a cron instead of DJ's terminal:
// paginate limit=1000 by offset until offset >= pagination.total, match
// case-insensitively on "djzs" and on the treasury address, write one row.
//
// The treasury needle is derived from the imported PAY_TO, never restated — the
// same no-drift rule the discovery surfaces follow. The "0x" prefix is stripped
// so the needle matches whether or not the catalog renders it.
const BAZAAR_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"
const BAZAAR_PAGE_LIMIT = 1000
/** Same safety cap as the shell script: 30 pages = 30k entries. */
const BAZAAR_PAGE_CAP = 30

/**
 * Run the scan and write exactly one bazaar_scan row.
 *
 * NEVER THROWS. Every failure path — network, non-200, malformed JSON, missing
 * binding — is converted into a row with `error` set. A missing row must mean
 * "the cron did not fire", never "the scan failed silently", because the T+48h
 * and T+7d adjudications read absence as signal.
 */
async function runBazaarScan(env: Env): Promise<void> {
  const ts = new Date().toISOString()
  let total: number | null = null
  let pages = 0
  let found = false
  let error: string | null = null
  const matches: unknown[] = []

  try {
    const treasury = PAY_TO.toLowerCase().replace(/^0x/, "")
    let offset = 0
    let known = 1 // provisional, replaced by pagination.total on the first page
    while (offset < known) {
      if (pages >= BAZAAR_PAGE_CAP) {
        error = `SAFETY_CAP: stopped after ${pages} pages at offset ${offset}`
        break
      }
      const resp = await fetch(`${BAZAAR_DISCOVERY_URL}?limit=${BAZAAR_PAGE_LIMIT}&offset=${offset}`, {
        headers: { accept: "application/json" },
      })
      if (!resp.ok) throw new Error(`discovery HTTP ${resp.status}`)
      const body = (await resp.json()) as { items?: unknown[]; pagination?: { total?: number } }
      pages++
      known = typeof body.pagination?.total === "number" ? body.pagination.total : 0
      total = known
      const items = Array.isArray(body.items) ? body.items : []
      for (const item of items) {
        const hay = JSON.stringify(item).toLowerCase()
        if (hay.includes("djzs") || hay.includes(treasury)) {
          found = true
          matches.push(item)
        }
      }
      if (items.length === 0) break
      offset += BAZAAR_PAGE_LIMIT
    }
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500)
  }

  try {
    const db = env?.TELEMETRY
    if (!db) return // no binding: nowhere to write, and nothing worth throwing over
    await db
      .prepare("INSERT INTO bazaar_scan (ts, total, pages, found, detail, error) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ts, total, pages, found ? 1 : 0, matches.length ? JSON.stringify(matches).slice(0, 100000) : null, error)
      .run()
  } catch {
    // The row is the only output; if it cannot be written there is nothing left
    // to do but fail quietly. Throwing would only make the cron retry the scan.
  }
}

/**
 * WORKER ENTRYPOINT.
 *
 * This was `export default app`. Adding a cron requires a `scheduled` handler,
 * which a bare Hono instance does not carry, so the default export is now an
 * object literal exposing both.
 *
 * `fetch: app.fetch` preserves routing exactly. Hono defines fetch as a CLASS
 * PROPERTY holding an arrow function (hono/dist/hono-base.js: `fetch = (request,
 * ...rest) => {...}`), so it closes over the instance at construction and stays
 * bound when detached from `app`. Every route registered above — the discovery
 * middleware, /mcp, /, /health/*, /openapi.json, /x402/* — resolves through the
 * same dispatcher it always did. This is Hono's documented pattern for adding a
 * scheduled handler, not a workaround.
 *
 * `scheduled` cannot throw: runBazaarScan converts every failure into an error
 * row, and the call is wrapped again here. An unhandled throw would make the
 * runtime retry the cron, turning one failed scan into a retry storm.
 */
export default {
  fetch: app.fetch,
  scheduled: async (_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> => {
    try {
      ctx.waitUntil(runBazaarScan(env))
    } catch {
      // never propagate out of a scheduled handler
    }
    try {
      // Pay-link housekeeping: drop sessions a week after their link expired. Never throws.
      ctx.waitUntil(prunePaySessions(env?.TELEMETRY, new Date()))
    } catch {
      // same rule
    }
  },
}
