/**
 * site/verify.html: the binding the page recomputes is chosen by the ATTESTED RULESET, never by the
 * body's keys (ruled 2026-10-21). Offline, no key, no network, no browser.
 *
 * The page is a static file, so this test lifts the text between `// BEGIN intent-mapping` and
 * `// END intent-mapping` out of it, runs it, and compares it with the Worker's toDJZSIntent. What it
 * pins:
 *   - routeFor: DJZS-LF-* means perp, anything else (including no ruleset) means PM;
 *   - the page's mapping and the Worker's are the SAME function over a corpus of bodies, on both routes
 *     (the Worker additionally refuses a missing or empty market/side/thesis; the page recomputes
 *     whatever receipt it is handed, so the corpus compares them wherever the Worker binds);
 *   - a perp-route receipt whose body carries `market` instead of `instrument` recomputes;
 *   - the DJZS attester's only two attestations (2026-09-01, DJZS-PM-v1.0) still verify. An attestation binds
 *     the intent STRUCT (EIP-712 over toDJZSIntent's output), not the raw request body, and both carry the
 *     same intentHash 0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb206. The intent for both is SAMPLE.intent, read out of site/verify.html
 *     (const SAMPLE, the 2026-09-01 receipt of 0xc59959896c7663314da81e153134f23782315887e643ca60e38bb9f915a05a89): for each uid the test decodes the attested
 *     payload, confirms DJZS-PM-v1.0 selects the PM mapping, and recomputes the hash from SAMPLE.intent.
 *     The 0x1eb78bccf6038bb8e0c1575f96fa700e85125ffaeb2477e61607419de0edce28 check is labelled for what it is: it SHARES SAMPLE's intent_hash, and the intent is
 *     recomputed from SAMPLE. THE LIMIT for 0x1eb78bccf6038bb8e0c1575f96fa700e85125ffaeb2477e61607419de0edce28 is its payment: no receipt naming that uid is on
 *     record, so its settlement tx and payer are not, and they are NOT checked. A git grep guard fails if
 *     such a receipt is ever added, and asks for the check to be upgraded;
 *   - the page's EIP-712 domain, types and field decoding equal the Worker's;
 *   - run() reads the attestation BEFORE it computes the binding and passes it the route.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/verify-page.test.mjs
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { decodeAbiParameters, hashTypedData, keccak256 } from "viem"
import { DJZS_DOMAIN, DJZS_TYPES, IntentUnbindableError, ZERO32, intentHash, toDJZSIntent } from "../src/djzs-intent.ts"

let n = 0
const failures = []
function check(label, ok, detail) {
  n++
  if (ok) console.log(`  ok   ${label}`)
  else { failures.push(label); console.error(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 240)}` : ""}`) }
}

const html = readFileSync("../site/verify.html", "utf8")
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""
check("verify.html has its module script", script.length > 1000)

// ── lift the mapping out of the page ────────────────────────────────────────────────
const BEGIN = "// BEGIN intent-mapping", END = "// END intent-mapping"
check("the mapping block is delimited exactly once", script.split(BEGIN).length === 2 && script.split(END).length === 2)
const block = script.slice(script.indexOf(BEGIN), script.indexOf(END))
const grab = (name) => {
  const m = new RegExp(`^const ${name}=(.*);$`, "m").exec(script)
  return m ? m[0] : ""
}
const consts = ["DOMAIN", "TYPES", "ZERO32", "FIELDS", "FIELDS_V3"].map(grab)
check("the page declares DOMAIN, TYPES, ZERO32, FIELDS, FIELDS_V3 as one-line consts", consts.every((c) => c.length > 0), consts.map((c) => c.slice(0, 20)).join(" | "))
const page = new Function("keccak256", `${consts.join("\n")}\n${block}\nreturn { DOMAIN, TYPES, ZERO32, FIELDS, FIELDS_V3, routeFor, toDJZSIntent, perpParamsPreimage }`)(keccak256)

const pageHash = (intent, ruleset) => hashTypedData({ domain: page.DOMAIN, types: page.TYPES, primaryType: "DJZSIntent", message: page.toDJZSIntent(intent, page.routeFor(ruleset)) })

// ── 1. the page speaks the Worker's EIP-712 ─────────────────────────────────────────
console.log("1. the page's domain, types and zero hash are the Worker's")
check("DOMAIN equals DJZS_DOMAIN", JSON.stringify(page.DOMAIN) === JSON.stringify(DJZS_DOMAIN), JSON.stringify(page.DOMAIN))
check("TYPES equals DJZS_TYPES", JSON.stringify(page.TYPES) === JSON.stringify(DJZS_TYPES))
check("ZERO32 equals ZERO32", page.ZERO32 === ZERO32)

// ── 2. routeFor ──────────────────────────────────────────────────────────────────────
console.log("2. routeFor: DJZS-LF-* is perp, everything else is PM")
for (const [rs, want] of [["DJZS-LF-v1.2", "perp"], ["DJZS-LF-v1.1", "perp"], ["DJZS-LF-v9", "perp"], ["DJZS-PM-v1.0", "pm"], ["", "pm"], [undefined, "pm"], [null, "pm"], [7, "pm"], ["djzs-lf-v1.2", "pm"], [" DJZS-LF-v1.2", "pm"], ["XDJZS-LF-v1.2", "pm"], ["DJZS-LF", "pm"], ["DJZS-VR-v1.0", "pm"]])
  check(`routeFor(${JSON.stringify(rs)}) = ${want}`, page.routeFor(rs) === want, page.routeFor(rs))

// ── 3. the two 2026-09-01 attestations ──────────────────────────────────────────────
console.log("3. the two 2026-09-01 attestations: the intent is SAMPLE.intent, read out of site/verify.html")
// SAMPLE is the live v2 receipt of 2026-09-01 embedded in the page (it names eas_uid 0xc59959896c7663314da81e153134f23782315887e643ca60e38bb9f915a05a89). Its intent is
// read out of the page here, not retyped. An attestation binds the intent STRUCT, and both attestations carry
// the same intentHash, so SAMPLE.intent is the attested intent for both uids.
const sampleSrc = /^const SAMPLE=(\{[\s\S]*?\n\});$/m.exec(script)?.[1] ?? ""
const SAMPLE = sampleSrc ? new Function("DJZS_SCHEMA", `return (${sampleSrc})`)("0x5ef67e2b8c617635431401d2872b2a6f79eeba54a8e19fd5ecd45aceda2a2030") : null
check("site/verify.html carries its 2026-09-01 receipt (const SAMPLE) with the intent, intent_hash and eas_uid", !!SAMPLE?.intent && /^0x[0-9a-f]{64}$/.test(SAMPLE?.intent_hash ?? "") && /^0x[0-9a-f]{64}$/.test(SAMPLE?.eas_uid ?? ""))
const PM_GOLDEN = SAMPLE?.intent
const GOLDEN_HASH = SAMPLE?.intent_hash

// Attested payloads: read from the EAS contract on Base (0x4200000000000000000000000000000000000021, getAttestation) on 2026-10-21 and
// cross-read from the EAS indexer. The DJZS attester 0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824 has made exactly these two attestations in
// its lifetime. Both: schema 0x5ef67e2b8c617635431401d2872b2a6f79eeba54a8e19fd5ecd45aceda2a2030 (v2), recipient 0x46448Ea69912Aa8E2191dde67839A4987D269d17, not revoked. Pinned one per uid.
const ATTESTATIONS = [
  { uid: "0x1eb78bccf6038bb8e0c1575f96fa700e85125ffaeb2477e61607419de0edce28", time: 1788294255, receipt: null,
    data: "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb20600000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000450415353000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c444a5a532d504d2d76312e300000000000000000000000000000000000000000" },
  { uid: "0xc59959896c7663314da81e153134f23782315887e643ca60e38bb9f915a05a89", time: 1788294891, receipt: "site/verify.html const SAMPLE",
    data: "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb20600000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000450415353000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c444a5a532d504d2d76312e300000000000000000000000000000000000000000" },
]
check("the page's SAMPLE receipt names the second attestation's uid (its receipt is on record)", SAMPLE?.eas_uid === ATTESTATIONS[1].uid, String(SAMPLE?.eas_uid))
for (const att of ATTESTATIONS) {
  const short = att.uid.slice(0, 10)
  const [ih, verdict, risk, flags, ruleset] = decodeAbiParameters(page.FIELDS, att.data)
  check(`${short}: the attested payload decodes with the page's FIELDS: PASS, risk 0, no flags, DJZS-PM-v1.0`, verdict === "PASS" && Number(risk) === 0 && flags.length === 0 && ruleset === "DJZS-PM-v1.0")
  check(`${short}: the attested ruleset DJZS-PM-v1.0 selects the prediction-market mapping`, page.routeFor(ruleset) === "pm")
  const label = att.receipt ? `its receipt is SAMPLE (${att.receipt}); intent recomputed from SAMPLE` : "shares SAMPLE's intent_hash; intent recomputed from SAMPLE"
  check(`${short}: ${label} - the attested intentHash is reproduced under the PM mapping`, !!PM_GOLDEN && ih === GOLDEN_HASH && pageHash(PM_GOLDEN, ruleset) === ih, pageHash(PM_GOLDEN, ruleset))
  check(`${short}: …and the Worker's toDJZSIntent agrees`, intentHash(toDJZSIntent(PM_GOLDEN, "pm")) === ih)
  if (!att.receipt) {
    // THE LIMIT: this attestation's payment. No receipt naming the uid is on record, so its settlement tx and payer
    // are not either, and they are NOT checked here. The claim is machine-checked: no tracked file but this one
    // names the uid. If a receipt is ever added, this fails on purpose: upgrade the check to verify settlement
    // and payer from that file.
    // Three spellings, because a receipt could be pasted whole, abbreviated, or without its 0x: the uid, its first 18
    // characters, and its first 8 hex digits. The same search for the SAMPLE's uid must find site/verify.html: a control that
    // proves the search, its scope and its exclusion work, so an empty result below means "absent" and not "broken".
    const grep = (needle) => {
      try { return execFileSync("git", ["grep", "-l", "-I", "-i", "-F", needle, "--", ".", ":(exclude)djzs-trust-mcp/test/verify-page.test.mjs"], { cwd: "..", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean) }
      catch (e) { return e.status === 1 ? [] : null } // exit 1 = no match; anything else = git unavailable
    }
    const control = grep(ATTESTATIONS[1].uid.slice(2, 10))
    const mentions = [att.uid, att.uid.slice(0, 18), att.uid.slice(2, 10)].map(grep)
    if (control === null || mentions.includes(null)) console.log(`  skip ${short}: git is unavailable here, so "no receipt on record" was not machine-checked`)
    else {
      check(`${short}: control: the same search finds the SAMPLE's own uid fragment in site/verify.html (the search works)`, control.includes("site/verify.html"), control.join(", "))
      check(`${short}: LIMIT: no tracked file names this uid (full, 18 characters, or 8 hex digits), so its receipt (settlement tx, payer) is not on record and its payment is NOT checked. A receipt added later fails this on purpose: upgrade it`, mentions.every((m) => m.length === 0), mentions.flat().join(", "))
    }
  }
}
check("a receipt with NO ruleset at all (a v1 / pre-ruleset receipt) maps as PM: the SAMPLE intent recomputes", !!PM_GOLDEN && pageHash(PM_GOLDEN, undefined) === GOLDEN_HASH)

// ── 4. a perp-route receipt whose body carries `market` ─────────────────────────────
console.log("4. a perp-route receipt whose body carries `market` recomputes; the ruleset, not the keys, decides")
const PERP = {
  instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance",
  thesis: "Funding reset to 2% after the weekend flush; 80K held on the daily close; ETF inflows resumed. Invalidation: daily close below 76,200. Oracle: Binance mark price.",
}
const PERP_PINNED = "0xb7fbfdab14efbc842bd235439b995791f160610b266ea154dd52a43631ed8c19"
const { instrument: _i, ...PERP_REST } = PERP
const marketOnly = { ...PERP_REST, market: "BTC-PERP" }
const both = { ...PERP, market: "KXBTC-OTHER" }
const LF = "DJZS-LF-v1.2"
check("perp ruleset + the `instrument` spelling: the pinned perp key", pageHash(PERP, LF) === PERP_PINNED)
check("perp ruleset + a body carrying `market` and NO `instrument`: the same pinned key (the case the old rule could not recompute)", pageHash(marketOnly, LF) === PERP_PINNED, pageHash(marketOnly, LF))
check("perp ruleset + a body carrying BOTH keys: the same pinned key (instrument wins)", pageHash(both, LF) === PERP_PINNED)
check("…and each equals the Worker's perp-route hash", [PERP, marketOnly, both].every((b) => intentHash(toDJZSIntent(b, "perp")) === pageHash(b, LF)))
check("the perp struct the page builds is perp_trade, with the levels bound through params_hash", page.toDJZSIntent(marketOnly, "perp").action === "perp_trade" && page.toDJZSIntent(marketOnly, "perp").params_hash === keccak256(new TextEncoder().encode("leverage=5|entry=78900|stop_loss=76200|take_profit=83000")))

// the keys no longer pick the class: the same perp-shaped body under a PM ruleset is NOT the perp key
let pmOfPerp = null
try { pmOfPerp = pageHash(PERP, "DJZS-PM-v1.0") } catch (e) { pmOfPerp = `threw: ${e.message}` }
check("a perp-shaped body under a PM ruleset does NOT recompute to the perp key (it used to, by shape)", pmOfPerp !== PERP_PINNED, String(pmOfPerp))
check("a perp-shaped body with no ruleset does NOT recompute to the perp key either", (() => { try { return pageHash(PERP, undefined) !== PERP_PINNED } catch { return true } })())
check("a PM-shaped body under a perp ruleset takes the perp mapping (action perp_trade)", page.toDJZSIntent(PM_GOLDEN, "perp").action === "perp_trade")

// ── 5. the page and the Worker are the same function ────────────────────────────────
console.log("5. page mapping == Worker mapping over a corpus, on both routes")
const corpus = [
  PM_GOLDEN, PERP, marketOnly, both,
  { ...PM_GOLDEN, venue: "Kalshi" }, { ...PM_GOLDEN, bounds: undefined }, { ...PM_GOLDEN, bounds: { max_loss_usd: 12.345 } }, { ...PM_GOLDEN, size_usd: undefined },
  { ...PM_GOLDEN, instrument: "BTC-PERP", leverage: 5 },
  { ...PERP, invalidation: "daily close below 76,200" }, { ...PERP, invalidation: "" }, { ...PERP, stop_loss: undefined }, { ...PERP, stop_loss: Number.NaN },
  { ...PERP, data_sources: "Binance funding" }, { ...PERP, leverage: undefined, entry: undefined, take_profit: undefined },
  { ...PERP, instrument: 7, market: "ETH-PERP" }, { ...PERP, instrument: "", market: "ETH-PERP" },
  { market: "m", side: "YES", thesis: "t" }, { market: "m", side: "YES", thesis: " " },
  { ...PM_GOLDEN, thesis: 0 }, { ...PM_GOLDEN, side: false },
  { ...PM_GOLDEN, thesis: "" }, { ...PM_GOLDEN, thesis: null }, { ...PM_GOLDEN, side: undefined }, { ...PM_GOLDEN, market: undefined },
  { ...PERP, instrument: undefined }, { ...PERP, thesis: "" }, { ...PERP, side: null },
  { side: "LONG", thesis: "neither key" }, {},
]
const render = (s) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v === undefined ? "<undefined>" : v))
let compared = 0, refusedByWorker = 0, diffs = []
for (const body of corpus) {
  for (const [route, ruleset] of [["pm", "DJZS-PM-v1.0"], ["perp", "DJZS-LF-v1.2"]]) {
    let w = null
    try { w = toDJZSIntent(body, route) } catch (e) { if (!(e instanceof IntentUnbindableError)) diffs.push(`${route}: worker threw a non-named error ${e}`); else refusedByWorker++; continue }
    let p
    try { p = page.toDJZSIntent(body, page.routeFor(ruleset)) } catch (e) { diffs.push(`${route}: page threw ${e.message}`); continue }
    compared++
    if (render(w) !== render(p)) diffs.push(`${route}: ${render(w).slice(0, 120)} != ${render(p).slice(0, 120)}`)
  }
}
check(`${compared} bound (body, route) pairs: the page builds the Worker's struct field for field`, diffs.length === 0 && compared >= 30, `compared ${compared}; ` + diffs.join(" | "))
check(`${refusedByWorker} pairs the Worker refuses as missing/empty: the page still hashes them where it can (historic receipts), it never invents a different class`, refusedByWorker >= 10)
const refusedPageClass = corpus.every((b) => ["pm", "perp"].every((route) => {
  try { toDJZSIntent(b, route); return true } catch { /* named refusal */ }
  try { return page.toDJZSIntent(b, route).action === (route === "pm" ? "pm_trade" : "perp_trade") } catch { return true }
}))
check("for every body the Worker refuses, the page's class is still the route's", refusedPageClass)

