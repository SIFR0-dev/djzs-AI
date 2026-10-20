/**
 * Offline regression for invariant 5 of http-x402-bazaar.v2.ts:
 * NOTHING throws after settlePayment succeeds.
 *
 * The defect this pins: handleX402VerifyPmTrade settled the payment and THEN called
 * intentHash(toDJZSIntent(intent)) outside any try. toDJZSIntent maps prediction-market
 * intents only (it reads `market`); a perp/spot intent has none, so viem threw, the error
 * escaped to the route's catch in index.ts, and that catch answered 503 AUDIT_UNAVAILABLE
 * with `settled:false, charged:false` AFTER 2.00 USDC had settled — the verdict was lost.
 *
 * ZERO keys, ZERO egress. The facilitator is a loopback HTTP server on 127.0.0.1, the engine
 * and the attester are stubs (the attester through the handler's `deps.attest` seam). No
 * mainnet, no USDC, no CDP, no model.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/post-settlement.test.ts
 * Note: Node >= 22.21 with NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY set needs NO_PROXY to include 127.0.0.1, or the
 * loopback facilitator calls are proxied and the test fails closed (CI sets neither variable).
 * Exit 0 => every check passed ("POST-SETTLEMENT: PASS"). Exit 1 => at least one failed;
 * ALL failures are listed, not just the first.
 */
import { createServer, type Server } from "node:http"
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http"
import {
  handleX402VerifyPmTrade,
  PM_RESOURCE,
  PERP_RESOURCE,
  NETWORK,
  PAY_TO,
  EXPECTED_ATOMIC_AMOUNT,
  type X402Env,
  type EngineAdapter,
  type VerdictResult,
  type ResourceSpec,
} from "../src/http-x402-bazaar.v2"
import { intentHash } from "../src/attest-worker"
import { toDJZSIntent } from "../src/djzs-intent"

// ── tiny check harness: collect every failure, exit non-zero at the end ──────────────
let checks = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string): void {
  checks++
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`)
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────────────
const PAYER = "0x1111111111111111111111111111111111111111"
const SETTLE_TX = "0x" + "cd".repeat(32)

/** A prediction-market intent. Its intent_hash is PINNED below: a drift here is a binding-key change. */
const PM_INTENT = {
  market: "KXBTC-26AUG29-T70000",
  side: "YES",
  thesis: "BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it",
  probability_basis: "gut feel, roughly a 60 percent chance",
  size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
}
/** Computed from the unchanged toDJZSIntent/intentHash on origin/main (dd625b1), viem 2.55.1. */
const PM_INTENT_HASH_PINNED = "0x6a2f49f50ac99d89f5bd306cf5c6f058b3f0f18b993dfbc7424500ef1732623c"

/** The exact example published in verify_perp_trade's 402 challenge (extensions.bazaar.info.input.body). No `market`. */
const PERP_INTENT = {
  instrument: "BTC-PERP",
  side: "LONG",
  leverage: 5,
  entry: 78900,
  stop_loss: 76200,
  take_profit: 83000,
  size_usd: 3000,
  venue: "Binance",
  thesis: "Funding reset to 2% after the weekend flush; 80K held on the daily close; ETF inflows resumed. Invalidation: daily close below 76,200. Oracle: Binance mark price.",
}

const VERDICT_FAIL: VerdictResult = {
  verdict: "FAIL",
  risk_score: 30,
  flags: ["DJZS-S01"],
  verdict_hash: "0x" + "ab".repeat(32),
  intent_sha256: "11".repeat(32),
}
const VERDICT_PASS: VerdictResult = { ...VERDICT_FAIL, verdict: "PASS", risk_score: 0, flags: [] }

// ── stubs ───────────────────────────────────────────────────────────────────────────
interface StubFacilitator {
  url: string
  hits: Record<string, number>
  verifyValid: boolean
  settleMode: "ok" | "fail" | "http500"
  close: () => Promise<void>
}

/** Loopback facilitator speaking the real wire contract: GET /supported, POST /verify, POST /settle. */
async function startFacilitator(): Promise<StubFacilitator> {
  const state: StubFacilitator = { url: "", hits: { supported: 0, verify: 0, settle: 0 }, verifyValid: true, settleMode: "ok", close: async () => {} }
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0].replace(/^.*\//, "")
    state.hits[path] = (state.hits[path] ?? 0) + 1
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    req.on("data", () => {})
    req.on("end", () => {
      if (path === "supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} })
      if (path === "verify") return reply(200, state.verifyValid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "stub_invalid", payer: PAYER })
      if (path === "settle") {
        if (state.settleMode === "http500") return reply(500, { error: "stub settle 500" })
        if (state.settleMode === "fail") return reply(200, { success: false, errorReason: "stub_settle_declined", payer: PAYER, transaction: "", network: NETWORK })
        return reply(200, { success: true, payer: PAYER, transaction: SETTLE_TX, network: NETWORK })
      }
      return reply(500, { error: "stub facilitator: unexpected path " + path })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("could not bind loopback facilitator")
  state.url = `http://127.0.0.1:${addr.port}`
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return state
}

