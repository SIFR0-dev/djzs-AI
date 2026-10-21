/**
 * site/verify.html, hardened (marker djzs-verify-hardening-1): DOM tests that EXECUTE the page's run().
 * Offline, no key, no network, no browser.
 *
 * What runs: the page's real module script, unmodified except for two test-only edits: the one viem import is
 * pointed at the local node_modules copy of the same package, and an `export { render, setV, esc, safeHref }`
 * line is appended so the sinks can also be driven directly with hostile values for every parameter. It runs under a minimal DOM shim (querySelector, value,
 * textContent, innerHTML, dataset, onclick), with fetch stubbed to chain-shaped JSON-RPC answers: the
 * SAMPLE settlement, and the attestation 0xc59959896c7663314da81e153134f23782315887e643ca60e38bb9f915a05a89 as read from Base on 2026-10-21. Clicking Recompute
 * is `await onclick()`, so run() really executes.
 *
 * What is checked in what run() wrote:
 *   - the SAMPLE receipt still reads PASS, with settlement, v2 binding and attestation all PROVEN;
 *   - main's mapping is untouched: a perp receipt (instrument, no market) still binds and passes;
 *   - a forged receipt (a made-up intent that cannot be EIP-712 hashed, a self-consistent intent_sha256,
 *     and the REAL intent_hash / eas_uid / payment of another receipt) never reads PASS, and every other
 *     way of failing to recompute is checked the same way;
 *   - a markup payload placed in EACH string leaf of the receipt, in a node's error message, in the Irys
 *     index's error, and in the attestation's own fields, produces HTML whose every element and attribute is
 *     in the template's allow-list (the HTML is tokenised by workerd's HTMLRewriter, a real HTML parser,
 *     not by a regex), never a script, img, svg or event-handler attribute, and the payload survives as
 *     literal text; every href is an allow-listed https URL or "#";
 *   - a run() that throws (a null or non-object receipt, a non-string intent_sha256, a verdict_hash whose
 *     toString throws) or whose links cannot be built (a lone UTF-16 surrogate in transaction, eas_uid or
 *     the Irys id) never leaves the previous PASS on screen, never leaves the Recompute button stuck, and
 *     ends as FAIL (unreadable) or WAIT (unproven);
 *   - a receipt whose intent hashes but whose intent_hash is not a string is a v2 MISMATCH (FAIL), never
 *     the "could not be hashed" UNBOUND downgrade;
 *   - the PASS ladder one rung at a time (section 6): every way settlement, the v1 and v2 bindings, the
 *     attestation (attester, schema, revocation, uid echo, each attested field) or the certificate's signer
 *     can fail reads its exact state and chip, so deleting any one comparison turns a check red;
 *   - the Recompute / Clear / Load buttons, the #r= fragment path (a second import of the page with the
 *     hash set), and the fact that innerHTML is assigned in exactly three places, only ever on #ledger
 *     and #vnote.
 *
 * Known limits, stated so the check count is not read as more than it is: the viem under test is the
 * repo's pinned copy, the page loads its own pinned version from esm.sh; the dormant v3 / resolver branch
 * (DJZS_RESOLVER is empty) is not exercised; and a Clear / Load / edit made while a run is in flight does
 * not cancel that run (pre-existing, not part of this hotfix).
 *
 * A DOM shim is not a browser. The same cases were also run in headless Chromium against this page, and the
 * post-deploy check runs them against djzs.ai/verify; this test is the part CI can run on every push.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/verify-dom.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Miniflare } from "miniflare"
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem"

let n = 0
const failures = []
function check(label, ok, detail) {
  n++
  if (ok) console.log(`  ok   ${label}`)
  else { failures.push(label); console.error(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}

setTimeout(() => { console.error("VERIFY-DOM: TIMEOUT after 120s"); process.exit(1) }, 120_000).unref()

// ── the page ──────────────────────────────────────────────────────────────────────────
const html = readFileSync("../site/verify.html", "utf8")
check("verify.html carries the marker djzs-verify-hardening-1 exactly once", html.split("djzs-verify-hardening-1").length === 2)
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""
const patched = script.replace(/from "https:\/\/esm\.sh\/viem@[^"]+"/, `from "${import.meta.resolve("viem")}"`)
check("the page's viem import was re-pointed at node_modules (the only edit to the script besides the test-only export line)", patched !== script && !patched.includes("esm.sh"))
const DJZS_IRYS_SIGNER = /const DJZS_IRYS_SIGNER="(0x[0-9a-f]{40})"/.exec(script)?.[1] ?? ""
const DJZS_SCHEMA = /const DJZS_SCHEMA="(0x[0-9a-f]{64})"/.exec(script)?.[1] ?? ""
check("the page's schema and Irys signer constants were found", !!DJZS_IRYS_SIGNER && !!DJZS_SCHEMA)

// ── a minimal DOM + a stubbed network ─────────────────────────────────────────────────
const els = new Map()
const innerHTMLWrites = [] // [selector, value] for every innerHTML assignment the page makes, to prove which elements it ever writes markup to
const el = (sel) => { if (!els.has(sel)) els.set(sel, { sel, value: "", textContent: "", get innerHTML() { return this._h ?? "" }, set innerHTML(v) { innerHTMLWrites.push([sel, String(v)]); this._h = v }, hidden: true, dataset: {}, disabled: false, onclick: null }); return els.get(sel) }
globalThis.document = { querySelector: el, title: "" }
globalThis.location = { hash: "", pathname: "/verify" }
globalThis.history = { replaceState() {} }

const EAS_ABI = parseAbi(["function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))"])
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const RPC_HOSTS = ["base.llamarpc.com", "base-rpc.publicnode.com", "mainnet.base.org", "1rpc.io"]
const net = { attestations: new Map(), txReceipts: new Map(), rpcError: null, onlyMethod: null, irysError: null, irysSigner: null, gate: null, unexpected: [] }
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } })
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase()
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url))
  if (RPC_HOSTS.includes(u.host)) {
    if (net.gate) await net.gate // a test can hold every node answer to look at the page mid-run
    const body = JSON.parse(init?.body ?? "{}")
    if (net.rpcError && (!net.onlyMethod || net.onlyMethod === body.method)) return json({ jsonrpc: "2.0", id: body.id, error: { message: net.rpcError } })
    if (body.method === "eth_getTransactionReceipt") return json({ jsonrpc: "2.0", id: body.id, result: net.txReceipts.get(String(body.params[0]).toLowerCase()) ?? null })
    if (body.method === "eth_call") {
      const uid = "0x" + body.params[0].data.slice(10, 74)
      const a = net.attestations.get(uid.toLowerCase())
      return json({ jsonrpc: "2.0", id: body.id, result: a ? encodeFunctionResult({ abi: EAS_ABI, functionName: "getAttestation", result: a }) : "0x" + "00".repeat(32 * 12) })
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { message: "unsupported method in the test stub" } })
  }
  if (u.host === "uploader.irys.xyz") {
    if (net.irysError) throw new Error(net.irysError)
    return json({ data: { transactions: { edges: [{ node: { id: "x", address: net.irysSigner ?? DJZS_IRYS_SIGNER } }] } } })
  }
  net.unexpected.push(String(url))
  throw new Error("unexpected network call in test: " + String(url))
}

const dir = mkdtempSync(path.join(tmpdir(), "verify-dom-"))
writeFileSync(path.join(dir, "page.mjs"), patched + "\nexport { render, setV, esc, safeHref };\n")
const page = await import(pathToFileURL(path.join(dir, "page.mjs")).href)
rmSync(dir, { recursive: true, force: true })
check("the page's own script ran to completion at import (it wired Recompute and loaded its SAMPLE)", typeof el("#run").onclick === "function" && el("#rcpt").value.includes("eas_uid"))
const SAMPLE = JSON.parse(el("#rcpt").value)

// ── fixtures: the SAMPLE settlement and attestation, chain-shaped ─────────────────────
// Attested payload of 0xc59959896c7663314da81e153134f23782315887e643ca60e38bb9f915a05a89 as read from the EAS contract on Base, 2026-10-21 (PASS, 0, [], DJZS-PM-v1.0).
const SAMPLE_ATTESTED = "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb20600000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000450415353000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c444a5a532d504d2d76312e300000000000000000000000000000000000000000"
const ATTESTER = "0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824"
const attestation = (uid, data) => ({ uid, schema: DJZS_SCHEMA, time: 1788294891n, expirationTime: 0n, revocationTime: 0n, refUID: "0x" + "00".repeat(32), recipient: "0x46448Ea69912Aa8E2191dde67839A4987D269d17", attester: ATTESTER, revocable: false, data })
const encodeAtt = (ih, verdict, risk, flags, ruleset) => encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "string[]" }, { type: "string" }], [ih, verdict, risk, flags, ruleset])
const settlementReceipt = (payer, payTo, micro) => ({ status: "0x1", blockNumber: "0x2faf080", logs: [{ address: USDC, topics: [XFER, pad(payer), pad(payTo)], data: "0x" + micro.toString(16).padStart(64, "0") }] })
function reset() {
  net.attestations.clear(); net.txReceipts.clear(); net.rpcError = null; net.irysError = null; net.onlyMethod = null; net.irysSigner = null
  net.attestations.set(SAMPLE.eas_uid.toLowerCase(), attestation(SAMPLE.eas_uid, SAMPLE_ATTESTED))
  net.txReceipts.set(SAMPLE.payment_response.transaction.toLowerCase(), settlementReceipt(SAMPLE.payment_response.payer, SAMPLE.pay_to, 2_000_000))
}

// ── the HTML oracle: workerd's HTMLRewriter (a real tokenizer) in Miniflare ───────────
const mf = new Miniflare({
  modules: true, compatibilityDate: "2026-06-01",
  script: `export default { async fetch(req) { const html = await req.text(); const els = []; let text = "";
    await new HTMLRewriter().on("*", { element(e) { els.push({ tag: e.tagName, attrs: [...e.attributes] }) }, text(t) { text += t.text } }).transform(new Response(html)).text();
    return Response.json({ els, text }) } }`,
})
const parse = async (h) => (await mf.dispatchFetch("http://oracle.test/", { method: "POST", body: h })).json()
const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: "\u00a0" }
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, d, x, nm) => d ? String.fromCharCode(Number(d)) : x ? String.fromCharCode(parseInt(x, 16)) : nm in NAMED ? NAMED[nm] : m)
const ALLOWED = { div: ["class", "data-r"], span: ["class"], p: ["class"], a: ["href", "target", "rel"] }
// independent of the page's own HREF_OK: an allow-listed https prefix and an encoded tail, or "#"
const hrefOk = (h) => h === "#" || /^https:\/\/(basescan\.org\/tx|base\.easscan\.org\/attestation\/view|gateway\.irys\.xyz)\/[A-Za-z0-9._~%-]*$/.test(h)
async function structure(htmlOut) {
  const p = await parse(htmlOut)
  const problems = []
  for (const e of p.els) {
    const tag = e.tag.toLowerCase()
    if (!ALLOWED[tag]) { problems.push(`element <${tag}>`); continue }
    for (const [name, value] of e.attrs) {
      if (!ALLOWED[tag].includes(name.toLowerCase())) problems.push(`attribute ${name} on <${tag}>`)
      if (tag === "a" && name === "href" && !hrefOk(value)) problems.push(`href ${value}`)
      if (name === "data-r" && !["pass", "wait", "fail", "idle"].includes(value)) problems.push(`data-r ${value}`)
    }
  }
  return { problems, text: decode(p.text), count: p.els.length }
}

// ── run the page ───────────────────────────────────────────────────────────────────────
async function recompute(receipt, { keepPrevious = false } = {}) {
  el("#rcpt").value = typeof receipt === "string" ? receipt : JSON.stringify(receipt)
  if (!keepPrevious) el("#verdict").hidden = true // keepPrevious: leave what the last run drew, as a viewer would see it
  await el("#run").onclick()
  const ledger = el("#ledger").innerHTML
  const rows = [...ledger.matchAll(/<div class="claim" data-r="(\w+)"><span class="tok">([^<]*)<\/span><p class="claim-name">([^<]*)<span class="chip">([^<]*)<\/span>/g)].map((m) => ({ r: m[1], name: decode(m[3]), chip: decode(m[4]) }))
  return { state: el("#verdict").dataset.state, stamp: el("#vstamp").textContent, title: el("#vtitle").textContent, hidden: el("#verdict").hidden, button: { text: el("#run").textContent, disabled: el("#run").disabled }, ledger, vnote: el("#vnote").innerHTML, rows }
}
const row = (res, name) => res.rows.find((r) => r.name === name)

// ── 1. the control: the SAMPLE receipt still passes ───────────────────────────────────
console.log("1. the SAMPLE receipt still passes")
reset()
const ok = await recompute(SAMPLE)
check("SAMPLE: PASS, fully reproduced", ok.state === "pass" && ok.stamp === "PASS" && /fully reproduced/.test(ok.title), `${ok.state} ${ok.stamp} ${ok.title}`)
check("SAMPLE: settlement, v2 binding, v1 binding and attestation are all PROVEN", ["Settlement on Base", "Intent binding · v2", "Intent binding · v1 (intent_sha256)", "Attestation on Base"].every((nm) => row(ok, nm)?.chip === "PROVEN"), JSON.stringify(ok.rows))
const okStruct = await structure(ok.ledger)
check("SAMPLE: the ledger HTML is within the allow-list and carries real content", okStruct.problems.length === 0 && okStruct.count > 20, okStruct.problems.join("; "))
check("SAMPLE: the verdict note is within the allow-list", (await structure(ok.vnote)).problems.length === 0)

// main's mapping is untouched: a perp receipt (instrument, no market) keeps binding by body shape, as on main
const PERP = { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance", thesis: "Funding reset to 2% after the weekend flush; 80K held on the daily close; ETF inflows resumed. Invalidation: daily close below 76,200. Oracle: Binance mark price." }
const PERP_PINNED = "0xb7fbfdab14efbc842bd235439b995791f160610b266ea154dd52a43631ed8c19"
const PERP_UID = "0x" + "77".repeat(32)
reset()
net.attestations.set(PERP_UID, attestation(PERP_UID, encodeAtt(PERP_PINNED, "FAIL", 30, ["DJZS-S01"], "DJZS-LF-v1.2")))
const perp = await recompute({ ...SAMPLE, intent: PERP, intent_hash: PERP_PINNED, intent_sha256: undefined, verdict: "FAIL", risk_score: 30, flags: ["DJZS-S01"], eas_uid: PERP_UID })
check("main's mapping is unchanged: a perp-shaped body still recomputes to the pinned perp key and passes", perp.state === "pass" && row(perp, "Intent binding · v2")?.chip === "PROVEN", `${perp.state} ${JSON.stringify(perp.rows)}`)

// ── 2. forged receipts never read PASS ────────────────────────────────────────────────
console.log("2. a forged receipt never reads PASS")
const sha = async (t) => { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return "0x" + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") }
const renderText = (i) => typeof i === "string" ? i : Object.keys(i).sort().map((k) => `${k}: ${typeof i[k] === "string" ? i[k] : typeof i[k] === "number" || typeof i[k] === "boolean" ? String(i[k]) : JSON.stringify(i[k])}`).join("\n")
const MADE_UP = { side: "YES", thesis: "nothing in this text was ever audited or attested" } // no market: the EIP-712 recompute throws
reset()
const forged = await recompute({ ...SAMPLE, intent: MADE_UP, intent_sha256: await sha(renderText(MADE_UP)) })
check("forged (unhashable intent, self-consistent sha256, real intent_hash/eas_uid/payment): NOT PASS", forged.state !== "pass" && forged.stamp !== "PASS", `${forged.state} ${forged.stamp}`)
check("…it reads WAIT: the v2 row is ERROR and the attestation row is UNBOUND, not PROVEN", forged.state === "wait" && row(forged, "Intent binding · v2")?.chip === "ERROR" && row(forged, "Attestation on Base")?.chip === "UNBOUND", JSON.stringify(forged.rows))
check("…the v1 row alone no longer makes it bound (it is PROVEN and the verdict is still not PASS)", row(forged, "Intent binding · v1 (intent_sha256)")?.chip === "PROVEN" && forged.stamp !== "PASS")

const variants = [
  ["a string intent", { intent: "hello", intent_sha256: await sha("hello") }],
  ["a null intent with only intent_sha256", { intent: null, intent_sha256: await sha("null") }],
  ["an intent that hashes but is not the attested one (recompute OK, mismatch)", { intent: { market: "KXOTHER", side: "YES", thesis: "a different claim" }, intent_sha256: await sha(renderText({ market: "KXOTHER", side: "YES", thesis: "a different claim" })) }],
  ["an unhashable intent AND no intent_sha256", { intent: MADE_UP, intent_sha256: undefined }],
  ["an unhashable intent AND no intent_hash", { intent: MADE_UP, intent_hash: undefined, intent_sha256: await sha(renderText(MADE_UP)) }],
  ["the real intent with its intent_hash removed (only the v1 row can speak)", { intent_hash: undefined }],
  ["an unhashable intent AND a verdict the chain contradicts", { intent: MADE_UP, intent_sha256: await sha(renderText(MADE_UP)), verdict: "FAIL" }],
]
for (const [label, patch] of variants) {
  reset()
  const r = await recompute({ ...SAMPLE, ...patch })
  check(`forged: ${label}: NOT PASS (${r.stamp})`, r.state !== "pass" && r.stamp !== "PASS", JSON.stringify(r.rows))
}
reset()
const contradicted = await recompute({ ...SAMPLE, intent: MADE_UP, intent_sha256: await sha(renderText(MADE_UP)), verdict: "FAIL" })
check("an unhashable intent that the chain ALSO contradicts is CONTRADICTED (FAIL), not merely UNBOUND", contradicted.state === "fail" && row(contradicted, "Attestation on Base")?.chip === "CONTRADICTED", JSON.stringify(contradicted.rows))

// ── 3. markup never reaches the DOM as markup ─────────────────────────────────────────
console.log("3. a markup payload in each receipt field never becomes markup")
const PAYLOAD = `"><img src=x onerror=window.__xss=1>'><svg onload=window.__xss=1></span></div><script>window.__xss=1</script>&lt;b&gt;&amp; javascript:alert(1) x" onmouseover="window.__xss=1`
const leaves = []
;(function walk(v, p) { if (typeof v === "string") leaves.push(p); else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i])); else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], [...p, k]) })(SAMPLE, [])
const withLeaf = (p, value) => { const c = structuredClone(SAMPLE); let o = c; for (const k of p.slice(0, -1)) o = o[k]; o[p[p.length - 1]] = value; return c }
check(`the SAMPLE receipt has string leaves to attack (${leaves.length})`, leaves.length >= 15, String(leaves.length))
let displayed = 0, structureFailures = [], unexpectedBefore = net.unexpected.length
for (const p of leaves) {
  reset()
  const r = await recompute(withLeaf(p, PAYLOAD))
  const s = await structure(r.ledger), v = await structure(r.vnote)
  if (s.problems.length || v.problems.length) structureFailures.push(`${p.join(".")}: ${[...s.problems, ...v.problems].join("; ")}`)
  if (s.text.includes(PAYLOAD)) displayed++
}
check(`payload in each of the ${leaves.length} string leaves: every element, attribute and href of the output is in the allow-list`, structureFailures.length === 0, structureFailures.join(" | "))
check(`the oracle is not vacuous: the payload came back as literal text in ${displayed} of those runs (>= 3)`, displayed >= 3, String(displayed))

// links: the dynamic tails of the hrefs
const hrefAttack = ['javascript:alert(1)', 'x" onmouseover="window.__xss=1', "../../etc?x=1#y", "https://evil.example/", "a b"]
let hrefBad = []
for (const v of hrefAttack) {
  for (const p of [["payment_response", "transaction"], ["eas_uid"]]) {
    reset()
    const r = await recompute(withLeaf(p, v))
    const s = await structure(r.ledger)
    if (s.problems.length) hrefBad.push(`${p.join(".")}=${v}: ${s.problems.join("; ")}`)
  }
}
check(`hostile transaction / eas_uid values never produce an attribute or a href outside the allow-list (${hrefAttack.length * 2} runs)`, hrefBad.length === 0, hrefBad.join(" | "))

// a node, the Irys index, and the attestation itself are untrusted too
reset(); net.rpcError = PAYLOAD
const rpcErr = await recompute(SAMPLE)
const rpcS = await structure(rpcErr.ledger)
check("payload as a Base node's error message: allow-listed output, and it is shown as text", rpcS.problems.length === 0 && rpcS.text.includes(PAYLOAD), rpcS.problems.join("; "))
reset(); net.irysError = PAYLOAD
const irys = await recompute({ ...SAMPLE, pol_certificate: { irys_id: "Abc123" } })
const irysS = await structure(irys.ledger)
check("payload as the Irys index's error: allow-listed output, and it is shown as text", irysS.problems.length === 0 && irysS.text.includes(PAYLOAD), irysS.problems.join("; "))
reset()
net.attestations.set(SAMPLE.eas_uid.toLowerCase(), attestation(SAMPLE.eas_uid, encodeAtt("0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb206", PAYLOAD, 0, [PAYLOAD], PAYLOAD)))
const hostileAtt = await recompute(SAMPLE)
const attS = await structure(hostileAtt.ledger)
check("payload in the attestation's verdict, flags and ruleset: allow-listed output, shown as text, and the receipt is contradicted", attS.problems.length === 0 && attS.text.includes(PAYLOAD) && hostileAtt.state === "fail", `${attS.problems.join("; ")} ${hostileAtt.state}`)

// the sinks driven directly: every parameter of render() and setV() with hostile values, whatever run() feeds them today
console.log("4. render() and setV(), every parameter, hostile values")
const FIELD_PAYLOADS = [PAYLOAD, `x" onmouseover="window.__xss=1`, `'><svg onload=window.__xss=1>`, `&lt;b&gt;&amp;&#60;&#x3c;`]
let direct = [], directText = 0
for (const field of ["r", "tok", "name", "chip", "body", "ev", "linkText", "linkHref"]) {
  for (const payload of FIELD_PAYLOADS) {
    const c = { r: "pass", tok: "OK", name: "Name", chip: "CHIP", body: "body", ev: "ev", link: ["label", "https://basescan.org/tx/abc"] }
    if (field === "linkText") c.link[0] = payload; else if (field === "linkHref") c.link[1] = payload; else c[field] = payload
    page.render([c])
    const out = el("#ledger").innerHTML
    const s = await structure(out)
    if (s.problems.length && !(field === "r")) direct.push(`${field}: ${s.problems.join("; ")}`)
    if (field === "r" && s.problems.some((pr) => !/^data-r /.test(pr))) direct.push(`r: ${s.problems.join("; ")}`) // an unknown data-r VALUE is the page being given a bad enum, not injection; any other problem is
    if (["tok", "name", "chip", "body", "ev", "linkText", "r"].includes(field)) { if (s.text.includes(payload)) directText++; else if (field !== "r") direct.push(`${field}: payload did not survive as text`) }
  }
}
check("render(): a hostile value in each of the 8 parameters (4 payloads each) yields only allow-listed elements, attributes and hrefs, and text parameters keep the payload as literal text", direct.length === 0 && directText >= 20, `${directText} ${direct.join(" | ")}`)
let setvBad = []
for (const payload of FIELD_PAYLOADS) {
  page.setV("pass", "PASS", payload, payload, payload)
  const s = await structure(el("#vnote").innerHTML)
  if (s.problems.length || !s.text.includes(payload)) setvBad.push(`${payload.slice(0, 20)}: ${s.problems.join("; ")} text=${s.text.includes(payload)}`)
  if (el("#vtitle").textContent !== "// " + payload) setvBad.push("vtitle is not set as text")
}
check("setV(): a hostile note and coda come out as allow-listed markup and literal text (title and stamp are set via textContent)", setvBad.length === 0, setvBad.join(" | "))
check("esc(): the six characters that matter are all neutralised, once (no double escaping of an escaped value)", page.esc(`&<>"'\``) === "&#38;&#60;&#62;&#34;&#39;&#96;" && page.esc("&#38;") === "&#38;#38;" && page.esc(null) === "" && page.esc(undefined) === "" && page.esc(0) === "0")
check("safeHref(): only the three allow-listed https prefixes with an encoded tail survive", page.safeHref("https://basescan.org/tx/0xabc") === "https://basescan.org/tx/0xabc" && ["javascript:alert(1)", "https://evil.example/", "https://basescan.org/tx/a b", 'https://basescan.org/tx/a"b', "https://basescan.org/tx/a/../b", "//basescan.org/tx/a", "http://basescan.org/tx/a", "https://basescan.org.evil.example/tx/a", "https://basescan.org/tx/a?x=1", "https://basescan.org/tx/a#y", "https://basescan.org/tx/a:b", "https://basescan.org/tx/a@b", ""].every((u) => page.safeHref(u) === "#"))

// the dynamic tail of a link is encoded, so an odd but harmless value still links correctly instead of falling back to "#"
reset()
net.txReceipts.set("0xabc def", settlementReceipt(SAMPLE.payment_response.payer, SAMPLE.pay_to, 2_000_000)) // so the settlement row finds its receipt and renders its link
const spaced = await recompute(withLeaf(["payment_response", "transaction"], "0xabc def"))
const spacedHref = [...spaced.ledger.matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1]))
check("a transaction value with a space is linked percent-encoded (the encoding is doing its job, not the allow-list falling back to #)", spacedHref.includes("https://basescan.org/tx/0xabc%20def"), spacedHref.join(" "))
reset()
const spacedUid = await recompute(withLeaf(["eas_uid"], "0xabc def"))
const uidHref = [...spacedUid.ledger.matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1]))
check("an eas_uid value with a space is linked percent-encoded", uidHref.includes("https://base.easscan.org/attestation/view/0xabc%20def"), uidHref.join(" "))

// ── 5. a run that throws never leaves a stale PASS or a stuck button ──────────────────
console.log("5. a run that throws, a lone surrogate, a malformed intent_hash")
const LONE = "\ud800" // a lone UTF-16 surrogate: encodeURIComponent throws on it
async function afterPass(receipt, before) {
  reset()
  const first = await recompute(SAMPLE)
  if (first.state !== "pass") throw new Error("precondition: the SAMPLE must read PASS before the hostile run")
  if (before) before()
  try { return { first, threw: null, ...(await recompute(receipt, { keepPrevious: true })) } }
  catch (e) { return { first, threw: e, state: el("#verdict").dataset.state, stamp: el("#vstamp").textContent, title: "", hidden: el("#verdict").hidden, button: { text: el("#run").textContent, disabled: el("#run").disabled }, ledger: el("#ledger").innerHTML, rows: [] } }
}
const hrefs = (r) => [...r.ledger.matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1]))
const settled = (r) => r.threw === null && r.state !== "pass" && r.stamp !== "PASS" && r.button.text === "Recompute" && r.button.disabled === false && r.ledger !== r.first.ledger
const throwing = [
  ["a null receipt", "null", (r) => r.state === "fail" && /unreadable/.test(r.title)],
  ["a number as the receipt", "5", (r) => r.state === "fail" && /unreadable/.test(r.title)],
  ["intent_sha256 that is not a string", { ...SAMPLE, intent_sha256: 5 }, (r) => r.state === "wait" && row(r, "Recompute aborted")?.chip === "UNPROVEN"],
  ["a verdict_hash whose toString throws", { ...SAMPLE, verdict_hash: { toString: "x" } }, (r) => r.state === "wait" && r.rows.length === 1 && row(r, "Recompute aborted")?.chip === "UNPROVEN"],
]
for (const [label, receipt, extra] of throwing) {
  const r = await afterPass(receipt)
  check(`throwing run: ${label}: no stale PASS, Recompute re-enabled, ends ${r.stamp}`, settled(r) && extra(r), `${r.threw?.message ?? ""} ${r.state} ${r.stamp} ${r.button.text} ${r.button.disabled} ${JSON.stringify(r.rows)}`)
}
const abortedLedger = await structure((await afterPass({ ...SAMPLE, intent_sha256: 5 })).ledger)
check("the abort row is within the allow-list and its error text is shown", abortedLedger.problems.length === 0 && /toLowerCase|is not a function/.test(abortedLedger.text), abortedLedger.problems.join("; ") + abortedLedger.text.slice(0, 120))

const gatewayLinks = (r) => hrefs(r).filter((h) => h.startsWith("https://gateway.irys.xyz/")).length
const gatewayBaseline = gatewayLinks(await afterPass({ ...SAMPLE, pol_certificate: { irys_id: "Abc123" } }))
check("the oracle is not vacuous: an ordinary pol_certificate.irys_id adds a gateway link", gatewayBaseline >= 1, String(gatewayBaseline))
const surrogate = [
  ["transaction (node down, so the Basescan link is built)", () => withLeaf(["payment_response", "transaction"], LONE), () => { net.rpcError = "node down" }, (r) => !hrefs(r).some((h) => h.includes("basescan.org")) && row(r, "Settlement on Base")?.chip === "UNREACHABLE"],
  ["eas_uid", () => withLeaf(["eas_uid"], LONE), null, (r) => !hrefs(r).some((h) => h.includes("easscan.org")) && row(r, "Attestation on Base")?.chip === "UNREACHABLE"],
  ["pol_certificate.irys_id", () => ({ ...SAMPLE, pol_certificate: { irys_id: LONE } }), null, (r) => gatewayLinks(r) === gatewayBaseline - 1], // the register rows link to the gateway too, so compare with an ordinary id
]
for (const [label, make, before, extra] of surrogate) {
  const r = await afterPass(make(), before)
  const s = await structure(r.ledger)
  check(`lone surrogate in ${label}: the row loses its link, the run completes (no abort row), never PASS-by-staleness`, r.threw === null && row(r, "Recompute aborted") === undefined && r.button.text === "Recompute" && r.button.disabled === false && r.ledger !== r.first.ledger && s.problems.length === 0 && extra(r), `${r.threw?.message ?? ""} ${r.state} ${JSON.stringify(r.rows)} ${hrefs(r).join(" ")}`)
  if (label !== "pol_certificate.irys_id") check(`lone surrogate in ${label}: the receipt does not read PASS`, r.state !== "pass" && r.stamp !== "PASS", `${r.state} ${r.stamp}`)
}

// F3: only a failure to HASH the intent is "unbound"; a malformed intent_hash on an intent that hashes is a mismatch
const DIFFERENT = { market: "KXOTHER", side: "YES", thesis: "a different claim" }
for (const [label, ih] of [["a number", 5], ["an array holding the real hash", [SAMPLE.intent_hash]], ["an object", {}]]) {
  reset()
  const r = await recompute({ ...SAMPLE, intent: DIFFERENT, intent_sha256: undefined, intent_hash: ih })
  check(`a hashable but different intent with intent_hash as ${label}: FAIL, v2 MISMATCH, attestation CONTRADICTED (not UNBOUND)`, r.state === "fail" && row(r, "Intent binding · v2")?.chip === "MISMATCH" && row(r, "Attestation on Base")?.chip === "CONTRADICTED", JSON.stringify(r.rows))
}
reset()
const realBadHash = await recompute({ ...SAMPLE, intent_hash: 5 })
check("the REAL intent with intent_hash 5: v2 row is a MISMATCH and the receipt reads FAIL, never PASS", realBadHash.state === "fail" && row(realBadHash, "Intent binding · v2")?.chip === "MISMATCH", `${realBadHash.state} ${JSON.stringify(realBadHash.rows)}`)

// nothing from the previous run stays on screen while a new one is in flight
reset()
await recompute(SAMPLE)
let release; net.gate = new Promise((res) => { release = res })
el("#rcpt").value = JSON.stringify(SAMPLE)
const inflight = el("#run").onclick()
await new Promise((res) => setTimeout(res, 25))
const mid = { hidden: el("#verdict").hidden, ledger: el("#ledger").innerHTML, disabled: el("#run").disabled, text: el("#run").textContent }
release(); net.gate = null
await inflight
check("while a run is in flight the previous verdict is hidden, the ledger is the placeholder and the button reads Recomputing", mid.hidden === true && /Awaiting a receipt/.test(mid.ledger) && mid.disabled === true && mid.text === "Recomputing…", JSON.stringify(mid).slice(0, 200))
check("…and when the gated run completes the SAMPLE reads PASS again and the button is back", el("#verdict").dataset.state === "pass" && el("#verdict").hidden === false && el("#run").disabled === false && el("#run").textContent === "Recompute")

// ── 6. the PASS ladder, one rung at a time (every way a rung can fail reads its exact state and chip) ──
console.log("6. the PASS ladder: settlement, attestation, binding, provenance, buttons, the #r= fragment")
const SAMPLE_TX = SAMPLE.payment_response.transaction.toLowerCase()
const IH = SAMPLE.intent_hash
const hrefsOf = hrefs

// X01 tampered intent_sha256 alone: v1 contradicts, v2/attestation/settlement are real -> FAIL, never PASS
reset()
const x01 = await recompute({ ...SAMPLE, intent_sha256: "0x" + "ab".repeat(32) })
check("X01 a wrong intent_sha256 with everything else real reads FAIL (v1 MISMATCH drags the verdict)", x01.state === "fail" && row(x01, "Intent binding · v1 (intent_sha256)")?.chip === "MISMATCH", `${x01.state} ${JSON.stringify(x01.rows)}`)

// X02 PASS needs an attestation that is on chain
reset()
const noUid = { ...SAMPLE }; delete noUid.eas_uid
const x02a = await recompute(noUid)
check("X02a no eas_uid: WAIT 'attestation not on chain', never PASS", x02a.state === "wait" && /attestation not on chain/.test(x02a.title), `${x02a.state} ${x02a.title}`)
check("X02a' …and its note keeps the apostrophe as text (not double-escaped)", decode(x02a.vnote).includes("isn't yet on the public record"), x02a.vnote.slice(0, 300))
reset(); net.onlyMethod = "eth_call"; net.rpcError = "attestation node down"
const x02b = await recompute(SAMPLE)
check("X02b attestation read unreachable (settlement fine): WAIT, never PASS", x02b.state === "wait" && row(x02b, "Attestation on Base")?.chip === "UNREACHABLE", `${x02b.state} ${JSON.stringify(x02b.rows)}`)
reset(); net.attestations.clear()
const x02c = await recompute(SAMPLE)
check("X02c no attestation at the UID: FAIL NOT FOUND", x02c.state === "fail" && row(x02c, "Attestation on Base")?.chip === "NOT FOUND", `${x02c.state} ${JSON.stringify(x02c.rows)}`)

// X03 PASS needs a settlement that is proven
reset(); net.txReceipts.clear()
const x03 = await recompute(SAMPLE)
check("X03 unknown transaction: WAIT (NOT FOUND), never PASS", x03.state === "wait" && row(x03, "Settlement on Base")?.chip === "NOT FOUND", `${x03.state} ${JSON.stringify(x03.rows)}`)

// X04 each way the settlement can contradict the receipt reads FAIL
const goodRc = settlementReceipt(SAMPLE.payment_response.payer, SAMPLE.pay_to, 2_000_000)
const settleCases = [
  ["pay_to differs", { ...goodRc, logs: [{ ...goodRc.logs[0], topics: [XFER, pad(SAMPLE.payment_response.payer), pad("0x" + "99".repeat(20))] }] }],
  ["amount differs", settlementReceipt(SAMPLE.payment_response.payer, SAMPLE.pay_to, 1_000_000)],
  ["tx status 0x0", { ...goodRc, status: "0x0" }],
  ["no Transfer log", { ...goodRc, logs: [] }],
  ["Transfer from another token", { ...goodRc, logs: [{ ...goodRc.logs[0], address: "0x" + "55".repeat(20) }] }],
]
for (const [label, rc] of settleCases) {
  reset(); net.txReceipts.set(SAMPLE_TX, rc)
  const r = await recompute(SAMPLE)
  check(`X04 settlement ${label}: FAIL MISMATCH`, r.state === "fail" && row(r, "Settlement on Base")?.chip === "MISMATCH", `${r.state} ${JSON.stringify(r.rows)}`)
}

// X05 each way the on-chain attestation can contradict the receipt reads FAIL / CONTRADICTED
const okAtt = attestation(SAMPLE.eas_uid, SAMPLE_ATTESTED)
const attCases = [
  ["attester is not DJZS", { ...okAtt, attester: "0x" + "11".repeat(20) }],
  ["schema is not the DJZS schema", { ...okAtt, schema: "0x" + "22".repeat(32) }],
  ["attestation revoked", { ...okAtt, revocationTime: 5n }],
  ["risk differs", { ...okAtt, data: encodeAtt(IH, "PASS", 7, [], "DJZS-PM-v1.0") }],
  ["flags differ", { ...okAtt, data: encodeAtt(IH, "PASS", 0, ["DJZS-M01"], "DJZS-PM-v1.0") }],
  ["intentHash differs", { ...okAtt, data: encodeAtt("0x" + "cd".repeat(32), "PASS", 0, [], "DJZS-PM-v1.0") }],
]
for (const [label, att] of attCases) {
  reset(); net.attestations.set(SAMPLE.eas_uid.toLowerCase(), att)
  const r = await recompute(SAMPLE)
  check(`X05 attestation ${label}: FAIL CONTRADICTED`, r.state === "fail" && row(r, "Attestation on Base")?.chip === "CONTRADICTED", `${r.state} ${JSON.stringify(r.rows)}`)
}
const forgedReceipt = { ...SAMPLE, intent: MADE_UP, intent_sha256: await sha(renderText(MADE_UP)) }
for (const [label, att] of [["revoked", { ...okAtt, revocationTime: 5n }], ["wrong attester", { ...okAtt, attester: "0x" + "11".repeat(20) }], ["wrong schema", { ...okAtt, schema: "0x" + "22".repeat(32) }]]) {
  reset(); net.attestations.set(SAMPLE.eas_uid.toLowerCase(), att)
  const r = await recompute(forgedReceipt)
  check(`X05b unhashable intent AND ${label} attestation: FAIL CONTRADICTED, not UNBOUND/WAIT`, r.state === "fail" && row(r, "Attestation on Base")?.chip === "CONTRADICTED", `${r.state} ${JSON.stringify(r.rows)}`)
}

// X06 the forged receipt's headline is honest
reset()
const x06 = await recompute(forgedReceipt)
check("X06 forged receipt headline: 'binding unprovable'; it never says the verdict is bound", /binding unprovable/.test(x06.title) && !/real and bound/.test(x06.vnote), `${x06.title} | ${x06.vnote.slice(0, 200)}`)

// X07 exact chip/state for the neighbours of the forged case
reset()
const x07a = await recompute({ ...SAMPLE, intent: { market: "KXOTHER", side: "YES", thesis: "a different claim" }, intent_sha256: undefined })
check("X07a an intent that hashes to something else: v2 MISMATCH, attestation CONTRADICTED, FAIL", x07a.state === "fail" && row(x07a, "Intent binding · v2")?.chip === "MISMATCH" && row(x07a, "Attestation on Base")?.chip === "CONTRADICTED", JSON.stringify(x07a.rows))
reset()
const x07b = await recompute({ ...SAMPLE, intent_hash: undefined })
check("X07b real intent, intent_hash removed: FAIL, attestation CONTRADICTED", x07b.state === "fail" && row(x07b, "Attestation on Base")?.chip === "CONTRADICTED", `${x07b.state} ${JSON.stringify(x07b.rows)}`)

// X08 Irys provenance on the certificate the receipt names
reset()
const x08a = await recompute({ ...SAMPLE, pol_certificate: { irys_id: "Abc123_-.~" } })
check("X08a certificate signed by the DJZS signer: PROVEN, receipt still PASS", x08a.state === "pass" && row(x08a, "Certificate provenance on Irys")?.chip === "PROVEN", `${x08a.state} ${JSON.stringify(x08a.rows)}`)
check("X08a' …and its link is the gateway URL of that exact id", hrefsOf(x08a).includes("https://gateway.irys.xyz/Abc123_-.~"), hrefsOf(x08a).join(" "))
reset(); net.irysSigner = "0x" + "99".repeat(20)
const x08b = await recompute({ ...SAMPLE, pol_certificate: { irys_id: "Abc123" } })
check("X08b certificate signed by someone else: NOT OURS and the verdict is FAIL", x08b.state === "fail" && row(x08b, "Certificate provenance on Irys")?.chip === "NOT OURS", `${x08b.state} ${JSON.stringify(x08b.rows)}`)
reset()
const x08c = await recompute({ ...SAMPLE, pol_certificate: { irys_id: "a b/c" } })
check("X08c an odd certificate id is linked percent-encoded", hrefsOf(x08c).includes("https://gateway.irys.xyz/a%20b%2Fc"), hrefsOf(x08c).join(" "))

// X09 every link on the SAMPLE page points where it should; the catch-path links too
reset()
const x09 = await recompute(SAMPLE)
const want = [`https://basescan.org/tx/${SAMPLE.payment_response.transaction}`, `https://base.easscan.org/attestation/view/${SAMPLE.eas_uid}`, "https://gateway.irys.xyz/Dr6UVXJbpyK8PVp8MU6tFjihA4goaEJ9MUVdw3q4CvFH", "https://gateway.irys.xyz/8Kqfic6PVkUUVhEEBppGTzcpr2sZCkbDjventu3W1Fvk"]
check("X09 the SAMPLE ledger links exactly: Basescan tx, EASScan uid, the correction anchor and the stray on the gateway", JSON.stringify(hrefsOf(x09).sort()) === JSON.stringify([...want].sort()), hrefsOf(x09).join(" "))
reset(); net.rpcError = "node down"
const x09b = await recompute(withLeaf(["payment_response", "transaction"], "0xabc def"))
check("X09b settlement catch path links the encoded tx", hrefsOf(x09b).includes("https://basescan.org/tx/0xabc%20def"), hrefsOf(x09b).join(" "))

// X10 safeHref against prefix / lookalike hosts
check("X10 safeHref: an embedded allow-listed URL behind another scheme or host, and lookalike hosts, are all '#'; the three real prefixes survive", ["javascript:alert(1)//https://basescan.org/tx/a", "data:text/html,x https://basescan.org/tx/a", "https://base-easscan.org/attestation/view/a", "https://basescanXorg/tx/a", "https://gatewayXirysYxyz/a", "https://evil.example/https://basescan.org/tx/a"].every((u) => page.safeHref(u) === "#") && ["https://basescan.org/tx/0xa", "https://base.easscan.org/attestation/view/0xa", "https://gateway.irys.xyz/Abc123"].every((u) => page.safeHref(u) === u))

// X11 setV: note and coda are checked separately, exact output
page.setV("pass", "PASS", "t", `A'<b>&"`, `C'<i>&"`)
check("X11 setV writes the note and the coda each escaped exactly once", el("#vnote").innerHTML === `A&#39;&#60;b&#62;&#38;&#34;<span class="coda">C&#39;&#60;i&#62;&#38;&#34;</span>`, el("#vnote").innerHTML)

// X12 the button comes back after every run, including the unreadable-JSON path
reset(); await recompute(SAMPLE)
check("X12a Recompute is re-enabled after a run", el("#run").disabled === false && el("#run").textContent === "Recompute")
const x13 = await recompute("{not json")
check("X13 unreadable JSON: FAIL 'receipt unreadable', a 'Parse receipt' row, and the button comes back", x13.state === "fail" && /receipt unreadable/.test(x13.title) && /Parse receipt/.test(x13.ledger) && el("#run").disabled === false)

// X16 the other buttons
await recompute(SAMPLE)
el("#clear").onclick()
check("X16a Clear hides the verdict and empties the ledger", el("#verdict").hidden === true && /Awaiting a receipt/.test(el("#ledger").innerHTML) && el("#rcpt").value === "")
el("#load").onclick()
check("X16b Load puts the SAMPLE receipt back in the textarea", JSON.stringify(JSON.parse(el("#rcpt").value)) === JSON.stringify(SAMPLE))

// X17 the correction register rows
reset()
const x17 = await recompute(SAMPLE)
check("X17 the register rows: anchor PROVEN, the known stray is FAIL / NOT OURS, and neither drags the SAMPLE verdict", row(x17, "Correction DJZS-CORR-001 anchor")?.chip === "PROVEN" && row(x17, "Known stray for DJZS-CORR-001")?.chip === "NOT OURS" && x17.state === "pass", JSON.stringify(x17.rows.slice(-4)))
reset(); net.irysSigner = "0x" + "99".repeat(20)
const x17b = await recompute(SAMPLE)
check("X17b a correction anchor signed by someone else reads NOT OURS", row(x17b, "Correction DJZS-CORR-001 anchor")?.chip === "NOT OURS", JSON.stringify(x17b.rows.slice(-4)))

// X18 links open safely
check("X18 every anchor the page writes carries target=_blank and rel=noopener", (x09.ledger.match(/<a /g) || []).length === 4 && (x09.ledger.match(/target="_blank" rel="noopener"/g) || []).length === 4)

// X14 the #r= fragment: a second instance of the page loaded with the hash set auto-runs the receipt in it
{
  const b64u = Buffer.from(JSON.stringify(forgedReceipt)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  reset()
  globalThis.location.hash = "#r=" + b64u
  let replaced = 0; globalThis.history.replaceState = () => { replaced++ }
  const dir2 = mkdtempSync(path.join(tmpdir(), "verify-dom-frag-"))
  writeFileSync(path.join(dir2, "page.mjs"), patched + "\nexport { render, setV, esc, safeHref };\n")
  el("#verdict").hidden = true; el("#verdict").dataset.state = ""
  await import(pathToFileURL(path.join(dir2, "page.mjs")).href + "?frag")
  rmSync(dir2, { recursive: true, force: true })
  await new Promise((r) => setTimeout(r, 400))
  check("X14a #r=<forged receipt> is loaded into the textarea and auto-runs: WAIT, not PASS", JSON.parse(el("#rcpt").value).intent_sha256 === forgedReceipt.intent_sha256 && el("#verdict").dataset.state === "wait" && replaced === 1, `${el("#verdict").dataset.state} replaced=${replaced}`)
  globalThis.location.hash = "#r=" + Buffer.from(JSON.stringify(SAMPLE)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "<script>"
  el("#rcpt").value = "untouched"
  const dir3 = mkdtempSync(path.join(tmpdir(), "verify-dom-frag-"))
  writeFileSync(path.join(dir3, "page.mjs"), patched + "\nexport { render, setV, esc, safeHref };\n")
  await import(pathToFileURL(path.join(dir3, "page.mjs")).href + "?frag2")
  rmSync(dir3, { recursive: true, force: true })
  check("X14b a malformed fragment is ignored (the textarea keeps the SAMPLE, nothing runs)", el("#rcpt").value !== "untouched" && JSON.stringify(JSON.parse(el("#rcpt").value)) === JSON.stringify(SAMPLE))
  globalThis.location.hash = "x#r=" + Buffer.from(JSON.stringify(forgedReceipt)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  el("#rcpt").value = "untouched2"
  const dir4 = mkdtempSync(path.join(tmpdir(), "verify-dom-frag-"))
  writeFileSync(path.join(dir4, "page.mjs"), patched + "\nexport { render, setV, esc, safeHref };\n")
  await import(pathToFileURL(path.join(dir4, "page.mjs")).href + "?frag3")
  rmSync(dir4, { recursive: true, force: true })
  check("X14c a hash that does not START with #r= is ignored", el("#rcpt").value !== "untouched2" && JSON.stringify(JSON.parse(el("#rcpt").value)) === JSON.stringify(SAMPLE))
}


// X19 mapping pin for a body that carries BOTH instrument and market: main dispatches on `market` being a string -> PM mapping
{
  const BOTH = { ...PERP, market: "KXBTCD-26SEP0217-T76999.99" }
  const { hashTypedData } = await import("viem")
  const TYPES_ = { DJZSIntent: [{ name: "action", type: "string" }, { name: "venue", type: "string" }, { name: "market", type: "string" }, { name: "side", type: "string" }, { name: "thesis", type: "string" }, { name: "probability_basis", type: "string" }, { name: "size_usd_cents", type: "uint256" }, { name: "max_loss_usd_cents", type: "uint256" }, { name: "exit_condition", type: "string" }, { name: "params_hash", type: "bytes32" }] }
  const pm = hashTypedData({ domain: { name: "DJZS", version: "2", chainId: 8453 }, types: TYPES_, primaryType: "DJZSIntent", message: { action: "pm_trade", venue: "Binance", market: BOTH.market, side: "LONG", thesis: BOTH.thesis, probability_basis: "", size_usd_cents: 300000n, max_loss_usd_cents: 0n, exit_condition: "", params_hash: "0x" + "00".repeat(32) } })
  const UID2 = "0x" + "78".repeat(32)
  reset(); net.attestations.set(UID2, attestation(UID2, encodeAtt(pm, "FAIL", 30, ["DJZS-S01"], "DJZS-LF-v1.2")))
  const r = await recompute({ ...SAMPLE, intent: BOTH, intent_hash: pm, intent_sha256: undefined, verdict: "FAIL", risk_score: 30, flags: ["DJZS-S01"], eas_uid: UID2 })
  check("X19 main's dispatch (shape-based; the route-by-ruleset change replaces this check): a body with BOTH instrument and a string market still maps as PM and binds", row(r, "Intent binding · v2")?.chip === "PROVEN" && r.state === "pass", `${r.state} ${JSON.stringify(r.rows)}`)
}

// X20 the node must echo the UID asked for
reset(); net.attestations.set(SAMPLE.eas_uid.toLowerCase(), attestation("0x" + "12".repeat(32), SAMPLE_ATTESTED))
const x20 = await recompute(SAMPLE)
check("X20 an attestation whose uid is not the one asked for: FAIL NOT FOUND", x20.state === "fail" && row(x20, "Attestation on Base")?.chip === "NOT FOUND", `${x20.state} ${JSON.stringify(x20.rows)}`)

// X21 an unreachable Irys index is UNREACHABLE (WAIT), not NOT OURS
reset(); net.irysError = "index down"
const x21 = await recompute({ ...SAMPLE, pol_certificate: { irys_id: "Abc123" } })
check("X21 Irys index unreachable: the certificate row is UNREACHABLE (WAIT), not NOT OURS", row(x21, "Certificate provenance on Irys")?.chip === "UNREACHABLE" && row(x21, "Certificate provenance on Irys")?.r === "wait", `${x21.state} ${JSON.stringify(x21.rows)}`)

globalThis.location.hash = ""

// X15 no innerHTML is written anywhere but #ledger and #vnote, and only through the two sinks
const writers = new Set(innerHTMLWrites.map(([sel]) => sel))
check("X15 across every run above, innerHTML was written only on #ledger and #vnote", [...writers].every((s) => s === "#ledger" || s === "#vnote"), [...writers].join(", "))


// the only markup sinks in the page's script are the three it declares (empty, render, setV); nothing else can write HTML
const sinkWrites = [...script.matchAll(/\.innerHTML\s*\+?=/g)].length
check("the page script assigns innerHTML in exactly three places (empty, render, setV) and uses no other HTML sink", sinkWrites === 3 && !/insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function|srcdoc|\.innerText\s*=/.test(script), String(sinkWrites))

check("no run reached a host the stubs do not know", net.unexpected.length === unexpectedBefore, net.unexpected.join(", "))

await mf.dispose()
if (failures.length) {
  console.error(`\nVERIFY-DOM: FAIL (${failures.length} of ${n} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nVERIFY-DOM: PASS (${n} checks)`)
