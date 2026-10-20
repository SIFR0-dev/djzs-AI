/**
 * Offline harness for the PAID path of the plain-HTTP x402 route, both resources:
 * settle -> audit -> hash -> attest, driven through handleX402VerifyPmTrade exactly as
 * index.ts mounts it. ZERO keys, ZERO egress: the model is a stub, the facilitator and
 * the Base RPC are loopback servers (harness/x402-stubs.ts). The REAL attestVerdict
 * runs, so the bytes it would put on chain are observed, not assumed.
 *
 * Run from the repo root:
 *   npx tsx djzs-trust-mcp/harness/x402-route-offline.ts
 * Exit 0 => every numbered check passed, final line "X402 ROUTE OFFLINE HARNESS: PASS".
 * Exit 1 => a numbered check failed.
 *
 * adapter-offline.ts pins the UNPAID side (402 ordering, computed challenge). This file
 * pins what happens after a payment verifies:
 *
 *   PART 1 — the perp resource, driven with the example from its own 402 challenge
 *            (extensions.bazaar.info.input.body). A perp-shaped body used to settle and
 *            then throw in the PM-shaped hash step, charging the payer for no verdict.
 *   PART 2 — the PM resource end to end, anchored to the receipt published on
 *            djzs.ai/verify (a live, on-chain-attested vector — not derived from this code).
 *   PART 3 — money invariants: how many times money moved, and what a payer is told.
 *   PART 4 — failure honesty: a throw is classified by how far the request got (the
 *            SettlementTrace), and the REAL Hono routes in index.ts must never tell a payer
 *            "charged:false" once money may have moved.
 */
import { createEngineAdapter, intentSha256 } from "../src/engine-adapter"
import type { runVerifyPmTrade } from "../src/verify-pm-trade"
import { runVerifyPerpTrade } from "../src/verify-perp-trade"
import { toDJZSIntent, intentHash } from "../src/djzs-intent"
import { decodePaymentResponseHeader } from "@x402/core/http"
import { Hono } from "hono"
import {
  handleX402VerifyPmTrade,
  auditFailure,
  NETWORK,
  PM_RESOURCE,
  PERP_RESOURCE,
  type ResourceSpec,
  type EngineAdapter,
  type SettlementTrace,
  type SettlementState,
  type X402Env,
} from "../src/http-x402-bazaar.v2"
import {
  startFacilitator,
  startRpc,
  paymentHeader,
  testAttesterKey,
  PAYER,
  SETTLE_TX,
  type StubFacilitator,
  type StubRpc,
} from "./x402-stubs"

let checks = 0
function check(n: number, name: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) {
    console.error(`CHECK ${n} FAIL: ${name}${detail ? ` :: ${detail}` : ""}`)
    process.exit(1)
  }
  console.log(`CHECK ${n} ok: ${name}`)
}

/** A missing or garbled PAYMENT-RESPONSE must fail a NAMED check, not crash the harness. */
function decodeReceipt(header: string | null | undefined): Record<string, any> {
  try {
    return header ? (decodePaymentResponseHeader(header) as Record<string, any>) : {}
  } catch {
    return {}
  }
}

// The receipt djzs.ai/verify publishes as its sample. Its intent_hash is the binding key
// of the first live attestation on Base (EAS 0xc5995989…5a89), recomputed independently.
const PUBLISHED_PM = {
  intent: {
    market: "KXBTCD-26SEP0217-T76999.99",
    side: "YES",
    thesis:
      "BTC spot ~$77,263 (Coinbase 2026-09-01T20:08Z) sits ~0.34% above the $77,000 line; absent a close under $77,000 at the Sep 2 settlement, KXBTCD-26SEP0217-T76999.99 resolves YES.",
    probability_basis:
      "spot $77,263 vs $77,000 strike = +0.34% ITM; Kalshi book unquoted so implied N/A; model P(YES) approx 0.70; basis Coinbase spot 2026-09-01T20:08Z",
    size_usd: 250,
    bounds: { max_loss_usd: 250, exit_condition: "BTC hourly close below $77,000 on Coinbase before the Sep 2 settlement" },
  },
  intent_hash: "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb206",
  intent_sha256: "0x4534c5866286414064776749570932b24e88249d6d7885097370dd19167cc155",
}