let FAC: StubFacilitator
const auditSeen: number[] = [] // fac.hits.settle observed at the moment engine.audit ran
function stubEngine(opts: { audit?: () => Promise<VerdictResult>; inScope?: boolean } = {}): EngineAdapter {
  return {
    async scopeCheck() {
      return opts.inScope === false ? { inScope: false, reason: "stub_out_of_scope" } : { inScope: true }
    },
    async audit() {
      auditSeen.push(FAC.hits.settle)
      return opts.audit ? opts.audit() : VERDICT_PASS
    },
  }
}

interface AttestCall { intentHash: string; verdict: string; riskScore: number; flags: string[]; agent: string; rulesetVersion: string }
function stubAttester(mode: "ok" | "throw") {
  const calls: AttestCall[] = []
  const fn = async (_env: unknown, v: AttestCall) => {
    calls.push(v)
    if (mode === "throw") throw new Error("stub attester: tx reverted")
    return { uid: ("0x" + "ee".repeat(32)) as `0x${string}`, txHash: ("0x" + "ff".repeat(32)) as `0x${string}`, block: 1n }
  }
  return { calls, fn: fn as never }
}

// ── driver ──────────────────────────────────────────────────────────────────────────
interface Outcome {
  threw: string | null
  status: number
  text: string
  body: Record<string, unknown>
  paymentResponse: Headers
  settleDelta: number
  auditCalls: number
}

/** Get a challenge for `spec`, then wrap its accepts[0] in a v2 payment payload the stub facilitator will accept. */
async function paymentHeader(env: X402Env, spec: ResourceSpec): Promise<string> {
  const probe = await handleX402VerifyPmTrade(new Request(spec.url, { method: "POST", body: "" }), env, stubEngine(), spec)
  const challenge = (await probe.json()) as { resource: unknown; accepts: unknown[] }
  const payment = {
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: {
      signature: "0x" + "00".repeat(65),
      authorization: { from: PAYER, to: PAY_TO, value: EXPECTED_ATOMIC_AMOUNT, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) },
    },
  }
  return encodePaymentSignatureHeader(payment as never) // the library's own encoder: handles non-Latin1 (the perp description has an em dash)
}

async function paid(args: {
  env: X402Env
  spec: ResourceSpec
  intent: unknown
  engine: EngineAdapter
  attest?: unknown
  header: string
}): Promise<Outcome> {
  const req = new Request(args.spec.url, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": args.header },
    body: JSON.stringify({ intent: args.intent }),
  })
  const s0 = FAC.hits.settle, a0 = auditSeen.length
  try {
    const res = await handleX402VerifyPmTrade(req, args.env, args.engine, args.spec, { attest: (args.attest ?? (async () => { throw new Error("default stub attester: must not be reached") })) as never })
    const text = await res.text()
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(text) } catch { /* leave empty; the checks will say so */ }
    return { threw: null, status: res.status, text, body, paymentResponse: res.headers, settleDelta: FAC.hits.settle - s0, auditCalls: auditSeen.length - a0 }
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e), status: 0, text: "", body: {}, paymentResponse: new Headers(), settleDelta: FAC.hits.settle - s0, auditCalls: auditSeen.length - a0 }
  }
}

/** The tx the PAYMENT-RESPONSE header carries, or null if absent/undecodable. */
function headerTx(h: Headers): string | null {
  const raw = h.get("PAYMENT-RESPONSE")
  if (!raw) return null
  try { return (decodePaymentResponseHeader(raw) as { transaction?: string }).transaction ?? null } catch { return null }
}

/** Charged scenarios: exactly one settlement, and the engine ran only after it. */
function settledOnceBeforeAudit(o: Outcome, before: number): boolean {
  return o.settleDelta === 1 && (o.auditCalls === 0 || auditSeen[auditSeen.length - 1] === before + 1)
}

/** After a settlement, the response must never claim the payment did not happen. */
function neverSaysUnsettled(o: Outcome): boolean {
  return !/"settled"\s*:\s*false/.test(o.text) && !/AUDIT_UNAVAILABLE/.test(o.text) && o.body.charged !== false
}

