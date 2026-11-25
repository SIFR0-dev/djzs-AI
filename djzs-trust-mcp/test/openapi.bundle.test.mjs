/**
 * /openapi.json, checked against the BUILT Worker bundle in Miniflare and against the routes it describes.
 * Holds the contract fix of 2026-11-23:
 *   - /x402/verify_pm_trade documents `intent` as an OBJECT with required market/side/thesis. It used to inherit
 *     the legacy alias's free-text string schema, so a spec-driven client built a request the route refuses
 *     (400 missing_intent / intent_unbindable). The required set must equal the route's own 402 discovery schema,
 *     and the documented example must be the one the 402 challenge publishes.
 *   - /x402/verify (legacy alias) keeps its free-text contract.
 *   - /x402/verify_perp_trade documents data_sources (bound into intent_hash) and answers with the same bodies as
 *     the PM door (one handler); its example is the one its 402 challenge publishes.
 *   - POST /try/verdict, GET /try/quota and GET /try/example are documented. The example's `anon` is a placeholder,
 *     never a valid id: sent as is it is the documented 400 and takes no slot; with a fresh id it is the documented
 *     200. A valid id in the example would be one quota bucket shared by every reader of the docs.
 *   - the document is served with an open CORS header, so a docs site can load it by URL; it carries no em dash
 *     (rendered on docs.djzs.ai) and x-service-info.docs.apiReference points at docs.djzs.ai.
 *   - the docs order of 2026-11-25. GitBook builds one reference page per tag, in `tags` order, titled by
 *     x-page-title. Tags lead free, audit, health; the free check is the first operation; the legacy alias comes
 *     after both paid doors, deprecated, with its Test it panel hidden. Every operation the docs leave runnable
 *     answers a cross-origin browser: a POST through its preflight, a GET directly.
 *   - the MPP door on the paid preflight: a browser on another origin may send Authorization and read
 *     WWW-Authenticate and Payment-Receipt. The 402 schema names DJZS-M03 for an unsourced probability_basis.
 *
 * ZERO keys, ZERO egress: the extraction call is stubbed, every other outbound host is refused.
 * Run from djzs-trust-mcp/:   npx tsx test/openapi.bundle.test.mjs
 *   DJZS_BUNDLE=<path/to/index.js> to test an already-built bundle; otherwise it builds one with
 *   `wrangler deploy --dry-run` (no login, no secrets, no deploy).
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Miniflare } from "miniflare"
import Ajv2020 from "ajv/dist/2020.js"
import { PM_RESOURCE, PERP_RESOURCE } from "../src/http-x402-bazaar.v2.ts"
import { TRY_ANON_ID_RE } from "../src/try-route.ts"

setTimeout(() => { console.error("OPENAPI: TIMEOUT after 180s"); process.exit(1) }, 180_000).unref()

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 400)}` : ""}`) }
}

let bundle = process.env.DJZS_BUNDLE
if (!bundle) {
  const out = mkdtempSync(path.join(tmpdir(), "djzs-openapi-"))
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: "ignore", cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
  bundle = path.join(out, "index.js")
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)

const F = (state, value) => (state === "present" ? { state, value } : { state })
// A stubbed extraction for a prediction-market thesis. Only its shape matters here: the test checks the contract, not the verdict.
const PM_X = { agent_type: "trader", intended_action: "buy YES", audit_context: "prediction_market", leverage: F("absent"), position_size: F("unknown"), stop_loss: F("unknown"), take_profit: F("unknown"), invalidation_condition: F("unknown"), resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("unknown"), oracle_source: F("unknown"), confidence: F("unknown") }
const TOML = readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8")
const jres = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } })

const mf = new Miniflare({
  modules: true,
  modulesRoot: path.dirname(path.resolve(bundle)),
  scriptPath: path.resolve(bundle),
  compatibilityDate: TOML.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1],
  compatibilityFlags: JSON.parse((TOML.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])/m)?.[1] ?? "[]")),
  bindings: { ENVIRONMENT: "production", ANTHROPIC_API_KEY: "stub-not-a-key" },
  d1Databases: { TELEMETRY: "local-telemetry" },
  outboundService: async (req) => {
    const u = new URL(req.url)
    await req.arrayBuffer().catch(() => {})
    if (u.host === "api.anthropic.com") return jres({ content: [{ type: "text", text: JSON.stringify(PM_X) }] })
    return new Response("blocked", { status: 599 })
  },
})

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
const validate = (schema, value) => {
  const v = ajv.compile(schema)
  return v(value) ? null : ajv.errorsText(v.errors)
}

try {
  // ── the document itself ─────────────────────────────────────────────────────
  const res = await mf.dispatchFetch("https://mcp.djzs.ai/openapi.json")
  const doc = await res.json()
  check("GET /openapi.json is 200", res.status === 200, res.status)
  check("GET /openapi.json has CORS open", res.headers.get("access-control-allow-origin") === "*", res.headers.get("access-control-allow-origin"))
  check("document is OpenAPI 3.1", doc.openapi === "3.1.0", doc.openapi)
  const opIds = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId))
  check("operationIds are unique", new Set(opIds).size === opIds.length, opIds.join(","))
  const tagNames = new Set((doc.tags ?? []).map((t) => t.name))
  const usedTags = Object.values(doc.paths).flatMap((p) => Object.values(p).flatMap((o) => o.tags ?? []))
  check("every tag an operation uses is declared", usedTags.every((t) => tagNames.has(t)), usedTags.filter((t) => !tagNames.has(t)).join(","))
  const raw = JSON.stringify(doc)
  check("no em dash in the served document", !raw.includes("\u2014"), raw.slice(Math.max(0, raw.indexOf("\u2014") - 60), raw.indexOf("\u2014") + 20))
  check("x-service-info.docs.apiReference is docs.djzs.ai", doc["x-service-info"]?.docs?.apiReference === "https://docs.djzs.ai", doc["x-service-info"]?.docs?.apiReference)

  // ── the canonical paid prediction-market door ───────────────────────────────
  const canon = doc.paths["/x402/verify_pm_trade"]?.post
  const canonMedia = canon?.requestBody?.content?.["application/json"]
  const canonIntent = canonMedia?.schema?.properties?.intent
  const discovery = PM_RESOURCE.extensions.bazaar.schema.properties.input.properties.body.properties.intent
  check("canonical PM intent is an object", canonIntent?.type === "object", canonIntent?.type)
  check(
    "canonical PM required set equals the 402 discovery schema's",
    isDeepStrictEqual([...(canonIntent?.required ?? [])].sort(), [...discovery.required].sort()),
    `${canonIntent?.required} vs ${discovery.required}`,
  )
  const missing = Object.keys(discovery.properties).filter((k) => !(k in (canonIntent?.properties ?? {})))
  check("every discovery intent field is documented", missing.length === 0, missing.join(","))
  check("canonical PM does not forbid extra keys (the route reads them)", canonIntent?.additionalProperties !== false)
  check(
    "canonical PM example is the 402 challenge's example",
    isDeepStrictEqual(canonMedia?.example, PM_RESOURCE.extensions.bazaar.info.input.body),
    JSON.stringify(canonMedia?.example),
  )
  check("canonical PM example validates against its schema", validate(canonMedia.schema, canonMedia.example) === null, validate(canonMedia.schema, canonMedia.example))
  check("a free-text intent fails the canonical schema", validate(canonMedia.schema, { intent: "BTC above 70k because ETFs" }) !== null)
  check("an object missing market fails the canonical schema", validate(canonMedia.schema, { intent: { side: "YES", thesis: "x" } }) !== null)
  check("canonical PM keeps the MPP and x402 payment info", JSON.stringify(canon?.["x-payment-info"]?.protocols ?? []).includes("mpp"))
  const canon200 = canon?.responses?.["200"]?.content?.["application/json"]?.schema
  check(
    "canonical 200 documents the verdict and the scope refusal",
    Array.isArray(canon200?.oneOf) && canon200.oneOf.some((s) => s.properties?.intent_hash) && canon200.oneOf.some((s) => s.properties?.verdict?.const === "REFUSED_SCOPE"),
  )
  check("canonical 200 no longer claims the legacy pol_certificate body", !JSON.stringify(canon200 ?? {}).includes("pol_certificate"))
  for (const code of ["400", "402", "405", "500", "502", "503"]) check(`canonical documents ${code}`, Boolean(canon?.responses?.[code]))

  // ── the perp door: discovery fields documented, same bodies as the PM door ───
  const perp = doc.paths["/x402/verify_perp_trade"]?.post
  const perpMedia = perp?.requestBody?.content?.["application/json"]
  const perpIntent = perpMedia?.schema?.properties?.intent
  const perpDiscovery = PERP_RESOURCE.extensions.bazaar.schema.properties.input.properties.body.properties.intent
  check(
    "perp required set equals the 402 discovery schema's",
    isDeepStrictEqual([...(perpIntent?.required ?? [])].sort(), [...perpDiscovery.required].sort()),
    `${perpIntent?.required} vs ${perpDiscovery.required}`,
  )
  const perpMissing = Object.keys(perpDiscovery.properties).filter((k) => !(k in (perpIntent?.properties ?? {})))
  check("every perp discovery intent field is documented (data_sources included)", perpMissing.length === 0, perpMissing.join(","))
  check("perp example is the 402 challenge's example", isDeepStrictEqual(perpMedia?.example, PERP_RESOURCE.extensions.bazaar.info.input.body), JSON.stringify(perpMedia?.example))
  check("perp example validates against its schema", validate(perpMedia.schema, perpMedia.example) === null, validate(perpMedia.schema, perpMedia.example))
  check("perp 200 is the paid-route schema the PM door uses", isDeepStrictEqual(perp?.responses?.["200"], canon?.responses?.["200"]))
  check("perp 200 no longer claims action/unknown_fields/receipt", !/unknown_fields|receipt"/.test(JSON.stringify(perp?.responses?.["200"] ?? {})))
  for (const code of ["400", "402", "405", "500", "502", "503"]) check(`perp documents ${code}`, Boolean(perp?.responses?.[code]))

  // ── the legacy alias keeps its free-text contract ───────────────────────────
  const legacyIntent = doc.paths["/x402/verify"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.intent
  check("legacy /x402/verify intent stays free text", legacyIntent?.type === "string", legacyIntent?.type)
  check("x-guidance names the object-shaped door", /verify_pm_trade with an OBJECT intent/.test(doc.info?.["x-guidance"] ?? ""))

  // ── the free routes: documented, and the documented example works against the real route ───────────
  const tv = doc.paths["/try/verdict"]?.post
  const tq = doc.paths["/try/quota"]?.get
  const te = doc.paths["/try/example"]?.get
  check("POST /try/verdict is documented", Boolean(tv))
  check("GET /try/quota is documented", Boolean(tq))
  check("GET /try/example is documented", Boolean(te))
  check("free routes are tagged free", [tv, tq, te].every((o) => o?.tags?.includes("free")))
  check("free routes carry no payment info", [tv, tq, te].every((o) => o && !("x-payment-info" in o)))

  const tvMedia = tv.requestBody.content["application/json"]
  const post = (body) => mf.dispatchFetch("https://mcp.djzs.ai/try/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const globalLeft = async () => (await (await mf.dispatchFetch("https://mcp.djzs.ai/try/quota")).json()).global_remaining

  // The example's anon must never be a working id: one valid id in the docs is one bucket every reader shares.
  check("the example's anon is a placeholder, not a valid id", typeof tvMedia.example.anon === "string" && !TRY_ANON_ID_RE.test(tvMedia.example.anon), tvMedia.example.anon)
  check("the anon pattern is the route's own", tv.requestBody.content["application/json"].schema.properties.anon.pattern === TRY_ANON_ID_RE.source)
  const before = await globalLeft()
  const asIs = await post(tvMedia.example)
  const asIsBody = await asIs.json()
  const a400 = validate(tv.responses["400"].content["application/json"].schema, asIsBody)
  check("the example sent as is is the documented 400 bad_anon_id", asIs.status === 400 && asIsBody.error === "bad_anon_id" && a400 === null, `${asIs.status} ${JSON.stringify(asIsBody)} ${a400}`)
  check("the 400 tells the reader what an id is", /32 lowercase hex/.test(asIsBody.detail ?? ""), asIsBody.detail)
  const after = await globalLeft()
  check("the example sent as is takes no slot", typeof before === "number" && after === before, `${before} -> ${after}`)

  const anon = randomBytes(16).toString("hex")
  const mine = { ...tvMedia.example, anon }
  check("the example with a fresh id validates against its schema", validate(tvMedia.schema, mine) === null, validate(tvMedia.schema, mine))
  const vr = await post(mine)
  const vbody = await vr.json()
  check("the example with a fresh id is accepted (200)", vr.status === 200, `${vr.status} ${JSON.stringify(vbody).slice(0, 200)}`)
  check("/try/verdict answers with CORS open", vr.headers.get("access-control-allow-origin") === "*")
  const v200 = validate(tv.responses["200"].content["application/json"].schema, vbody)
  check("/try/verdict response matches the documented 200 schema", v200 === null, v200)

  const qr = await mf.dispatchFetch(`https://mcp.djzs.ai/try/quota?anon=${anon}`)
  const qbody = await qr.json()
  const q200 = validate(tq.responses["200"].content["application/json"].schema, qbody)
  check("/try/quota response matches the documented 200 schema", qr.status === 200 && q200 === null, `${qr.status} ${q200}`)
  check("/try/quota counts the fresh id's one check", qbody.used === 1, qbody.used)
  check("the global allowance moved by exactly that one check", (await globalLeft()) === before - 1, `${before} -> ${await globalLeft()}`)

  const er = await mf.dispatchFetch("https://mcp.djzs.ai/try/example")
  const ebody = await er.json()
  const e200 = validate(te.responses["200"].content["application/json"].schema, ebody)
  check("/try/example response matches the documented 200 schema", er.status === 200 && e200 === null, `${er.status} ${e200}`)
  const unknown = await mf.dispatchFetch("https://mcp.djzs.ai/try/example?id=no-such-example")
  const ubody = await unknown.json()
  const u404 = validate(te.responses["404"].content["application/json"].schema, ubody)
  check("an unknown example id is the documented 404", unknown.status === 404 && u404 === null, `${unknown.status} ${u404}`)

  // ── the docs build from this document: order, titles, and a Test it that offers only what answers ────────
  const tagOrder = (doc.tags ?? []).map((t) => t.name)
  check("tags lead free, audit, health", isDeepStrictEqual(tagOrder, ["free", "audit", "health"]), tagOrder.join(","))
  check("every tag carries an x-page-title", (doc.tags ?? []).every((t) => typeof t["x-page-title"] === "string" && t["x-page-title"].length > 0))
  const pathOrder = Object.keys(doc.paths)
  check("the free check is the first operation", pathOrder[0] === "/try/verdict", pathOrder.join(","))
  check(
    "the legacy alias comes after both paid doors",
    pathOrder.indexOf("/x402/verify") > pathOrder.indexOf("/x402/verify_pm_trade") && pathOrder.indexOf("/x402/verify") > pathOrder.indexOf("/x402/verify_perp_trade"),
    pathOrder.join(","),
  )
  const legacyOp = doc.paths["/x402/verify"]?.post
  check("the legacy alias is deprecated in the docs", legacyOp?.deprecated === true)
  check("the legacy alias hides its Test it panel (it serves no preflight)", legacyOp?.["x-hideTryItPanel"] === true)
  const DOCS_ORIGIN = "https://docs.djzs.ai"
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op?.["x-hideTryItPanel"] === true) continue
      const r = method === "post"
        ? await mf.dispatchFetch(`https://mcp.djzs.ai${p}`, { method: "OPTIONS", headers: { origin: DOCS_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } })
        : await mf.dispatchFetch(`https://mcp.djzs.ai${p}`, { headers: { origin: DOCS_ORIGIN } })
      await r.arrayBuffer()
      const acao = r.headers.get("access-control-allow-origin")
      const acam = r.headers.get("access-control-allow-methods") ?? ""
      const acah = r.headers.get("access-control-allow-headers") ?? ""
      const ok = method === "post" ? r.status < 300 && acao === "*" && /POST/.test(acam) && /content-type/i.test(acah) : acao === "*"
      check(`Test it reaches ${method.toUpperCase()} ${p} from another origin`, ok, `${r.status} acao=${acao} methods=${acam} headers=${acah}`)
    }
  }
  const pre = await mf.dispatchFetch("https://mcp.djzs.ai/x402/verify_pm_trade", { method: "OPTIONS" })
  await pre.arrayBuffer()
  const preAllow = pre.headers.get("access-control-allow-headers") ?? ""
  const preExpose = pre.headers.get("access-control-expose-headers") ?? ""
  check("paid preflight lets a browser send the MPP credential (Authorization)", /(^|,)\s*Authorization\s*(,|$)/i.test(preAllow), preAllow)
  check("paid answers expose the MPP challenge and receipt", /WWW-Authenticate/i.test(preExpose) && /Payment-Receipt/i.test(preExpose), preExpose)
  const basisDesc = discovery.properties?.probability_basis?.description ?? ""
  check("the 402 schema names DJZS-M03 for an unsourced probability_basis", /DJZS-M03/.test(basisDesc) && !/M02/.test(basisDesc), basisDesc)
} finally {
  await mf.dispose()
}

console.log(`\nOPENAPI: ${checks - failures.length}/${checks} checks passed`)
if (failures.length) {
  console.error(`OPENAPI: FAILED: ${failures.join(" | ")}`)
  process.exit(1)
}
