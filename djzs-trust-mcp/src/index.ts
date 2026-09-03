import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import type { Context, ExecutionContext } from "hono"
import { z } from "zod"
import { VERIFY_PM_TRADE_INPUT, buildAnthropicModelFn, runVerifyPmTrade } from "./verify-pm-trade"
import { anchorPolCertificate, buildIrysUploadFn } from "./pol-certificate"
import { buildTrustWriter, describeWriterKey, checkWriterAuthorization, DJZS_TRUST_CONTRACT } from "./trust-writer"
import { withX402, normalizeNetwork } from "agents/x402"
import { createFacilitatorConfig, createCdpAuthHeaders } from "@coinbase/x402"
import { handleX402VerifyPmTrade, PAY_TO, type X402Env } from "./http-x402-bazaar.v2"
import { createEngineAdapter } from "./engine-adapter"
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

/**
 * Worker bindings. ANTHROPIC_API_KEY and IRYS_UPLOAD_KEY are wrangler SECRETS
 * (never in wrangler.toml). IRYS_NODE_URL is a plain [vars] entry.
 */
interface Env {
  ANTHROPIC_API_KEY?: string
  /** EVM private key hex signing PoL DataItems. Absent => anchoring reports "disabled"; audits still run. */
  IRYS_UPLOAD_KEY?: string
  /** Irys upload node. Defaults to devnet (D3 ruling); mainnet cutover flips this var. */
  IRYS_NODE_URL?: string
  /** Q3 study: bearer for POST /q3/anchor. SECRET. Absent => route returns 503 (anchoring disabled). */
  DJZS_Q3_ANCHOR_KEY?: string
  /** CDP facilitator API key id (A10). SECRET, request-scoped. Absent => paid tool cannot settle. */
  CDP_API_KEY_ID?: string
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
    bind(...values: unknown[]): { run(): Promise<unknown> }
  }
}

/**
 * Build a fully-registered MCP server. Constructed PER REQUEST (see the /mcp route)
 * so tool handlers close over the request-time `env` — Workers secrets live only on
 * the env binding, never on module scope. The two registry tools are env-independent
 * and behave identically to before; verify_pm_trade needs env.ANTHROPIC_API_KEY.
 */