const PM_EXTRACTION = {
  agent_type: "trader",
  intended_action: "buy YES",
  audit_context: "prediction_market",
  leverage: { state: "absent" },
  position_size: { state: "present", value: 250 },
  stop_loss: { state: "present", value: "BTC hourly close below $77,000" },
  take_profit: { state: "unknown" },
  invalidation_condition: { state: "present", value: "BTC hourly close below $77,000" },
  resolution_engagement: { state: "unknown" },
  probability_basis: { state: "present", value: "spot vs strike, Coinbase 2026-09-01T20:08Z" },
  edge_claim: { state: "unknown" },
  data_sources: { state: "unknown" },
  oracle_source: { state: "unknown" },
  confidence: { state: "unknown" },
}

const PERP_EXTRACTION = {
  agent_type: "trader",
  intended_action: "long BTC-PERP",
  audit_context: "perp",
  leverage: { state: "present", value: 5 },
  position_size: { state: "present", value: 3000 },
  stop_loss: { state: "present", value: 76200 },
  take_profit: { state: "present", value: 83000 },
  invalidation_condition: { state: "present", value: "daily close below 76,200" },
  resolution_engagement: { state: "unknown" },
  probability_basis: { state: "unknown" },
  edge_claim: { state: "unknown" },
  thesis_statement: { state: "present", value: "Funding reset after the weekend flush; 80K held on the daily close" },
  data_sources: { state: "unknown" },
  oracle_source: { state: "present", value: "Binance mark price" },
  confidence: { state: "unknown" },
}

const stub = (payload: Record<string, unknown>) => async () => JSON.stringify(payload)

/** The adapter exactly as index.ts builds it for each resource, with the model stubbed. */
const pmAdapter = (extraction: Record<string, unknown> = PM_EXTRACTION): EngineAdapter =>
  createEngineAdapter({}, stub(extraction))
const perpAdapter = (extraction: Record<string, unknown> = PERP_EXTRACTION): EngineAdapter =>
  createEngineAdapter({}, stub(extraction), runVerifyPerpTrade as unknown as typeof runVerifyPmTrade)

interface Paid {
  res: Response | null
  threw: string | null
  thrown: unknown
  body: Record<string, any>
  settleHits: number
  trace: SettlementTrace
}

/** A real client's sequence: unpaid probe for the challenge, then the paid POST. */
async function challengeOf(spec: ResourceSpec, env: X402Env): Promise<Record<string, any>> {
  const probe = await handleX402VerifyPmTrade(
    new Request(spec.url, { method: "POST", body: "" }),
    env,
    pmAdapter(),
    spec,
  )
  return (await probe.json()) as Record<string, any>
}

