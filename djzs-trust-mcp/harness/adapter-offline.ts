/**
 * Offline harness for the Bazaar route: engine-adapter.ts + the payment ORDERING
 * invariants of http-x402-bazaar.v2.ts. ZERO keys, ZERO egress — the model is a
 * stub and the facilitator is a loopback HTTP server on 127.0.0.1 that only ever
 * answers /supported. No mainnet, no USDC, no CDP.
 *
 * Run from the repo root:
 *   npx tsx djzs-trust-mcp/harness/adapter-offline.ts
 * Exit 0 => every numbered check passed, final line "ADAPTER OFFLINE HARNESS: PASS".
 * Exit 1 => a numbered check failed.
 *
 * What it pins:
 *   - one scope truth (scopeCheck agrees with the /mcp pipeline's own in_scope)
 *   - one extraction per request (3 model calls for scopeCheck + audit, not 6)
 *   - the verdict passes through the engine untransformed, verdict_hash included
 *   - A1: an unpaid probe gets 402 whatever the body is — never 400
 *   - A2: amount and the EIP-712 `extra.name` are COMPUTED, not hand-written
 *   - A3: the resource server is built per request, not cached in module scope
 */
import { createServer, type Server } from "node:http"
import { createEngineAdapter, renderIntentText, intentSha256 } from "../src/engine-adapter"
import { runVerifyPmTrade } from "../src/verify-pm-trade"
import { sha256Hex } from "../../server/engine-v2/hash"
import {
  handleX402VerifyPmTrade,
  NETWORK,
  PAY_TO,
  USDC_BASE,
  EXPECTED_ATOMIC_AMOUNT,
  type X402Env,
} from "../src/http-x402-bazaar.v2"

let checks = 0
function check(n: number, name: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) {
    console.error(`CHECK ${n} FAIL: ${name}${detail ? ` :: ${detail}` : ""}`)
    process.exit(1)
  }
  console.log(`CHECK ${n} ok: ${name}`)
}

const PM_INTENT = {
  market: "KXBTC-26AUG29-T70000",
  side: "YES",
  thesis: "BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it",
  probability_basis: "gut feel, roughly a 60 percent chance",
  size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
}

const PERP_INTENT = {
  market: "BTC-PERP",
  side: "LONG",
  thesis: "Open 20x leverage long on BTC perpetuals and ride it, no stop",
}

/** Deterministic stub model. Returns the same extraction for every sample (N=3). */
function stubModel(payload: Record<string, unknown>): { fn: (p: string) => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    fn: async () => {
      calls++
      return JSON.stringify(payload)
    },
    calls: () => calls,
  }
}

const PM_EXTRACTION = {
  agent_type: "trader",
  intended_action: "buy YES on KXBTC-26AUG29-T70000",
  audit_context: "prediction_market",
  leverage: { state: "absent" },
  position_size: { state: "present", value: 250 },
  stop_loss: { state: "present", value: "daily close below 66000" },
  take_profit: { state: "unknown" },
  invalidation_condition: { state: "present", value: "daily close below 66000" },
  resolution_engagement: { state: "unknown" },
  probability_basis: { state: "absent", quote: "gut feel, roughly a 60 percent chance" },
  edge_claim: { state: "absent", quote: "everyone knows it" },
  data_sources: { state: "unknown" },
  oracle_source: { state: "unknown" },
  confidence: { state: "unknown" },
}

const PERP_EXTRACTION = { ...PM_EXTRACTION, audit_context: "perp" }

/**
 * Loopback facilitator. Answers /supported with the one kind this route needs and
 * COUNTS every path it is asked for — so the harness can prove that an unpaid probe
 * never reaches /verify or /settle, and that each request builds its own server.
 */
interface StubFacilitator {
  url: string
  hits: Record<string, number>
  close: () => Promise<void>
}

