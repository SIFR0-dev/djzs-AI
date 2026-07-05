import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { z } from "zod"
import { VERIFY_PM_TRADE_INPUT, buildAnthropicModelFn, runVerifyPmTrade } from "./verify-pm-trade"

const IRYS_GRAPHQL_URL = "https://uploader.irys.xyz/graphql"

/** Worker bindings. ANTHROPIC_API_KEY is a wrangler SECRET (never in wrangler.toml). */
interface Env {
  ANTHROPIC_API_KEY?: string
}

/**
 * Build a fully-registered MCP server. Constructed PER REQUEST (see the /mcp route)
 * so tool handlers close over the request-time `env` — Workers secrets live only on
 * the env binding, never on module scope. The two registry tools are env-independent
 * and behave identically to before; verify_pm_trade needs env.ANTHROPIC_API_KEY.
 */
function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "djzs-trust-mcp", version: "1.0.0" })

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

  server.registerTool("verify_pm_trade", {
    title: "Verify Prediction-Market Trade Thesis (DJZS pre-execution audit)",
    description: `Deterministic pre-execution audit of a prediction-market trade thesis. Extracts the reasoning, audits it against the calibrated DJZS-M taxonomy (M01 narrative/resolution gap, M02 falsification absent, M03 probability unsourced, M04 consensus-as-edge advisory), and returns PASS→PROCEED, FAIL, or WAIT→HALT with flagged defects and a reproducible verdict_hash. Audit before act.`,
    inputSchema: VERIFY_PM_TRADE_INPUT
  }, async ({ intent }) => {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
  })

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