async function paid(spec: ResourceSpec, env: X402Env, fac: StubFacilitator, engine: EngineAdapter, body: unknown): Promise<Paid> {
  const challenge = await challengeOf(spec, env)
  const before = fac.hits.settle
  const trace: SettlementTrace = { state: "before_settle" }
  let res: Response | null = null
  let threw: string | null = null
  let thrown: unknown = null
  try {
    res = await handleX402VerifyPmTrade(
      new Request(spec.url, {
        method: "POST",
        headers: { "X-PAYMENT": paymentHeader(challenge) },
        body: JSON.stringify(body),
      }),
      env,
      engine,
      spec,
      trace,
    )
  } catch (e) {
    thrown = e
    threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  const text = res ? await res.text() : ""
  let parsed: Record<string, any> = {}
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { res, threw, thrown, body: parsed, settleHits: fac.hits.settle - before, trace }
}

async function main(): Promise<void> {
  const fac = await startFacilitator(NETWORK)
  const rpc: StubRpc = await startRpc()
  const env: X402Env = {
    FACILITATOR_URL: fac.url,
    ATTESTER_KEY: testAttesterKey(),
    BASE_RPC_URL: rpc.url,
  }

  try {
    // ══ PART 1 — perp resource, the example its own 402 challenge publishes ═══
    const perpChallenge = await challengeOf(PERP_RESOURCE, env)
    const published = perpChallenge.extensions?.bazaar?.info?.input?.body as { intent?: Record<string, unknown> } | undefined
    const perpIntent = published?.intent ?? {}
    check(1, "perp 402 challenge publishes an example request body", typeof published?.intent === "object", JSON.stringify(published))
    check(
      2,
      "the published perp example is perp-shaped: instrument, and NO `market`",
      typeof perpIntent.instrument === "string" && perpIntent.market === undefined,
      JSON.stringify(Object.keys(perpIntent)),
    )

    const perp = await paid(PERP_RESOURCE, env, fac, perpAdapter(), published)
    check(
      3,
      "the perp handler returns a response for a paid, in-scope, perp-shaped request (it does not throw after settlement)",
      perp.res !== null,
      `THREW AFTER SETTLEMENT: ${perp.threw} :: facilitator /settle hits=${perp.settleHits} (payer charged, no verdict)`,
    )
    check(4, "status 200", perp.res?.status === 200, `status=${perp.res?.status}`)
    check(5, "money moved exactly once", perp.settleHits === 1, `settle hits=${perp.settleHits}`)
    const receipt = decodeReceipt(perp.res?.headers.get("PAYMENT-RESPONSE"))
    check(
      6,
      "PAYMENT-RESPONSE carries the settlement receipt",
      receipt.success === true && receipt.transaction === SETTLE_TX && receipt.payer === PAYER && receipt.network === NETWORK,
      JSON.stringify(receipt),
    )
    check(7, "a verdict from the engine's three-valued set", ["PASS", "WAIT", "FAIL"].includes(perp.body.verdict), String(perp.body.verdict))
    check(8, "risk_score numeric, verdict_hash a 0x sha256", typeof perp.body.risk_score === "number" && /^0x[0-9a-f]{64}$/.test(perp.body.verdict_hash))
    check(9, "charged:true — and now there is a verdict to show for it", perp.body.charged === true)
    check(
      10,
      "intent_sha256 binds the FULL perp body",
      perp.body.intent_sha256 === intentSha256(perpIntent),
      String(perp.body.intent_sha256),
    )
    const leveraged = intentSha256({ ...perpIntent, leverage: 10 })
    check(11, "…and is sensitive to a perp-only field (leverage)", leveraged !== perp.body.intent_sha256)
    // The perp resource has no defined EIP-712 binding. It must say so, not borrow the PM
    // projection: that would put a permanent attestation on chain whose intentHash cannot
    // tell a 5x long from a 50x short.
    check(
      12,
      "perp has no defined intent_hash: null, with the reason on the receipt",
      perp.body.intent_hash === null && String(perp.body.eas_error).startsWith("intent_hash_unavailable"),
      JSON.stringify({ intent_hash: perp.body.intent_hash, eas_error: perp.body.eas_error }),
    )
    check(13, "…so nothing was attested on chain for it", perp.body.eas_uid === null && rpc.attestations.length === 0)

    // ══ PART 2 — PM resource end to end, anchored to the published receipt ═════
    const pm = await paid(PM_RESOURCE, env, fac, pmAdapter(), { intent: PUBLISHED_PM.intent })
    check(14, "PM: 200 with a verdict, charged once", pm.res?.status === 200 && pm.settleHits === 1 && pm.body.charged === true, pm.threw ?? `status=${pm.res?.status}`)
    check(
      15,
      "PM intent_sha256 == the value published on djzs.ai/verify",
      pm.body.intent_sha256 === PUBLISHED_PM.intent_sha256,
      String(pm.body.intent_sha256),
    )
    check(
      16,
      "PM intent_hash == the value published on djzs.ai/verify (live on-chain vector)",
      pm.body.intent_hash === PUBLISHED_PM.intent_hash,
      String(pm.body.intent_hash),
    )
    check(
      17,
      "…and equals an independent recompute from the intent alone",
      intentHash(toDJZSIntent(PUBLISHED_PM.intent)) === pm.body.intent_hash,
    )
    check(18, "PM was attested exactly once, with no eas_error", rpc.attestations.length === 1 && pm.body.eas_error === undefined && /^0x[0-9a-f]{64}$/.test(pm.body.eas_uid))
    const onChain = rpc.attestations[0]?.verdict
    check(
      19,
      "the intentHash decoded from the attest TRANSACTION == the response's intent_hash",
      onChain?.intentHash === pm.body.intent_hash,
      JSON.stringify({ onChain: onChain?.intentHash, response: pm.body.intent_hash }),
    )
    check(
      20,
      "the attested verdict/risk/flags/ruleset == the response",
      onChain?.verdict === pm.body.verdict &&
        onChain?.riskScore === pm.body.risk_score &&
        JSON.stringify(onChain?.flags) === JSON.stringify([...pm.body.flags].sort()) &&
        onChain?.rulesetVersion === "DJZS-PM-v1.0",
      JSON.stringify(onChain),
    )

    // ══ PART 3 — money invariants ═════════════════════════════════════════════
    // 3a. A perp body that happens to carry `market` used to hash through the PM projection.
    const attestedBefore = rpc.attestations.length
    const perpWithMarket = await paid(PERP_RESOURCE, env, fac, perpAdapter(), {
      intent: { ...perpIntent, market: "BTC-PERP" },
    })
    check(
      21,
      "perp body carrying `market`: still no PM-projected hash, no attestation",
      perpWithMarket.res?.status === 200 &&
        perpWithMarket.body.intent_hash === null &&
        rpc.attestations.length === attestedBefore,
      perpWithMarket.threw ?? JSON.stringify({ status: perpWithMarket.res?.status, intent_hash: perpWithMarket.body.intent_hash }),
    )

    // 3b. A malformed PM body (an object, no `market`) used to settle and then throw.
    const sparse = await paid(PM_RESOURCE, env, fac, pmAdapter(), {
      intent: { side: "YES", thesis: "BTC closes above 70000 because ETF inflows continue" },
    })
    check(
      22,
      "PM body missing `market`: a verdict, charged once, intent_hash null — not a charge with no verdict",
      sparse.res?.status === 200 &&
        sparse.settleHits === 1 &&
        sparse.body.intent_hash === null &&
        sparse.body.charged === true &&
        String(sparse.body.eas_error).startsWith("intent_hash_unavailable"),
      sparse.threw ?? JSON.stringify({ status: sparse.res?.status, settleHits: sparse.settleHits, body: sparse.body }),
    )

    // 3c. The scope gate still precedes settlement: a PM bet sent to the perp resource is
    //     refused, uncharged, and money never moves.
    const refused = await paid(PERP_RESOURCE, env, fac, perpAdapter(PM_EXTRACTION), published)
    check(
      23,
      "scope refusal on the perp resource: REFUSED_SCOPE, uncharged, settle never called",
      refused.res?.status === 200 && refused.body.verdict === "REFUSED_SCOPE" && refused.body.charged === false && refused.settleHits === 0,
      refused.threw ?? JSON.stringify({ status: refused.res?.status, settleHits: refused.settleHits, body: refused.body }),
    )
    // ══ PART 4 — failure honesty ═════════════════════════════════════════════
    // A throw out of the handler reaches the route's catch. What the payer is told there must
    // be true for how far the request got. `auditFailure(trace, e)` is that body.
    const HISTORICAL_503 = (detail: string) =>
      JSON.stringify({ error: "AUDIT_UNAVAILABLE", detail, settled: false, charged: false })

    // 4a. The facilitator DEFINITIVELY refuses: nothing moved, and the historical body is true.
    fac.setSettle("reject")
    const refusedSettle = await paid(PM_RESOURCE, env, fac, pmAdapter(), { intent: PUBLISHED_PM.intent })
    const refusedBody = auditFailure(refusedSettle.trace, refusedSettle.thrown)
    check(
      24,
      "settle refused by the facilitator: state settle_refused, and the historical 503 body — byte-for-byte",
      refusedSettle.trace.state === "settle_refused" &&
        refusedBody.status === 503 &&
        JSON.stringify(refusedBody.body) === HISTORICAL_503("insufficient_funds"),
      JSON.stringify({ state: refusedSettle.trace.state, ...refusedBody }),
    )

    // 4b. The facilitator goes quiet mid-settle: funds MAY have moved. The old body said
    //     charged:false here, which nobody could know.
    fac.setSettle("uncertain")
    const uncertain = await paid(PM_RESOURCE, env, fac, pmAdapter(), { intent: PUBLISHED_PM.intent })
    const uncertainBody = auditFailure(uncertain.trace, uncertain.thrown)
    check(
      25,
      "settle outcome unknowable: state settle_in_flight, 502, settled:null charged:null — never charged:false",
      uncertain.trace.state === "settle_in_flight" &&
        uncertainBody.status === 502 &&
        uncertainBody.body.error === "SETTLEMENT_UNCERTAIN" &&
        uncertainBody.body.settled === null &&
        uncertainBody.body.charged === null,
      JSON.stringify({ state: uncertain.trace.state, ...uncertainBody }),
    )
    fac.setSettle("ok")

    // 4c. Something throws AFTER a successful settlement (here: reading the verdict while the
    //     response is built). The payer has been charged and must be told so, with the receipt.
    const exploding: EngineAdapter = {
      scopeCheck: async () => ({ inScope: true }),
      audit: async () =>
        ({
          verdict: "PASS",
          risk_score: 0,
          flags: [],
          intent_sha256: "0x00",
          get verdict_hash(): string {
            throw new Error("post-settlement failure")
          },
        }) as never,
    }
    const settledThrow = await paid(PM_RESOURCE, { FACILITATOR_URL: fac.url }, fac, exploding, { intent: PUBLISHED_PM.intent })
    const settledBody = auditFailure(settledThrow.trace, settledThrow.thrown)
    const settledReceipt = decodeReceipt(settledBody.headers?.["PAYMENT-RESPONSE"])
    check(
      26,
      "throw AFTER settlement: state settled, 500, charged:true settled:true, receipt attached, told not to retry",
      settledThrow.settleHits === 1 &&
        settledThrow.trace.state === "settled" &&
        settledBody.status === 500 &&
        settledBody.body.charged === true &&
        settledBody.body.settled === true &&
        settledReceipt.transaction === SETTLE_TX &&
        /do not retry/i.test(String(settledBody.body.remediation)),
      JSON.stringify({ hits: settledThrow.settleHits, state: settledThrow.trace.state, ...settledBody }),
    )

    // 4d. The invariant, over every state: `charged:false` is claimed ONLY where no money can
    //     have moved.
    const STATES: SettlementState[] = ["before_settle", "settle_refused", "settle_in_flight", "settled"]
    const claimsUncharged = STATES.filter(
      (state) =>
        auditFailure({ state, receipt: state === "settled" ? settledThrow.trace.receipt : undefined }, new Error("x")).body.charged === false,
    )
    check(
      27,
      "charged:false is claimed only in before_settle and settle_refused",
      JSON.stringify(claimsUncharged) === JSON.stringify(["before_settle", "settle_refused"]),
      JSON.stringify(claimsUncharged),
    )

    // 4d'. A trace object that is reused must not leak "settled" into the next request's catch.
    const reused: SettlementTrace = { state: "settled", receipt: settledThrow.trace.receipt }
    await handleX402VerifyPmTrade(new Request(PM_RESOURCE.url, { method: "POST", body: "" }), env, pmAdapter(), PM_RESOURCE, reused)
    check(
      28,
      "a reused trace is reset on entry (no stale 'settled' from a previous request)",
      reused.state === "before_settle" && reused.receipt === undefined,
      JSON.stringify(reused),
    )

    // 4e. The same facts through the REAL routes (index.ts), the model stubbed at the fetch
    //     layer. The route's catch is two lines of glue; this proves the glue passes the trace.
    const { app } = await import("../src/index")
    const realFetch = globalThis.fetch
    let anthropic: { extraction: Record<string, unknown>; down: boolean } = { extraction: PM_EXTRACTION, down: false }
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (u.startsWith("https://api.anthropic.com/")) {
        if (anthropic.down) return new Response("upstream down", { status: 500 })
        return new Response(JSON.stringify({ content: [{ text: JSON.stringify(anthropic.extraction) }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return realFetch(input, init)
    }) as typeof fetch
    // The Worker env: placeholders only. Nothing here is a credential.
    const routeEnv = {
      FACILITATOR_URL: fac.url,
      ANTHROPIC_API_KEY: "offline-placeholder",
      DJZS_ATTESTER_KEY: testAttesterKey(),
      BASE_RPC_URL: rpc.url,
    }
    const viaRoute = async (path: string, extraction: Record<string, unknown>, body: unknown, down = false) => {
      anthropic = { extraction, down }
      const u = `https://mcp.djzs.ai${path}`
      const probe = await app.fetch(new Request(u, { method: "POST", body: "" }), routeEnv as never)
      const challenge = (await probe.json()) as { accepts?: unknown[] }
      const before = fac.hits.settle
      const res = await app.fetch(
        new Request(u, { method: "POST", headers: { "X-PAYMENT": paymentHeader(challenge) }, body: JSON.stringify(body) }),
        routeEnv as never,
      )
      const text = await res.text()
      let parsed: Record<string, any> = {}
      try {
        parsed = JSON.parse(text)
      } catch {}
      return { res, text, body: parsed, settleHits: fac.hits.settle - before }
    }

    try {
      // The reported scenario, on the real perp route: this used to be a 503 "charged:false" AFTER a charge.
      const routePerp = await viaRoute("/x402/verify_perp_trade", PERP_EXTRACTION, published)
      check(
      29,
        "REAL perp route, example body: 200 with a verdict (was: 503 charged:false after settlement)",
        routePerp.res.status === 200 && routePerp.settleHits === 1 && ["PASS", "WAIT", "FAIL"].includes(routePerp.body.verdict) && routePerp.body.charged === true,
        `${routePerp.res.status} hits=${routePerp.settleHits} ${routePerp.text.slice(0, 160)}`,
      )

      const routePm = await viaRoute("/x402/verify_pm_trade", PM_EXTRACTION, { intent: PUBLISHED_PM.intent })
      check(
      30,
        "REAL PM route, published vector: 200, intent_hash == the published value",
        routePm.res.status === 200 && routePm.body.intent_hash === PUBLISHED_PM.intent_hash,
        `${routePm.res.status} ${routePm.text.slice(0, 160)}`,
      )

      // Before settlement: an extraction outage. Uncharged, and the body says exactly what it always did.
      const routeDown = await viaRoute("/x402/verify_pm_trade", PM_EXTRACTION, { intent: PUBLISHED_PM.intent }, true)
      check(
      31,
        "REAL route, extraction outage (before settle): 503 historical body, settle never called",
        routeDown.res.status === 503 &&
          routeDown.settleHits === 0 &&
          routeDown.body.settled === false &&
          routeDown.body.charged === false &&
          routeDown.body.error === "AUDIT_UNAVAILABLE",
        `${routeDown.res.status} hits=${routeDown.settleHits} ${routeDown.text.slice(0, 160)}`,
      )

      fac.setSettle("reject")
      const routeRefused = await viaRoute("/x402/verify_pm_trade", PM_EXTRACTION, { intent: PUBLISHED_PM.intent })
      check(
      32,
        "REAL route, facilitator refuses: 503 historical body (charged:false is true here)",
        routeRefused.res.status === 503 && routeRefused.text === HISTORICAL_503("insufficient_funds"),
        `${routeRefused.res.status} ${routeRefused.text.slice(0, 160)}`,
      )

      fac.setSettle("uncertain")
      const routeUncertain = await viaRoute("/x402/verify_perp_trade", PERP_EXTRACTION, published)
      check(
      33,
        "REAL route, settle outcome unknowable: 502 SETTLEMENT_UNCERTAIN, never charged:false",
        routeUncertain.res.status === 502 &&
          routeUncertain.body.error === "SETTLEMENT_UNCERTAIN" &&
          routeUncertain.body.charged === null &&
          routeUncertain.body.settled === null,
        `${routeUncertain.res.status} ${routeUncertain.text.slice(0, 200)}`,
      )
      fac.setSettle("ok")
    } finally {
      globalThis.fetch = realFetch
    }

    // 4f. The route hands `f.headers` to Hono's c.json. The settled body carries the receipt in
    //     PAYMENT-RESPONSE; prove Hono delivers it (the real routes cannot be made to throw
    //     after settlement from outside, so this mounts the same two lines).
    const glue = new Hono().get("/settled", (c) => {
      const f = auditFailure(settledThrow.trace, new Error("post-settlement failure"))
      return c.json(f.body, f.status, f.headers)
    })
    const glued = await glue.request("/settled")
    const gluedBody = (await glued.json()) as Record<string, unknown>
    check(
      34,
      "c.json(f.body, f.status, f.headers) delivers a 500 charged:true body WITH the PAYMENT-RESPONSE receipt",
      glued.status === 500 &&
        gluedBody.charged === true &&
        decodeReceipt(glued.headers.get("PAYMENT-RESPONSE")).transaction === SETTLE_TX,
      `${glued.status} ${glued.headers.get("PAYMENT-RESPONSE")}`,
    )
  } finally {
    await fac.close()
    await rpc.close()
  }

  console.log(`\nX402 ROUTE OFFLINE HARNESS: PASS (${checks} checks)`)
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e)
  process.exit(1)
})