// ── main ────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Watchdog: if a regression makes the handler (or the stub) never resolve, fail fast instead of hanging CI.
  setTimeout(() => { console.error("POST-SETTLEMENT: TIMEOUT after 60s (handler never resolved)"); process.exit(1) }, 60_000).unref()
  const fac = await startFacilitator()
  FAC = fac
  const envKey: X402Env = { FACILITATOR_URL: fac.url, ATTESTER_KEY: "stub-not-a-key" }
  const envNoKey: X402Env = { FACILITATOR_URL: fac.url }

  try {
    const hdrPm = await paymentHeader(envKey, PM_RESOURCE)
    const hdrPerp = await paymentHeader(envKey, PERP_RESOURCE)

    // ── 1. THE DEFECT: a perp intent on the perp route ──────────────────────────────
    console.log("1. perp intent, verdict exists: the handler must RETURN it, charged, never settled:false")
    {
      const settleBefore = fac.hits.settle
      const att = stubAttester("ok")
      const o = await paid({ env: envKey, spec: PERP_RESOURCE, intent: PERP_INTENT, engine: stubEngine({ audit: async () => VERDICT_FAIL }), attest: att.fn, header: hdrPerp })
      check("handler RESOLVES after settlement (does not reject)", o.threw === null, o.threw ?? "")
      check("the payment settled exactly once", fac.hits.settle - settleBefore === 1, `settle hits +${fac.hits.settle - settleBefore}`)
      check("settled once AND engine.audit ran only after settlement", settledOnceBeforeAudit(o, settleBefore), `delta=${o.settleDelta} seen=${auditSeen}`)
      check("HTTP 200, not 503", o.status === 200, `status=${o.status}`)
      check("the engine's verdict is returned", o.body.verdict === "FAIL" && o.body.risk_score === 30, JSON.stringify(o.body).slice(0, 160))
      check("charged:true", o.body.charged === true)
      check("never settled:false / AUDIT_UNAVAILABLE after settlement", neverSaysUnsettled(o), o.text.slice(0, 200))
      check("intent_hash is null (no perp mapping yet: awaiting DJ's ruling)", o.body.intent_hash === null, String(o.body.intent_hash))
      check("eas_error is set and names the hash failure", typeof o.body.eas_error === "string" && (o.body.eas_error as string).startsWith("intent_hash_failed"), String(o.body.eas_error))
      check("eas_uid / eas_tx are null", o.body.eas_uid === null && o.body.eas_tx === null)
      check("the attester is NOT called without an intent_hash", att.calls.length === 0, `calls=${att.calls.length}`)
      check("PAYMENT-RESPONSE header carries the settlement tx", headerTx(o.paymentResponse) === SETTLE_TX, String(headerTx(o.paymentResponse)))
    }


    // ── 1b. perp intent, ATTESTER NOT CONFIGURED: the hash failure must stay visible ──
    console.log("1b. perp intent, no attester key: still a charged verdict, and eas_error names the HASH failure")
    {
      const sb = fac.hits.settle
      const att = stubAttester("ok")
      const o = await paid({ env: envNoKey, spec: PERP_RESOURCE, intent: PERP_INTENT, engine: stubEngine({ audit: async () => VERDICT_FAIL }), attest: att.fn, header: hdrPerp })
      check("200, verdict returned, charged:true, intent_hash null", o.status === 200 && o.body.verdict === "FAIL" && o.body.charged === true && o.body.intent_hash === null, `${o.status}`)
      check("eas_error is intent_hash_failed (not masked by attester_not_configured)", String(o.body.eas_error).startsWith("intent_hash_failed"), String(o.body.eas_error))
      check("settled once, attester not called", settledOnceBeforeAudit(o, sb) && att.calls.length === 0)
    }

    // ── 1c. hash failure that does NOT depend on the perp mapping gap ──
    console.log("1c. PM-route intent with no market/thesis: hash fails -> fail-soft (survives DJ's perp ruling)")
    {
      const sb = fac.hits.settle
      const att = stubAttester("ok")
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: { side: "YES", size_usd: 250 }, engine: stubEngine({ audit: async () => VERDICT_FAIL }), attest: att.fn, header: hdrPm })
      check("200 verdict, intent_hash null, eas_error intent_hash_failed, no attest", o.status === 200 && o.body.verdict === "FAIL" && o.body.intent_hash === null && String(o.body.eas_error).startsWith("intent_hash_failed") && att.calls.length === 0, `${o.status} ${String(o.body.eas_error)}`)
      check("settled once, never settled:false", settledOnceBeforeAudit(o, sb) && neverSaysUnsettled(o))
    }

    // ── 2. A prediction-market intent is unchanged ─────────────────────────────────
    console.log("2. prediction-market intent: intent_hash is non-null, pinned, and attested")
    {
      const att = stubAttester("ok")
      const settleBefore2 = fac.hits.settle
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: att.fn, header: hdrPm })
      check("handler resolves, HTTP 200, charged:true", o.threw === null && o.status === 200 && o.body.charged === true, `${o.threw} ${o.status}`)
      check("intent_hash is a 32-byte hex string (non-null)", typeof o.body.intent_hash === "string" && /^0x[0-9a-f]{64}$/.test(o.body.intent_hash as string), String(o.body.intent_hash))
      check("handler wiring: intent_hash equals intentHash(toDJZSIntent(intent)) (mapping drift is caught by the PIN below)", o.body.intent_hash === intentHash(toDJZSIntent(PM_INTENT as never)))
      check("intent_hash equals the value PINNED from origin/main (binding key has not drifted)", o.body.intent_hash === PM_INTENT_HASH_PINNED, String(o.body.intent_hash))
      check("attester called once with that same hash", att.calls.length === 1 && att.calls[0].intentHash === o.body.intent_hash, JSON.stringify(att.calls))
      check("attester received the settle payer as the agent", att.calls[0]?.agent === PAYER, String(att.calls[0]?.agent))
      check("eas_uid / eas_tx come from the attester; no eas_error", typeof o.body.eas_uid === "string" && typeof o.body.eas_tx === "string" && !("eas_error" in o.body))
      check("PAYMENT-RESPONSE header carries the settlement tx", headerTx(o.paymentResponse) === SETTLE_TX)
      check("never settled:false after settlement", neverSaysUnsettled(o))
      check("attester got the FULL expected record", JSON.stringify(att.calls[0]) === JSON.stringify({ intentHash: PM_INTENT_HASH_PINNED, verdict: "PASS", riskScore: 0, flags: [], rulesetVersion: PM_RESOURCE.rulesetVersion, agent: PAYER }), JSON.stringify(att.calls[0]))
      check("content-type is application/json", (o.paymentResponse.get("content-type") ?? "").includes("application/json"))
      check("CORS: Expose-Headers lists PAYMENT-RESPONSE (browser payers can read the receipt)", /PAYMENT-RESPONSE/i.test(o.paymentResponse.get("access-control-expose-headers") ?? ""))
      check("settled once, engine ran only after settlement", settledOnceBeforeAudit(o, settleBefore2), `delta=${o.settleDelta}`)
    }

    // ── 3. Attester not configured: behaviour unchanged ─────────────────────────────
    console.log("3. prediction-market intent, attester not configured: unchanged")
    {
      const att = stubAttester("ok")
      const o = await paid({ env: envNoKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: att.fn, header: hdrPm })
      check("200, intent_hash still computed, eas_error = attester_not_configured", o.status === 200 && o.body.intent_hash === PM_INTENT_HASH_PINNED && o.body.eas_error === "attester_not_configured", JSON.stringify(o.body).slice(0, 200))
      check("attester not called", att.calls.length === 0)
    }

    // ── 4. Attester fails: verdict still returned ───────────────────────────────────
    console.log("4. prediction-market intent, attester throws: the verdict is still returned")
    {
      const att = stubAttester("throw")
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine({ audit: async () => ({ ...VERDICT_FAIL, flags: [{ code: "DJZS-S01" }, "DJZS-M03"] as never }) }), attest: att.fn, header: hdrPm })
      check("attester got verdict FAIL, risk 30, flags = SORTED codes (object + string flags both mapped)", att.calls[0]?.verdict === "FAIL" && att.calls[0]?.riskScore === 30 && JSON.stringify(att.calls[0]?.flags) === JSON.stringify(["DJZS-M03", "DJZS-S01"]) && att.calls[0]?.rulesetVersion === PM_RESOURCE.rulesetVersion, JSON.stringify(att.calls[0]))
      check("200 with the verdict, charged:true", o.status === 200 && o.body.verdict === "FAIL" && o.body.charged === true, `${o.status}`)
      check("intent_hash kept; eas_uid null; eas_error names the attester failure", o.body.intent_hash === PM_INTENT_HASH_PINNED && o.body.eas_uid === null && /reverted/.test(String(o.body.eas_error)), String(o.body.eas_error))
      check("never settled:false after settlement", neverSaysUnsettled(o))
    }

    // ── 5. Engine fails after settlement: AUDIT_ERROR with the receipt ──────────────
    console.log("5. engine.audit throws after settlement: AUDIT_ERROR, charged:true, tx + PAYMENT-RESPONSE")
    {
      const o = await paid({ env: envKey, spec: PERP_RESOURCE, intent: PERP_INTENT, engine: stubEngine({ audit: async () => { throw new Error("stub engine blew up") } }), header: hdrPerp })
      check("handler resolves; HTTP 500; verdict AUDIT_ERROR; charged:true", o.threw === null && o.status === 500 && o.body.verdict === "AUDIT_ERROR" && o.body.charged === true, `${o.threw} ${o.status}`)
      check("settlement_tx is in the body", o.body.settlement_tx === SETTLE_TX, String(o.body.settlement_tx))
      check("settled exactly once on the engine-failure path", o.settleDelta === 1, `delta=${o.settleDelta}`)
      check("PAYMENT-RESPONSE header carries the settlement tx", headerTx(o.paymentResponse) === SETTLE_TX)
      check("never settled:false after settlement", neverSaysUnsettled(o))
    }

    // ── 6. ANY other failure after settlement: same shape, never an escape ──────────
    console.log("6. an unexpected failure after settlement (unserialisable result): AUDIT_ERROR, not an escape")
    {
      const o = await paid({
        env: envKey,
        spec: PM_RESOURCE,
        intent: PM_INTENT,
        engine: stubEngine({ audit: async () => ({ ...VERDICT_PASS, verdict_hash: 10n as unknown as string }) }), // JSON.stringify throws on BigInt
        attest: stubAttester("ok").fn,
        header: hdrPm,
      })
      check("handler RESOLVES (does not reject)", o.threw === null, o.threw ?? "")
      check("settled exactly once on the unexpected-failure path", o.settleDelta === 1, `delta=${o.settleDelta}`)
      check("HTTP 500 AUDIT_ERROR, charged:true, settlement_tx present", o.status === 500 && o.body.verdict === "AUDIT_ERROR" && o.body.charged === true && o.body.settlement_tx === SETTLE_TX, `${o.status} ${o.text.slice(0, 160)}`)
      check("PAYMENT-RESPONSE header carries the settlement tx", headerTx(o.paymentResponse) === SETTLE_TX)
      check("never settled:false after settlement", neverSaysUnsettled(o))
    }

    // ── 7. Before settlement, "not charged" is still the truth ──────────────────────
    console.log("7. before settlement the uncharged answers are unchanged")
    {
      const settleBefore = fac.hits.settle
      const out = await paid({ env: envKey, spec: PERP_RESOURCE, intent: PM_INTENT, engine: stubEngine({ inScope: false }), header: hdrPerp })
      check("out of scope: 200 REFUSED_SCOPE, charged:false, settled:false", out.status === 200 && out.body.verdict === "REFUSED_SCOPE" && out.body.charged === false && out.body.settled === false, out.text.slice(0, 160))
      check("out of scope: nothing settled", fac.hits.settle === settleBefore, `settle hits +${fac.hits.settle - settleBefore}`)

      fac.verifyValid = false
      const bad = await paid({ env: envKey, spec: PERP_RESOURCE, intent: PERP_INTENT, engine: stubEngine(), header: hdrPerp })
      fac.verifyValid = true
      check("invalid payment: 402 payment_verification_failed, nothing settled", bad.status === 402 && bad.body.error === "payment_verification_failed" && fac.hits.settle === settleBefore, `${bad.status}`)
    }

    // ── 8. settlement DECLINED: no verdict, nothing charged, engine never runs ──
    console.log("8. facilitator declines /settle: 402 settlement_failed, charged:false, engine.audit NEVER called")
    {
      fac.settleMode = "fail"
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: stubAttester("ok").fn, header: hdrPm })
      fac.settleMode = "ok"
      check("402 settlement_failed, charged:false, no verdict, engine not called", o.status === 402 && o.body.error === "settlement_failed" && o.body.charged === false && !("verdict" in o.body) && o.auditCalls === 0, `${o.status} ${o.text.slice(0, 120)} audits=${o.auditCalls}`)
    }
  } finally {
    await fac.close()
  }

  if (failures.length) {
    console.error(`\nPOST-SETTLEMENT: FAIL (${failures.length} of ${checks} checks failed)`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\nPOST-SETTLEMENT: PASS (${checks} checks)`)
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e)
  process.exit(1)
})