function buildServer(env: Env): McpServer {
  // A10: the facilitator is CDP, its config (url + createAuthHeaders JWT signer)
  // built from request-scoped secrets. createFacilitatorConfig takes the keys
  // explicitly, so nothing reads module-scope process.env. Absent keys yield a
  // config whose auth cannot sign -> the facilitator refuses -> the paid tool
  // errors BEFORE the handler runs (fail-closed: no free audit is ever served);
  // free tools are unaffected because withX402 gates only the paid tool.
  const server = withX402(new McpServer({ name: "djzs-trust-mcp", version: "1.0.0" }), {
    network: X402_NETWORK,
    recipient: X402_RECIPIENT,
    facilitator: createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
  })

  server.registerTool("query_pol_certificates", {
    title: "Query DJZS ProofOfLogic Certificates",
    description: `Query immutable ProofOfLogic certificates stored on Irys Datachain by DJZS Protocol. USE THIS TOOL when you need to verify audit history for an agent or project before delegating work, check FAIL verdicts, or retrieve certificates by Irys tx ID. DO NOT use for on-chain trust scores — use query_agent_trust for those.`,
    inputSchema: {
      targetSystem: z.string().optional().describe("Project name or wallet address"),
      verdict: z.enum(["PASS", "FAIL"]).optional().describe("Filter by verdict"),
      tier: z.enum(["micro", "founder", "treasury"]).optional().describe("Filter by tier"),
      limit: z.number().min(1).max(100).default(20).describe("Number of results"),
      from_ms: z.number().int().optional().describe("Window start (epoch ms). Default path auto-narrows (14d then 3d) to stay under the mainnet index timeout; pass an explicit value to reach older certificates (used as-is)."),
      to_ms: z.number().int().optional().describe("Window end (epoch ms). Defaults to now + 1h.")
    }
  }, async ({ targetSystem, verdict, tier, limit, from_ms, to_ms }) => {
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
      if (!response.ok) { lastErr = `Irys HTTP ${response.status}`; continue }
      const j = await response.json() as any
      if (j.errors?.length) { lastErr = j.errors; continue }
      data = j.data
      usedFromMs = fromMs
      break
    }
    if (!data) {
      return { content: [{ type: "text" as const, text: `Irys query failed on all windows (pass a narrower from_ms/to_ms): ${JSON.stringify(lastErr)}` }], isError: true }
    }

    const certs = data.transactions.edges.map(({ node }: any) => {
      const t: Record<string, string> = {}
      for (const tag of node.tags) t[tag.name] = tag.value
      return {
        irys_id: node.id,
        irys_url: `https://gateway.irys.xyz/${node.id}`,
        timestamp: node.timestamp,
        verdict: t["verdict"] ?? "unknown",
        tier: t["tier"] ?? "unknown",
        target_system: t["Target-System"] ?? "unknown",
        audit_id: t["audit-id"] ?? "unknown"
      }
    })

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        total_returned: certs.length,
        pass_count: certs.filter((c: any) => c.verdict === "PASS").length,
        fail_count: certs.filter((c: any) => c.verdict === "FAIL").length,
        window: { from_ms: usedFromMs, to_ms: toMs, note: "certs outside this window need an explicit from_ms" },
        certificates: certs
      }, null, 2) }]
    }
  })

  server.registerTool("query_agent_trust", {
    title: "Query DJZS Agent Trust Score",
    description: `Query an agent's DJZS trust score, aggregated on-chain (Base mainnet) from its audit history and indexed via the DJZS subgraph. USE BEFORE delegating work, releasing escrow, or executing agent transactions. Returns totalAudits, pass/fail counts, failRate, latest verdict/risk, and DJZS-S01/DJZS-X01 flag counts. HALT if failRate > 0.3 or DJZS-S01/DJZS-X01 fired more than once.`,
    inputSchema: {
      agentAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").describe("Agent wallet address (0x-prefixed)")
    }
  }, async ({ agentAddress }) => {
    const jsonText = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] })
    if (!env.SUBGRAPH_URL) {
      return { ...jsonText({ status: "unavailable", detail: "SUBGRAPH_URL not configured on this Worker; trust index not wired." }), isError: true }
    }
    const id = agentAddress.toLowerCase()
    const query = `query($id: ID!) {
      agent(id: $id) {
        id totalAudits passCount failCount latestVerdict latestRiskScore
        flags(first: 1000) { code }
      }
    }`
    let agent: Record<string, unknown> | null
    try {
      const resp = await fetch(env.SUBGRAPH_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { id } })
      })
      if (!resp.ok) return { ...jsonText({ status: "error", detail: `subgraph HTTP ${resp.status}` }), isError: true }
      const j = await resp.json() as { data?: { agent: Record<string, unknown> | null }, errors?: unknown[] }
      if (j.errors?.length) return { ...jsonText({ status: "error", detail: `subgraph GraphQL errors: ${JSON.stringify(j.errors).slice(0, 200)}` }), isError: true }
      agent = j.data?.agent ?? null
    } catch (e) {
      return { ...jsonText({ status: "error", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) }), isError: true }
    }

    if (!agent) {
      // No history is NOT a silent PASS: the caller has no basis to trust yet.
      return jsonText({ agent: id, status: "no_history", trust: "unknown", action: "NO_HISTORY",
        message: "No DJZS audit history for this agent; nothing to trust or distrust yet." })
    }

    const totalAudits = Number(agent.totalAudits ?? 0)
    const passCount = Number(agent.passCount ?? 0)
    const failCount = Number(agent.failCount ?? 0)
    const failRate = totalAudits > 0 ? failCount / totalAudits : 0
    const codes = Array.isArray(agent.flags) ? (agent.flags as Array<{ code: string }>).map((f) => f.code) : []
    const s01 = codes.filter((c) => c === "DJZS-S01").length
    const x01 = codes.filter((c) => c === "DJZS-X01").length
    const halt = failRate > 0.3 || s01 > 1 || x01 > 1
    return jsonText({
      agent: id,
      totalAudits, passCount, failCount,
      failRate: Number(failRate.toFixed(4)),
      latestVerdict: agent.latestVerdict ?? "unknown",
      latestRiskScore: Number(agent.latestRiskScore ?? 0),
      flag_counts: { "DJZS-S01": s01, "DJZS-X01": x01 },
      action: halt ? "HALT" : "PROCEED",
      halt_rule: "HALT if failRate > 0.3 or DJZS-S01/DJZS-X01 fired more than once",
      ...(halt ? { halt_reason: `failRate ${failRate.toFixed(2)}${s01 > 1 ? `, S01 x${s01}` : ""}${x01 > 1 ? `, X01 x${x01}` : ""}` } : {})
    })
  })

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
      target_system: z.string().min(1).max(128).optional()
        .describe("Optional agent/project identifier; becomes the Target-System tag on the anchored PoL certificate"),
      // D1 ruling 2026-07-16: optional 0x agent wallet. Present => this audit's
      // verdict is written on-chain to that agent's DJZS trust score (fail-open,
      // after the cert anchors). Absent => Irys cert only, no on-chain score.
      // Never touches the verdict_hash preimage.
      agent_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").optional()
        .describe("Optional agent wallet (0x). If set, this audit updates that agent's on-chain DJZS trust score")
    },
    { title: "Verify Prediction-Market Trade Thesis (DJZS pre-execution audit)" },
    async ({ intent, target_system, agent_address }) => {
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
              targetSystem: target_system,
              auditId: crypto.randomUUID(),
              issuedAtMs: Date.now()
            },
            env.IRYS_UPLOAD_KEY,
            buildIrysUploadFn(nodeUrl)
          )
          pol_certificate = { status: "anchored", node: nodeUrl, ...anchored }
        } catch (e) {
          pol_certificate = {
            status: "error",
            detail: (e instanceof Error ? e.message : String(e)).slice(0, 300)
          }
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
    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] }
    }
  )

  // S6a — top-level title, alongside the annotations.title kept above.
  verifyPmTradeTool.update({
    title: "Verify Prediction-Market Trade Thesis (DJZS pre-execution audit)",
  })

  return server
}