// ── 6. run() reads the attestation first and passes the route ──────────────────────
console.log("6. run() order and wiring")
const iRead = script.indexOf("// 2a: the attestation is READ before the binding")
const iBind = script.indexOf("// 2: binding;")
check("the attestation is read (2a) BEFORE the binding is computed (2)", iRead > 0 && iBind > iRead, `${iRead} ${iBind}`)
check("the binding is computed with toDJZSIntent(r.intent, route)", script.includes("message:toDJZSIntent(r.intent,route)"))
check("the route comes from routeFor(the attested ruleset, else the receipt's declared ruleset, else none)", script.includes("route=routeFor(rulesetUsed)") && /attRuleset\?\?r\?\.tally\?\.ruleset\?\?r\?\.ruleset\?\?""/.test(script))
check("step 3 reuses the one read (the getAttestation call is encoded once)", script.split('encodeFunctionData({abi:EAS_ABI,functionName:"getAttestation"').length - 1 === 1)
check("no body-shape classifier is left in the page", !/typeof \w+\.instrument==="string"&&typeof \w+\.market!=="string"/.test(script) && !/isPerpIntent/.test(script))
check("the binding evidence line names the mapping and where the ruleset came from", script.includes("mapping     ${route===") && script.includes("from ${rulesetFrom}"))

if (failures.length) {
  console.error(`\nVERIFY-PAGE: FAIL (${failures.length} of ${n} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nVERIFY-PAGE: PASS (${n} checks)`)
