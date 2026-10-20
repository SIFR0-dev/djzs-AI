/**
 * Offline regression for invariants 5-8 of http-x402-bazaar.v2.ts:
 *   5. nothing throws after settlePayment succeeds; settled:false is never answered after a settlement
 *   6. the intent is BOUND (intentHash) before settlePayment: one that cannot be bound is refused uncharged
 *   7. settlePayment THROWING answers 502 SETTLEMENT_UNCERTAIN (settled:null, charged:null), never settled:false
 *   8. every error field returned to a caller is a fixed code (safe-error.ts), never raw error text
 *
 * The defect this pins: handleX402VerifyPmTrade settled the payment and THEN called
 * intentHash(toDJZSIntent(intent)) outside any try. toDJZSIntent maps prediction-market
 * intents only (it reads `market`); a perp/spot intent has none, so viem threw, the error
 * escaped to the route's catch in index.ts, and that catch answered 503 AUDIT_UNAVAILABLE
 * with `settled:false, charged:false` AFTER 2.00 USDC had settled — the verdict was lost.
 *
 * The no-leak checks seed every dependency failure with a SENTINEL shaped like a provider RPC URL
 * (viem's HttpRequestError message starts with the URL) and assert it appears in NO response body
 * or header, while the Worker log carries the cause with the URL scrubbed.
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
import { FAULTS } from "../src/safe-error"

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
/** Shaped like a provider RPC URL with the key in the path. If any of it reaches a response, the leak is real. */
const SENTINEL_URL = "https://rpc.sentinel.invalid/v2/KEYSENTINEL0123456789abcdef"
const SENTINEL_PARTS = ["KEYSENTINEL", "sentinel.invalid"]

/** A prediction-market intent. Its intent_hash is PINNED below: a drift here is a binding-key change. */
const PM_INTENT = {
  market: "KXBTC-26AUG29-T70000",
  side: "YES",
  thesis: "BTC closes above 70000 by Aug 29 because ETF inflows keep compounding and everyone knows it",
  probability_basis: "gut feel, roughly a 60 percent chance",
  size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
}
/** Computed from the unchanged PM branch of toDJZSIntent/intentHash on origin/main (dd625b1), viem 2.55.1. */
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

/** The published perp example bound by production's perp_trade mapping (action "perp_trade", params_hash over leverage|entry|stop_loss|take_profit). Pinned: a drift is a binding-key change. */
const PERP_INTENT_HASH_PINNED = "0xb7fbfdab14efbc842bd235439b995791f160610b266ea154dd52a43631ed8c19"
/** Neither a `market` (prediction market) nor an `instrument` (perp): no mapping applies, so it cannot be bound. */
const NEITHER_INTENT = { side: "LONG", thesis: "an intent object with neither a market nor an instrument", size_usd: 100 }

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
  verifyReason: string
  declineReason: string
  settleMode: "ok" | "fail" | "http500" | "garbage" | "hangup"
  close: () => Promise<void>
}

