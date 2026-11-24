/**
 * free-check-tool.ts - the MCP tool `check_thesis`: the free check, for a client that has no wallet.
 *
 * WHY. The two audit tools on this server cost 2.00 USDC over x402. A chat app or a hosted agent runtime
 * (ChatGPT, the OpenAI Agents SDK's hosted MCP tool, Gemini) cannot sign a payment, so until now such a client
 * could connect and then do nothing but hit a payment demand. This tool gives it the verdict the home page gives:
 * the same pipeline as POST /try/verdict (one extraction, TypeScript decides), the same ruleset, the same
 * verdict fields. Nothing is attested, nothing is anchored, no money moves. The receipt stays a paid product.
 *
 * HOW. It calls handleTryVerdict in-process with the shared MCP quota row (try-route.ts). No second pipeline,
 * no second set of rules: whatever /try returns for {kind, intent:{thesis}} is what this returns.
 *
 * LIMITS. All MCP callers share TRY_MCP_DAILY_LIMIT free checks a day (default 60), inside the global free cap.
 * Past either, the answer says so and names the paid tools. A refusal here is a normal tool result with
 * isError, never a thrown error.
 */
import type { ModelFn } from "../../server/engine-v2/extraction-layer"
import { handleTryVerdict, mcpDailyLimit, TRY_MCP_QUOTA_KEY, type TryEnv } from "./try-route"

export const CHECK_THESIS_KINDS = ["prediction_market", "perp_or_spot"] as const
export type CheckThesisKind = (typeof CHECK_THESIS_KINDS)[number]
export const CHECK_THESIS_MIN = 20
export const CHECK_THESIS_MAX = 3500

// ASCII only, like every tool description on this server (a non-ASCII byte crashed x402 payers once).
export const CHECK_THESIS_DESCRIPTION =
  "FREE check of a trade thesis, no wallet and no payment. Send the thesis in the user's own words and say whether it is a " +
  "prediction-market bet or a perp/spot trade. Returns PASS, WAIT or FAIL with the reasons, the same verdict the paid audit " +
  "computes (same rules, same engine). It does NOT write a receipt: nothing is attested on-chain and nothing can be shown to a " +
  "counterparty. For a receipt use verify_pm_trade or verify_perp_trade (2.00 USDC via x402). USE THIS TOOL when the user wants " +
  "to test a thesis before trading and the client cannot pay, or before deciding whether a paid receipt is worth it. " +
  "Shared daily limit across all callers; when it is used up the result says so. " +
  "A verdict grades whether the reasoning is stated, falsifiable and bounded. It does not predict the outcome and is not advice."

// A type alias, not an interface: the SDK's tool result has an index signature, which only an alias satisfies.
export type CheckThesisResult = {
  content: { type: "text"; text: string }[]
  structuredContent: Record<string, unknown>
  isError?: true
}

const out = (o: Record<string, unknown>, isError = false): CheckThesisResult =>
  ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }], structuredContent: o, ...(isError ? { isError: true as const } : {}) })

export async function runCheckThesis(args: { kind: CheckThesisKind; thesis: string }, env: TryEnv, modelFn?: ModelFn): Promise<CheckThesisResult> {
  const kind = args.kind === "perp_or_spot" ? "perp" : "pm"
  const thesis = String(args.thesis ?? "").trim()
  const request = new Request("https://mcp.djzs.ai/try/verdict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, intent: { thesis } }),
  })
  const res = await handleTryVerdict(request, env, modelFn, { quotaKey: { id: TRY_MCP_QUOTA_KEY, limit: mcpDailyLimit(env) } })
  let body: Record<string, unknown>
  try { body = (await res.json()) as Record<string, unknown> } catch { body = { ok: false, error: "audit_unavailable" } }
  if (res.status === 200 && body.ok === true) {
    return out({
      status: "OK",
      free: true,
      attested: false,
      ...body,
      next: "This verdict is not a receipt. For one a counterparty can check, call verify_pm_trade or verify_perp_trade (2.00 USDC, x402 on Base).",
    })
  }
  if (res.status === 429) {
    return out({
      status: "LIMIT_REACHED",
      free: true,
      detail: "The free checks for today are used up. They reset at resets_at (UTC). The paid tools still work.",
      resets_at: body.resets_at ?? null,
      paid_tools: ["verify_pm_trade", "verify_perp_trade"],
      web: "https://djzs.ai",
    }, true)
  }
  return out({ status: "UNAVAILABLE", free: true, error: typeof body.error === "string" ? body.error : "audit_unavailable" }, true)
}
