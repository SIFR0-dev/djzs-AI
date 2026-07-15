import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { z } from "zod"
import { VERIFY_PM_TRADE_INPUT, buildAnthropicModelFn, runVerifyPmTrade } from "./verify-pm-trade"
import { anchorPolCertificate, buildIrysUploadFn } from "./pol-certificate"
import { withX402, normalizeNetwork } from "agents/x402"
import { createFacilitatorConfig } from "@coinbase/x402"
import { HTTPFacilitatorClient } from "@x402/core/server"

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
 * PRICE 0.25 USDC per audit (2026-07-12).
 * NETWORK: "base" = Base MAINNET, eip155:8453 (A11 Stage 3, 2026-07-14). CDP
 * settles it (proven via /supported); mainnet Irys anchoring proven in
 * isolation (cert 747n8SZq..., A11 Stage 2). Rehearse locally with one real
 * 0.25 USDC payment (pol-paid-call --network base) BEFORE any production
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
const VERIFY_PM_TRADE_PRICE_USD = 0.25

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
  /** CDP facilitator API key id (A10). SECRET, request-scoped. Absent => paid tool cannot settle. */
  CDP_API_KEY_ID?: string
  /** CDP facilitator API key secret (A10). SECRET, request-scoped. Never module-scope. */
  CDP_API_KEY_SECRET?: string
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
      from_ms: z.number().int().optional().describe("Window start (epoch ms). Defaults to 180 days ago; widen to reach older certificates."),
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

    // Irys mainnet GraphQL REQUIRES a timestamp window or it times out (proven
    // live 2026-07-15 the moment anchoring moved to mainnet; ab9c1d1 hardening,
    // addenda-8 patch, finally applied). Trailing 180-day default, caller-overridable.
    const now = Date.now()
    const fromMs = from_ms ?? now - 180 * 24 * 3600 * 1000
    const toMs = to_ms ?? now + 3600 * 1000
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

    if (!response.ok) return { content: [{ type: "text" as const, text: `Irys error: ${response.status}` }], isError: true }

    const { data, errors } = await response.json() as any
    if (errors?.length) return { content: [{ type: "text" as const, text: `GraphQL errors: ${JSON.stringify(errors)}` }], isError: true }

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
        certificates: certs
      }, null, 2) }]
    }
  })

  server.registerTool("query_agent_trust", {
    title: "Query DJZS Agent Trust Score",
    description: `Query DJZS agent trust scores on Base Mainnet. USE BEFORE delegating work, releasing escrow, or executing agent transactions. HALT if failRate > 0.3 or DJZS-S01/DJZS-X01 triggered more than once. NOTE: Returns placeholder until DJZS subgraph is deployed to The Graph Network.`,
    inputSchema: {
      agentAddress: z.string().describe("Agent wallet address (0x-prefixed)")
    }
  }, async ({ agentAddress }) => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: "pending_subgraph_deploy",
        agent: agentAddress,
        message: "query_agent_trust activates after DJZS subgraph deployment to The Graph Network",
        action: "Use query_pol_certificates to check Irys audit history in the meantime"
      }, null, 2) }]
    }
  })

  // Step 2 (Path B ruling 2026-07-12): the ONLY paid tool. The handler body is
  // the Step 1 handler byte-identical; withX402 owns the 402/verify/settle
  // cycle in-band, and the free registry tools above are untouched.
  server.paidTool(
    "verify_pm_trade",
    // ASCII ONLY in this description: it travels inside the x402 payment
    // resource, and the agents client wrapper base64-encodes the payment
    // payload with bare btoa, which throws "Invalid character" on any code
    // point above 0xFF (rehearsal finding 2026-07-12; U+2192 arrows crashed
    // every agents-based payer). Upstream bug candidate; ruled: paid-tool
    // descriptions stay ASCII.
    `Deterministic pre-execution audit of a prediction-market trade thesis. Extracts the reasoning, audits it against the calibrated DJZS-M taxonomy (M01 narrative/resolution gap, M02 falsification absent, M03 probability unsourced, M04 consensus-as-edge advisory), and returns PASS->PROCEED, FAIL, or WAIT->HALT with flagged defects and a reproducible verdict_hash. Audit before act. Paid tool: ${VERIFY_PM_TRADE_PRICE_USD} USDC per audit via x402.`,
    VERIFY_PM_TRADE_PRICE_USD,
    {
      ...VERIFY_PM_TRADE_INPUT,
      // D4 ruling 2026-07-12: optional; feeds ONLY the Target-System tag on the
      // anchored certificate. Extraction input and hash preimage untouched.
      target_system: z.string().min(1).max(128).optional()
        .describe("Optional agent/project identifier; becomes the Target-System tag on the anchored PoL certificate")
    },
    { title: "Verify Prediction-Market Trade Thesis (DJZS pre-execution audit)" },
    async ({ intent, target_system }) => {
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

    const response = pol_certificate ? { ...result, pol_certificate } : result
    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] }
    }
  )

  return server
}

const app = new Hono<{ Bindings: Env }>()
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
    const kinds = (supported?.kinds ?? []) as Array<{ network?: string }>
    const networkSupported = kinds.some((k) => k.network === caip2)
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: true,
      network_supported: networkSupported,
      advertised_networks: [...new Set(kinds.map((k) => k.network).filter(Boolean))]
    }, networkSupported ? 200 : 502)
  } catch (e) {
    return c.json({
      network: X402_NETWORK, caip2, facilitator_configured: true,
      network_supported: false,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200)
    }, 502)
  }
})

export default app
