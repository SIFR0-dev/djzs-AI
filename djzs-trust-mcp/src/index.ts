import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { z } from "zod"
import { VERIFY_PM_TRADE_INPUT, buildAnthropicModelFn, runVerifyPmTrade } from "./verify-pm-trade"
import { anchorPolCertificate, buildIrysUploadFn } from "./pol-certificate"
import { withX402 } from "agents/x402"

const IRYS_GRAPHQL_URL = "https://uploader.irys.xyz/graphql"
/**
 * PoL write target (Step 1, D3 ruling 2026-07-12: devnet first). Deliberate
 * asymmetry: the GraphQL query side above reads the MAINNET uploader index, so
 * devnet certs are NOT visible to query_pol_certificates. Mainnet cutover is
 * one [vars] flip (IRYS_NODE_URL) plus a funded key, sequenced by DJ.
 */
const DEFAULT_IRYS_NODE_URL = "https://devnet.irys.xyz"

/**
 * x402 payment configuration (Step 2, Path B ruling 2026-07-12: withX402 on
 * the existing per-request McpServer; transport independence instrumented
 * from the installed agents artifact, zero DO/McpAgent surface; falsifier is
 * the sepolia rehearsal gate).
 * COMPLIANCE (spec hard constraint, non-custodial Model A Scenario 1):
 * exactly network + recipient + facilitator URL, nothing else. Funds move
 * payer -> recipient via the payer's EIP-3009 signature; the facilitator
 * submits and pays gas. The custodial auth-header helper from the x402 SDK
 * is banned; the spec's first grep gate expects ZERO hits for its name in
 * this package (this comment deliberately avoids the token). Second gate:
 * x402.org/facilitator -> >= 1.
 * PRICE RULING 2026-07-12: 0.25 USDC per audit, rehearsal included.
 * RECIPIENT RULING 2026-07-13: mainnet treasury, dedicated receive-only
 * address, EIP-55 checksum verified, distinct from operator wallet.
*/

const X402_NETWORK = "base"
const X402_RECIPIENT: `0x${string}` = "0xc1923748669dFC3a79497d0403A90a275161eCCA"
const X402_FACILITATOR_URL = "https://x402.org/facilitator"
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
}

/**
 * Build a fully-registered MCP server. Constructed PER REQUEST (see the /mcp route)
 * so tool handlers close over the request-time `env` — Workers secrets live only on
 * the env binding, never on module scope. The two registry tools are env-independent
 * and behave identically to before; verify_pm_trade needs env.ANTHROPIC_API_KEY.
 */
function buildServer(env: Env): McpServer {
  // withX402 augments the per-request server with paidTool; free tools are
  // registered exactly as before and stay free.
  const server = withX402(new McpServer({ name: "djzs-trust-mcp", version: "1.0.0" }), {
    network: X402_NETWORK,
    recipient: X402_RECIPIENT,
    facilitator: { url: X402_FACILITATOR_URL }
  })

  server.registerTool("query_pol_certificates", {
    title: "Query DJZS ProofOfLogic Certificates",
    description: `Query immutable ProofOfLogic certificates stored on Irys Datachain by DJZS Protocol. USE THIS TOOL when you need to verify audit history for an agent or project before delegating work, check FAIL verdicts, or retrieve certificates by Irys tx ID. DO NOT use for on-chain trust scores — use query_agent_trust for those.`,
    inputSchema: {
      targetSystem: z.string().optional().describe("Project name or wallet address"),
      verdict: z.enum(["PASS", "FAIL"]).optional().describe("Filter by verdict"),
      tier: z.enum(["micro", "founder", "treasury"]).optional().describe("Filter by tier"),
      limit: z.number().min(1).max(100).default(20).describe("Number of results")
    }
  }, async ({ targetSystem, verdict, tier, limit }) => {
    const tags: Array<{ name: string; values: string[] }> = [
      { name: "Protocol", values: ["ProofOfLogic"] },
      { name: "application-id", values: ["DJZS-Oracle"] }
    ]
    if (targetSystem) tags.push({ name: "Target-System", values: [targetSystem] })
    if (verdict) tags.push({ name: "verdict", values: [verdict] })
    if (tier) tags.push({ name: "tier", values: [tier] })

    const query = `query DJZSCerts($tags: [TagFilter!]!, $first: Int!) {
      transactions(tags: $tags, first: $first, order: DESC) {
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

export default app