/** Loopback facilitator speaking the real wire contract: GET /supported, POST /verify, POST /settle. */
async function startFacilitator(): Promise<StubFacilitator> {
  const state: StubFacilitator = {
    url: "", hits: { supported: 0, verify: 0, settle: 0 }, verifyValid: true, verifyReason: "stub_invalid",
    declineReason: "stub_settle_declined", settleMode: "ok", close: async () => {},
  }
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
      if (path === "verify") return reply(200, state.verifyValid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: state.verifyReason, payer: PAYER })
      if (path === "settle") {
        // The 500 body and the garbage body carry the sentinel: the library may fold a response body into the error it throws.
        if (state.settleMode === "http500") return reply(500, { error: `stub settle 500 ${SENTINEL_URL}` })
        if (state.settleMode === "garbage") { res.writeHead(200, { "content-type": "application/json" }); return res.end(`<html>${SENTINEL_URL}`) }
        if (state.settleMode === "hangup") return req.socket.destroy()
        if (state.settleMode === "fail") return reply(200, { success: false, errorReason: state.declineReason, payer: PAYER, transaction: "", network: NETWORK })
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
function stubEngine(opts: { audit?: () => Promise<VerdictResult>; inScope?: boolean; scope?: () => Promise<{ inScope: boolean; reason?: string }> } = {}): EngineAdapter {
  return {
    async scopeCheck() {
      if (opts.scope) return opts.scope()
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
    if (mode === "throw") throw new Error(`HTTP request failed.\n\nURL: ${SENTINEL_URL}\nRequest body: {"method":"eth_sendRawTransaction"}\n\nDetails: fetch failed`)
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

/** None of the sentinel (URL or key) in the body or in any response header. */
function noLeak(o: Outcome): boolean {
  const heads = [...o.paymentResponse.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")
  return !SENTINEL_PARTS.some((p) => o.text.includes(p) || heads.includes(p))
}

/** Every `detail` / `eas_error` the response carries is a member of the fixed vocabulary. */
function codesFixed(o: Outcome): boolean {
  const vocab = new Set<string>(FAULTS)
  return (["detail", "eas_error"] as const).every((k) => !(k in o.body) || vocab.has(String(o.body[k])))
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

    // ── 1. THE DEFECT, closed at its root: bind BEFORE settling ─────────────────────
    console.log("1. a perp intent binds (production's perp_trade mapping) and is attested; an intent that cannot be bound is refused UNCHARGED, before settlePayment")
    {
      // Ruled 2026-10-20: production's perp_trade action and its perp branch in toDJZSIntent are the mapping.
      const sb0 = fac.hits.settle
      const att0 = stubAttester("ok")
      const p = await paid({ env: envKey, spec: PERP_RESOURCE, intent: PERP_INTENT, engine: stubEngine({ audit: async () => VERDICT_FAIL }), attest: att0.fn, header: hdrPerp })
      check("perp example: handler resolves, HTTP 200, the engine's verdict, charged:true", p.threw === null && p.status === 200 && p.body.verdict === "FAIL" && p.body.charged === true, `${p.threw} ${p.status} ${p.text.slice(0, 120)}`)
      check("perp example: intent_hash is the value PINNED from production's mapping (the binding key has not drifted)", p.body.intent_hash === PERP_INTENT_HASH_PINNED, String(p.body.intent_hash))
      check("perp example: settled once, engine ran only after settlement", settledOnceBeforeAudit(p, sb0), `delta=${p.settleDelta}`)
      check("perp example: attested once with that hash, ruleset " + PERP_RESOURCE.rulesetVersion, att0.calls.length === 1 && att0.calls[0].intentHash === PERP_INTENT_HASH_PINNED && att0.calls[0].rulesetVersion === PERP_RESOURCE.rulesetVersion, JSON.stringify(att0.calls))
      check("perp example: PAYMENT-RESPONSE carries the settlement tx, never settled:false", headerTx(p.paymentResponse) === SETTLE_TX && neverSaysUnsettled(p))

      const sb = fac.hits.settle
      const att = stubAttester("ok")
      const o = await paid({ env: envKey, spec: PERP_RESOURCE, intent: NEITHER_INTENT, engine: stubEngine(), attest: att.fn, header: hdrPerp })
      check("neither market nor instrument: handler resolves", o.threw === null, o.threw ?? "")
      check("HTTP 400 intent_unbindable", o.status === 400 && o.body.error === "intent_unbindable", `${o.status} ${o.text.slice(0, 120)}`)
      check("charged:false, settled:false (both true: nothing moved)", o.body.charged === false && o.body.settled === false)
      check("settlePayment was NEVER called", fac.hits.settle === sb, `settle hits +${fac.hits.settle - sb}`)
      check("the engine never ran and nothing was attested", o.auditCalls === 0 && att.calls.length === 0)
      check("no PAYMENT-RESPONSE header (nothing settled)", headerTx(o.paymentResponse) === null)
      check("detail is a fixed code, no raw text", codesFixed(o) && noLeak(o), o.text.slice(0, 160))

      const sb2 = fac.hits.settle
      const miss = await paid({ env: envKey, spec: PM_RESOURCE, intent: { side: "YES", size_usd: 250 }, engine: stubEngine(), attest: att.fn, header: hdrPm })
      check("PM route, no market/thesis: 400 intent_unbindable, uncharged, not settled", miss.status === 400 && miss.body.error === "intent_unbindable" && miss.body.charged === false && fac.hits.settle === sb2, `${miss.status}`)

      const sb3 = fac.hits.settle
      const neg = await paid({ env: envKey, spec: PM_RESOURCE, intent: { ...PM_INTENT, bounds: { max_loss_usd: -5, exit_condition: "x" } }, engine: stubEngine(), attest: att.fn, header: hdrPm })
      check("PM route, negative max_loss_usd (cannot encode as uint256): 400, uncharged, not settled", neg.status === 400 && neg.body.error === "intent_unbindable" && neg.body.charged === false && fac.hits.settle === sb3, `${neg.status} ${neg.text.slice(0, 100)}`)
      check("the attester was never reached by any of the three refusals", att.calls.length === 0)
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

    // ── 3. Attester not configured ──────────────────────────────────────────────────
    console.log("3. prediction-market intent, attester not configured: unchanged")
    {
      const att = stubAttester("ok")
      const o = await paid({ env: envNoKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: att.fn, header: hdrPm })
      check("200, intent_hash still computed, eas_error = attester_not_configured", o.status === 200 && o.body.intent_hash === PM_INTENT_HASH_PINNED && o.body.eas_error === "attester_not_configured", JSON.stringify(o.body).slice(0, 200))
      check("attester not called", att.calls.length === 0)
    }

    // ── 4. Attester fails: verdict still returned, error is a code, the URL stays in the log ──
    console.log("4. prediction-market intent, attester throws (message begins with the RPC URL): the verdict is still returned, with a code")
    {
      const att = stubAttester("throw")
      const logs: string[] = []
      const realErr = console.error
      console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")) }
      let o: Outcome
      try {
        o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine({ audit: async () => ({ ...VERDICT_FAIL, flags: [{ code: "DJZS-S01" }, "DJZS-M03"] as never }) }), attest: att.fn, header: hdrPm })
      } finally {
        console.error = realErr
      }
      check("attester got verdict FAIL, risk 30, flags = SORTED codes (object + string flags both mapped)", att.calls[0]?.verdict === "FAIL" && att.calls[0]?.riskScore === 30 && JSON.stringify(att.calls[0]?.flags) === JSON.stringify(["DJZS-M03", "DJZS-S01"]) && att.calls[0]?.rulesetVersion === PM_RESOURCE.rulesetVersion, JSON.stringify(att.calls[0]))
      check("200 with the verdict, charged:true", o.status === 200 && o.body.verdict === "FAIL" && o.body.charged === true, `${o.status}`)
      check("intent_hash kept; eas_uid null; eas_error is the fixed code attestation_failed", o.body.intent_hash === PM_INTENT_HASH_PINNED && o.body.eas_uid === null && o.body.eas_error === "attestation_failed", String(o.body.eas_error))
      check("the RPC URL / key appear in NO response body or header", noLeak(o), o.text.slice(0, 200))
      check("every detail / eas_error is in the fixed vocabulary", codesFixed(o))
      check("the Worker log carries the cause ([fault] x402.attest) ...", logs.some((l) => l.includes("[fault] x402.attest")), logs.join(" | ").slice(0, 200))
      check("... with the URL and key scrubbed from the log line too", !logs.some((l) => SENTINEL_PARTS.some((p) => l.includes(p))), logs.join(" | ").slice(0, 200))
      check("never settled:false after settlement", neverSaysUnsettled(o))
    }

    // ── 5. Engine fails after settlement: AUDIT_ERROR with the receipt ──────────────
    console.log("5. engine.audit throws (message carries a secret-shaped URL) after settlement: AUDIT_ERROR, charged:true, tx + PAYMENT-RESPONSE, fixed code")
    {
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine({ audit: async () => { throw new Error(`Claude API error 401: {"error":"invalid x-api-key at ${SENTINEL_URL}"}`) } }), header: hdrPm })
      check("handler resolves; HTTP 500; verdict AUDIT_ERROR; charged:true", o.threw === null && o.status === 500 && o.body.verdict === "AUDIT_ERROR" && o.body.charged === true, `${o.threw} ${o.status}`)
      check("detail is engine_error, and nothing of the cause leaks", o.body.detail === "engine_error" && noLeak(o) && codesFixed(o), o.text.slice(0, 160))
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
      check("HTTP 500 AUDIT_ERROR, charged:true, settlement_tx present, detail post_settlement_error", o.status === 500 && o.body.verdict === "AUDIT_ERROR" && o.body.charged === true && o.body.settlement_tx === SETTLE_TX && o.body.detail === "post_settlement_error", `${o.status} ${o.text.slice(0, 160)}`)
      check("PAYMENT-RESPONSE header carries the settlement tx", headerTx(o.paymentResponse) === SETTLE_TX)
      check("never settled:false after settlement", neverSaysUnsettled(o))
    }

    // ── 7. Before settlement, "not charged" is still the truth ──────────────────────
    console.log("7. before settlement the uncharged answers hold, and facilitator reasons are relayed only if code-shaped")
    {
      const settleBefore = fac.hits.settle
      const out = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine({ inScope: false }), header: hdrPm })
      check("out of scope: 200 REFUSED_SCOPE, charged:false, settled:false", out.status === 200 && out.body.verdict === "REFUSED_SCOPE" && out.body.charged === false && out.body.settled === false, out.text.slice(0, 160))
      check("out of scope: nothing settled", fac.hits.settle === settleBefore, `settle hits +${fac.hits.settle - settleBefore}`)

      fac.verifyValid = false
      const bad = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), header: hdrPm })
      fac.verifyReason = `Insufficient funds for ${SENTINEL_URL}`
      const free = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), header: hdrPm })
      fac.verifyReason = "stub_invalid"
      fac.verifyValid = true
      check("invalid payment: 402 payment_verification_failed, code-shaped reason relayed, nothing settled", bad.status === 402 && bad.body.error === "payment_verification_failed" && bad.body.detail === "stub_invalid" && fac.hits.settle === settleBefore, `${bad.status} ${bad.text.slice(0, 100)}`)
      check("free-text facilitator reason is NOT relayed: detail becomes unknown, no sentinel", free.status === 402 && free.body.detail === "unknown" && noLeak(free), free.text.slice(0, 160))
    }

    // ── 8. settlement DECLINED: no verdict, nothing charged, engine never runs ──
    console.log("8. facilitator declines /settle: 402 settlement_failed, charged:false, engine.audit NEVER called")
    {
      fac.settleMode = "fail"
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: stubAttester("ok").fn, header: hdrPm })
      fac.declineReason = `declined: ${SENTINEL_URL}`
      const free = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: stubAttester("ok").fn, header: hdrPm })
      fac.declineReason = "stub_settle_declined"
      fac.settleMode = "ok"
      check("402 settlement_failed, code-shaped reason relayed, charged:false, no verdict, engine not called", o.status === 402 && o.body.error === "settlement_failed" && o.body.detail === "stub_settle_declined" && o.body.charged === false && !("verdict" in o.body) && o.auditCalls === 0, `${o.status} ${o.text.slice(0, 120)} audits=${o.auditCalls}`)
      check("free-text decline reason is NOT relayed", free.body.detail === "unknown" && noLeak(free), free.text.slice(0, 160))
    }

    // ── 9. settlePayment THROWS: 502 SETTLEMENT_UNCERTAIN, never settled:false ─────
    console.log("9. settlePayment throws (HTTP 500 / unparseable 200 / dropped connection): 502 SETTLEMENT_UNCERTAIN, settled:null charged:null")
    for (const mode of ["http500", "garbage", "hangup"] as const) {
      fac.settleMode = mode
      const sb = fac.hits.settle
      const att = stubAttester("ok")
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine(), attest: att.fn, header: hdrPm })
      fac.settleMode = "ok"
      check(`[${mode}] handler resolves; HTTP 502 SETTLEMENT_UNCERTAIN`, o.threw === null && o.status === 502 && o.body.error === "SETTLEMENT_UNCERTAIN", `${o.threw} ${o.status} ${o.text.slice(0, 120)}`)
      check(`[${mode}] settled:null and charged:null (neither claim is available), never settled:false`, o.body.settled === null && o.body.charged === null && !/"settled"\s*:\s*false/.test(o.text) && !/"charged"\s*:\s*false/.test(o.text), o.text.slice(0, 160))
      check(`[${mode}] the payer is told not to sign again`, /do not sign a second payment/i.test(String(o.body.remediation)), String(o.body.remediation))
      check(`[${mode}] settlePayment was attempted once, the engine and attester never ran`, fac.hits.settle - sb >= 1 && o.auditCalls === 0 && att.calls.length === 0, `settle +${fac.hits.settle - sb} audits=${o.auditCalls}`)
      check(`[${mode}] fixed code only: the facilitator's body / URL do not leak`, o.body.detail === "settlement_uncertain" && noLeak(o) && codesFixed(o), o.text.slice(0, 200))
    }

    // ── 10. an unexpected throw BEFORE settlement: 503, and there settled:false is true ──
    console.log("10. an unexpected throw before settlement (scope check blows up): 503 AUDIT_UNAVAILABLE with settled:false, which is true here")
    {
      const sb = fac.hits.settle
      const o = await paid({ env: envKey, spec: PM_RESOURCE, intent: PM_INTENT, engine: stubEngine({ scope: async () => { throw new Error(`boom ${SENTINEL_URL}`) } }), header: hdrPm })
      check("handler resolves; 503 AUDIT_UNAVAILABLE; settled:false charged:false", o.threw === null && o.status === 503 && o.body.error === "AUDIT_UNAVAILABLE" && o.body.settled === false && o.body.charged === false, `${o.threw} ${o.status} ${o.text.slice(0, 100)}`)
      check("and it IS true: settlePayment was never called", fac.hits.settle === sb)
      check("fixed code, no leak", o.body.detail === "audit_unavailable" && noLeak(o) && codesFixed(o), o.text.slice(0, 160))
    }

    // ── 11. facilitator unreachable: a code, not the URL ────────────────────────────
    console.log("11. facilitator unreachable (its URL carries the sentinel): 503 FACILITATOR_UNAVAILABLE, fixed code")
    {
      const dead: X402Env = { FACILITATOR_URL: `http://127.0.0.1:9/${SENTINEL_URL.split("/").pop()}-${Date.now()}` }
      const res = await handleX402VerifyPmTrade(new Request(PM_RESOURCE.url, { method: "POST", body: "" }), dead, stubEngine(), PM_RESOURCE)
      const text = await res.text()
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) } catch { /* the check will say so */ }
      check("503 FACILITATOR_UNAVAILABLE, detail facilitator_unavailable", res.status === 503 && body.error === "FACILITATOR_UNAVAILABLE" && body.detail === "facilitator_unavailable", `${res.status} ${text.slice(0, 120)}`)
      check("the facilitator URL does not leak", !text.includes("KEYSENTINEL"), text.slice(0, 160))
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