const app = new Hono<{ Bindings: Env }>()

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
        return { configured: true, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) }
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
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: true,
      network_supported: false,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200)
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
    return c.json({ status: "error", detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, 502)
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
// Known classes map to fixed strings; unknowns get URLs stripped to host and
// user@host tokens removed, hard-capped. Raw messages can carry the RPC URL
// (which embeds the API key) or pasted terminal content - both have happened.
const classifyRpcError = (s: unknown): string => {
  const t = String(s ?? "")
  if (!t) return "ok"
  if (/rate limit|429/i.test(t)) return "rpc error: over rate limit"
  if (/invalid url/i.test(t)) return "config error: BASE_RPC_URL malformed"
  if (/timeout|timed out/i.test(t)) return "rpc error: timeout"
  if (/401|403|unauthorized|authenticated/i.test(t)) return "rpc error: auth rejected by provider"
  if (/nonce/i.test(t)) return "rpc error: nonce conflict"
  const scrubbed = t
    .replace(/(https?:\/\/[^\/\s"']+)[^\s"']*/g, "$1/[redacted]")
    .replace(/\S+@\S+/g, "[redacted]")
    .slice(0, 80)
  return "rpc error: " + scrubbed
}

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
  target_system: string | undefined,
  agent_address: string | undefined,
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
        { result, intent, targetSystem: target_system, auditId: crypto.randomUUID(), issuedAtMs: Date.now() },
        env.IRYS_UPLOAD_KEY,
        buildIrysUploadFn(nodeUrl),
      )
      pol_certificate = { status: "anchored", node: nodeUrl, ...anchored }
    } catch (e) {
      pol_certificate = { status: "error", detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
    }
  }

  let trust_score: Record<string, unknown> | undefined
  if (agent_address) {
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
    "title": "DJZS Protocol — verify_pm_trade",
    "version": "1.0.0",
    "summary": "Deterministic pre-execution audit of a prediction-market trade thesis.",
    "description": "DJZS audits the thesis, not the transaction. Wallet-layer tooling checks whether a transfer is safe; nothing checks whether the reasoning behind it holds. verify_pm_trade extracts the claims from a free-text trade thesis and scores them against a frozen taxonomy (narrative/resolution gap, falsification absent, probability unsourced, consensus-as-edge), returning a verdict, the codes that fired, a risk score, and a hash anyone can recompute from the submitted text. Out-of-scope requests are refused free: no payment settles.",
    "contact": {
      "name": "DJZS AI, LLC",
      "email": "username@djzs.ai",
      "url": "https://djzs.ai"
    },
    "license": { "name": "MIT" },
    "x-guidance": "Submit the reasoning behind a prospective prediction-market position as free text in the `intent` field. A well-formed thesis states the claim and its outcome, a SOURCED probability with a citation, the falsification condition, and the edge versus the market price. A consensus-only thesis with no source returns FAIL (DJZS-M03 PROBABILITY_UNSOURCED) and no order should be placed. Abstention is a first-class outcome. The audit reads reasoning only: it does not read markets, verify quoted prices, or check whether an instrument has already settled. Informational only, not financial advice — see https://djzs.ai/legal."
  },
  "servers": [
    { "url": "https://mcp.djzs.ai", "description": "Production (Base mainnet)" }
  ],
  "paths": {
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
                      "description": "ProofOfLogic anchoring outcome. Fails open by design — an anchoring failure annotates the response and never blocks or mutates the verdict, so handle all three variants.",
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
                      "description": "On-chain trust-record write outcome. Present only when agent_address was supplied. Fails open like pol_certificate — skipped is the common case, so handle all three variants.",
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

app.get("/openapi.json", (c) => c.json(OPENAPI_DOC))

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
    return c.json({ error: "FACILITATOR_UNAVAILABLE", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) }, 503)
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
    if (!vr.isValid) return paymentRequired(vr.invalidReason ?? "INVALID_PAYMENT", { payer: vr.payer })
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
  let body: { intent?: unknown; agent_address?: unknown; target_system?: unknown }
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
  const target_system = typeof body.target_system === "string" ? body.target_system : undefined

  // ── the audit runs first. ─────────────────────────────────────────────────
  if (!env.ANTHROPIC_API_KEY) {
    return c.json({ error: "EXTRACTION_UNAVAILABLE", detail: "ANTHROPIC_API_KEY not configured" }, 503)
  }
  let result: Record<string, unknown>
  try {
    result = (await runVerifyPmTrade(intent, buildAnthropicModelFn(env.ANTHROPIC_API_KEY))) as unknown as Record<string, unknown>
  } catch (e) {
    // Handler failure is NOT the payer's fault: refuse and do not settle.
    return paymentRequired("AUDIT_FAILED", { detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
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
    return paymentRequired("SETTLEMENT_FAILED", { detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
  }
  if (!settle.success) return paymentRequired(settle.errorReason ?? "SETTLEMENT_FAILED")

  const { pol_certificate, trust_score } = await anchorAndScore(env, result, intent, target_system, agent_address)

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
    ATTESTER_KEY: env.DJZS_ATTESTER_KEY,
    BASE_RPC_URL: env.BASE_RPC_URL,
  }
  try {
    return await handleX402VerifyPmTrade(c.req.raw, x402Env, createEngineAdapter(env))
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200)
    return c.json({ error: "AUDIT_UNAVAILABLE", detail, settled: false, charged: false }, 503)
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
  },
}