async function startFacilitator(): Promise<StubFacilitator> {
  const hits: Record<string, number> = { supported: 0, verify: 0, settle: 0 }
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0].replace(/^.*\//, "")
    hits[path] = (hits[path] ?? 0) + 1
    if (path === "supported") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
          extensions: [],
          signers: {},
        }),
      )
      return
    }
    // Nothing else should ever be called in this harness.
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "stub facilitator: unexpected path " + path }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("could not bind loopback facilitator")
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function main(): Promise<void> {
  // ══ PART 1 — engine adapter ═══════════════════════════════════════════════

  // --- 1. determinism of the object -> text bridge ---
  const permuted = {
    bounds: PM_INTENT.bounds,
    thesis: PM_INTENT.thesis,
    side: PM_INTENT.side,
    size_usd: PM_INTENT.size_usd,
    probability_basis: PM_INTENT.probability_basis,
    market: PM_INTENT.market,
  }
  check(1, "renderIntentText is key-order independent", renderIntentText(PM_INTENT) === renderIntentText(permuted))
  check(
    2,
    "intent_sha256 = sha256Hex(rendered text) — the same preimage pol-certificate hashes",
    intentSha256(PM_INTENT) === sha256Hex(renderIntentText(PM_INTENT)),
  )

  // --- 2. in-scope: one extraction serves both scopeCheck and audit ---
  const pm = stubModel(PM_EXTRACTION)
  const adapter = createEngineAdapter({}, pm.fn)
  const scope = await adapter.scopeCheck(PM_INTENT)
  check(3, "PM intent is in scope", scope.inScope === true, JSON.stringify(scope))
  const afterScope = pm.calls()
  check(4, "scopeCheck ran exactly one N=3 consensus extraction", afterScope === 3, `calls=${afterScope}`)
  const verdict = await adapter.audit(PM_INTENT)
  check(5, "audit() reused the memoised extraction (no second spend)", pm.calls() === 3, `calls=${pm.calls()}`)

  // --- 3. the verdict contract ---
  check(6, "verdict is a member of the engine's three-valued set", ["PASS", "WAIT", "FAIL"].includes(verdict.verdict))
  check(7, "risk_score is numeric", typeof verdict.risk_score === "number")
  check(8, "flags is a string list", Array.isArray(verdict.flags) && verdict.flags.every((f) => typeof f === "string"))
  check(9, "verdict_hash is a 0x sha256", /^0x[0-9a-f]{64}$/.test(verdict.verdict_hash), verdict.verdict_hash)
  check(10, "intent_sha256 binds this intent", verdict.intent_sha256 === intentSha256(PM_INTENT))

  // --- 4. pass-through: the adapter transforms nothing the engine decided ---
  const direct = (await runVerifyPmTrade(renderIntentText(PM_INTENT), stubModel(PM_EXTRACTION).fn)) as Record<
    string,
    unknown
  >
  check(11, "verdict_hash is the engine's, byte-identical", verdict.verdict_hash === direct.verdict_hash)
  check(12, "verdict is the engine's", verdict.verdict === direct.verdict)
  check(13, "risk_score is the engine's", verdict.risk_score === direct.risk_score)
  const directCodes = (direct.flags as { code: string }[]).map((f) => f.code)
  const directUnknowns = (direct.unknown_fields as string[]).map((u) => `unknown:${u}`)
  check(
    14,
    "flags = engine codes then unknown fields",
    JSON.stringify(verdict.flags) === JSON.stringify([...directCodes, ...directUnknowns]),
    JSON.stringify(verdict.flags),
  )
  check(
    15,
    "flag strings are the engine's canonical ids (DJZS-Mxx), not a shortened second vocabulary",
    verdict.flags.filter((f) => !f.startsWith("unknown:")).every((f) => f.startsWith("DJZS-")),
    JSON.stringify(verdict.flags),
  )
  console.log(`      verdict=${verdict.verdict} risk=${verdict.risk_score} flags=${JSON.stringify(verdict.flags)}`)

  // --- 5. scope truth is the MCP transport's, not a copy ---
  const perp = stubModel(PERP_EXTRACTION)
  const perpAdapter = createEngineAdapter({}, perp.fn)
  const perpScope = await perpAdapter.scopeCheck(PERP_INTENT)
  const perpDirect = (await runVerifyPmTrade(renderIntentText(PERP_INTENT), stubModel(PERP_EXTRACTION).fn)) as Record<
    string,
    unknown
  >
  check(16, "non-PM intent is refused as out of scope", perpScope.inScope === false)
  check(
    17,
    "scopeCheck agrees with the /mcp pipeline's own in_scope, by construction",
    perpScope.inScope === (perpDirect.in_scope === true),
  )
  check(18, "refusal carries the pipeline's reason verbatim", perpScope.reason === perpDirect.reason)

  // --- 6. audit() enforces scope intrinsically, not by call order ---
  let threw = ""
  try {
    await perpAdapter.audit(PERP_INTENT)
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check(19, "audit() on an out-of-scope intent throws", threw.startsWith("OUT_OF_SCOPE"), threw)

  // --- 7. missing key fails closed, and fails in scopeCheck (uncharged) ---
  let keyErr = ""
  try {
    await createEngineAdapter({}).scopeCheck(PM_INTENT)
  } catch (e) {
    keyErr = e instanceof Error ? e.message : String(e)
  }
  check(
    20,
    "no ANTHROPIC_API_KEY => scopeCheck refuses before any settlement",
    keyErr.startsWith("EXTRACTION_UNAVAILABLE"),
    keyErr,
  )

  // ══ PART 2 — route ordering and the computed challenge ════════════════════
  const fac = await startFacilitator()
  const env: X402Env = { FACILITATOR_URL: fac.url }
  // An adapter that would EXPLODE if the route ever reached it on an unpaid probe.
  const forbiddenAdapter = createEngineAdapter({}, async () => {
    throw new Error("engine reached on an unpaid probe")
  })

  try {
    // --- 8. A1: empty body, no payment header => 402, never 400 ---
    const probe = await handleX402VerifyPmTrade(
      new Request("https://mcp.djzs.ai/x402/verify_pm_trade", { method: "POST", body: "" }),
      env,
      forbiddenAdapter,
    )
    check(21, "unpaid probe with an EMPTY body gets 402", probe.status === 402, `status=${probe.status}`)
    check(22, "the 402 carries a PAYMENT-REQUIRED header", probe.headers.get("PAYMENT-REQUIRED") !== null)
    const challenge = (await probe.json()) as { accepts?: Record<string, unknown>[]; x402Version?: number }
    const accepts = challenge.accepts?.[0] ?? {}
    check(23, "challenge declares x402Version 2", challenge.x402Version === 2, JSON.stringify(challenge.x402Version))

    // --- 9. A2: the money fields are COMPUTED and match what this route intends ---
    check(24, `computed amount is ${EXPECTED_ATOMIC_AMOUNT}`, accepts.amount === EXPECTED_ATOMIC_AMOUNT, String(accepts.amount))
    check(25, "computed asset is Base USDC", String(accepts.asset).toLowerCase() === USDC_BASE.toLowerCase(), String(accepts.asset))
    check(26, "payTo is the treasury constant", accepts.payTo === PAY_TO, String(accepts.payTo))
    check(27, `network is ${NETWORK}`, accepts.network === NETWORK, String(accepts.network))
    check(
      28,
      'EIP-712 domain name computed as "USD Coin" (mainnet), not hand-written',
      (accepts.extra as Record<string, unknown> | undefined)?.name === "USD Coin",
      JSON.stringify(accepts.extra),
    )
    check(
      29,
      "our termsOfService survives the merge without clobbering the computed extra",
      (accepts.extra as Record<string, unknown> | undefined)?.termsOfService === "https://djzs.ai/terms",
      JSON.stringify(accepts.extra),
    )

    // --- 10. A1 again: a body that is not even JSON still gets the challenge ---
    const junk = await handleX402VerifyPmTrade(
      new Request("https://mcp.djzs.ai/x402/verify_pm_trade", { method: "POST", body: "<<not json>>" }),
      env,
      forbiddenAdapter,
    )
    check(30, "unpaid probe with a NON-JSON body gets 402", junk.status === 402, `status=${junk.status}`)

    // --- 11. no unpaid probe ever touched the money path ---
    check(31, "facilitator /verify never called on unpaid probes", fac.hits.verify === 0, `hits=${fac.hits.verify}`)
    check(32, "facilitator /settle never called on unpaid probes", fac.hits.settle === 0, `hits=${fac.hits.settle}`)

    // --- 12. A3: per-request construction, no module-scope cache ---
    check(
      33,
      "each request initialised its own resource server (no module-scope singleton)",
      fac.hits.supported === 2,
      `supported hits=${fac.hits.supported} for 2 requests`,
    )

    // --- 13. a malformed payment header is refused before body or engine ---
    const badPay = await handleX402VerifyPmTrade(
      new Request("https://mcp.djzs.ai/x402/verify_pm_trade", {
        method: "POST",
        body: "",
        headers: { "X-PAYMENT": "not-a-payment" },
      }),
      env,
      forbiddenAdapter,
    )
    check(34, "malformed payment header => 400, engine untouched", badPay.status === 400, `status=${badPay.status}`)
    check(35, "still nothing settled", fac.hits.settle === 0, `hits=${fac.hits.settle}`)
  } finally {
    await fac.close()
  }

  console.log(`\nADAPTER OFFLINE HARNESS: PASS (${checks} checks)`)
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e)
  process.exit(1)
})
