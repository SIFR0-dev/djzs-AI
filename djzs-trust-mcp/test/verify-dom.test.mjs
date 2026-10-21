/**
 * site/verify.html, hardened (marker djzs-verify-hardening-1): DOM tests that EXECUTE the page's run().
 * Offline, no key, no network, no browser.
 *
 * What runs: the page's real module script, unmodified except for two test-only edits: the one viem import is
 * pointed at the local node_modules copy of the same package, and an `export { render, setV, esc, safeHref }`
 * line is appended so the sinks can also be driven directly with hostile values for every parameter. It runs under a minimal DOM shim (querySelector, value,
 * textContent, innerHTML, dataset, onclick), with fetch stubbed to chain-shaped JSON-RPC answers: the
 * SAMPLE settlement, and the attestation 0xc5995989... as read from Base on 2026-10-21. Clicking Recompute
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
 *     literal text; every href is an allow-listed https URL or "#".
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
const el = (sel) => { if (!els.has(sel)) els.set(sel, { sel, value: "", textContent: "", innerHTML: "", hidden: true, dataset: {}, disabled: false, onclick: null }); return els.get(sel) }
globalThis.document = { querySelector: el, title: "" }
globalThis.location = { hash: "", pathname: "/verify" }
globalThis.history = { replaceState() {} }

const EAS_ABI = parseAbi(["function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))"])
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const RPC_HOSTS = ["base.llamarpc.com", "base-rpc.publicnode.com", "mainnet.base.org", "1rpc.io"]
const net = { attestations: new Map(), txReceipts: new Map(), rpcError: null, irysError: null, unexpected: [] }
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } })
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase()
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url))
  if (RPC_HOSTS.includes(u.host)) {
    const body = JSON.parse(init?.body ?? "{}")
    if (net.rpcError) return json({ jsonrpc: "2.0", id: body.id, error: { message: net.rpcError } })
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
    return json({ data: { transactions: { edges: [{ node: { id: "x", address: DJZS_IRYS_SIGNER } }] } } })
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
// Attested payload of 0xc5995989... as read from the EAS contract on Base, 2026-10-21 (PASS, 0, [], DJZS-PM-v1.0).
const SAMPLE_ATTESTED = "0x34c493a055e5b6b3683fb5bac14654190de392557aad09f8a48a74c6992cb20600000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000450415353000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c444a5a532d504d2d76312e300000000000000000000000000000000000000000"
const ATTESTER = "0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824"
const attestation = (uid, data) => ({ uid, schema: DJZS_SCHEMA, time: 1788294891n, expirationTime: 0n, revocationTime: 0n, refUID: "0x" + "00".repeat(32), recipient: "0x46448Ea69912Aa8E2191dde67839A4987D269d17", attester: ATTESTER, revocable: false, data })
const encodeAtt = (ih, verdict, risk, flags, ruleset) => encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "string[]" }, { type: "string" }], [ih, verdict, risk, flags, ruleset])
const settlementReceipt = (payer, payTo, micro) => ({ status: "0x1", blockNumber: "0x2faf080", logs: [{ address: USDC, topics: [XFER, pad(payer), pad(payTo)], data: "0x" + micro.toString(16).padStart(64, "0") }] })
function reset() {
  net.attestations.clear(); net.txReceipts.clear(); net.rpcError = null; net.irysError = null
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
async function recompute(receipt) {
  el("#rcpt").value = typeof receipt === "string" ? receipt : JSON.stringify(receipt)
  el("#verdict").hidden = true
  await el("#run").onclick()
  const ledger = el("#ledger").innerHTML
  const rows = [...ledger.matchAll(/<div class="claim" data-r="(\w+)"><span class="tok">([^<]*)<\/span><p class="claim-name">([^<]*)<span class="chip">([^<]*)<\/span>/g)].map((m) => ({ r: m[1], name: decode(m[3]), chip: decode(m[4]) }))
  return { state: el("#verdict").dataset.state, stamp: el("#vstamp").textContent, title: el("#vtitle").textContent, ledger, vnote: el("#vnote").innerHTML, rows }
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
check("safeHref(): only the three allow-listed https prefixes with an encoded tail survive", page.safeHref("https://basescan.org/tx/0xabc") === "https://basescan.org/tx/0xabc" && ["javascript:alert(1)", "https://evil.example/", "https://basescan.org/tx/a b", 'https://basescan.org/tx/a"b', "https://basescan.org/tx/a/../b", "//basescan.org/tx/a", "http://basescan.org/tx/a", "https://basescan.org.evil.example/tx/a", "https://basescan.org/tx/a?x=1", "https://basescan.org/tx/a#y", ""].every((u) => page.safeHref(u) === "#"))

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

check("no run reached a host the stubs do not know", net.unexpected.length === unexpectedBefore, net.unexpected.join(", "))

await mf.dispose()
if (failures.length) {
  console.error(`\nVERIFY-DOM: FAIL (${failures.length} of ${n} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nVERIFY-DOM: PASS (${n} checks)`)
