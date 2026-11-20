#!/usr/bin/env node
/**
 * register.mjs - register the two gate tools with Tavus, attach them to a PAL, and report what
 * else that PAL can call.
 *
 * OPERATOR'S SHELL ONLY. It needs the Tavus API key and the tool secret, and those live in the
 * operator's shell. It reads them from the environment and never prints them.
 *
 * DRY RUN BY DEFAULT. Without --send it prints what it would send (secret masked) and stops.
 *
 *   PAL_GATE_URL       https origin of the deployed Worker, no path     https://<name>.workers.dev
 *   TAVUS_TOOL_SECRET  the shared secret: the SAME value as the Worker secret of that name
 *   TAVUS_API_KEY      the Tavus API key                                 (read only with --send)
 *   TAVUS_PAL_ID       optional: attach the tools to this PAL and run the rule 4 report
 *
 * WHY A SCRIPT AND NOT TWO curl LINES. The tool definitions beside this file are tracked in a
 * public repository. The endpoint and the secret are not in them and must never be typed into
 * them. This script adds both at send time, from the environment.
 *
 * WHAT --send DOES, in order, stopping at the first thing that is wrong:
 *   1. PREFLIGHT THE GATE. GET /health, then one signed probe the Worker must answer 400
 *      wrong_tool. A 401 there means the secret in this shell is not the Worker's secret, which is
 *      the mistake that would otherwise show up as a PAL that fails every call. The probe names a
 *      tool that does not exist, so the Worker refuses it before it touches any record.
 *   2. Create the two tools            POST /v2/tools
 *   3. Attach them to the PAL          POST /v2/pals/{pal_id}/tools
 *   4. RULE 4 REPORT. The gate only gates what goes through it. This lists everything else the
 *      PAL can call: other attached tools, legacy inline tools, MCP connectors and skills. If it
 *      cannot read an answer it says so and exits non-zero; it never reports "nothing else" on a
 *      response it did not understand.
 *
 * NOT VERIFIED AGAINST A LIVE TAVUS ACCOUNT. The requests follow the Tavus API reference as read
 * on 2026-11-17 (Create Tool, Attach Tools To PAL, List PAL Tools). test/pal-register.test.mjs
 * checks them against that contract with a stubbed network; no request has been sent to Tavus.
 *
 * Usage, from djzs-pal-gate/:
 *   node pal/register.mjs
 *   node pal/register.mjs --send
 */
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const TAVUS_API = "https://tavusapi.com"
/** Tool name -> the Worker route that receives it. The names are pinned in src/index.ts. */
export const ROUTES = { request_transfer: "/tavus/tool/request_transfer", settle_after_call: "/tavus/post-call/settle" }
export const TOOL_FILES = ["tool.request_transfer.json", "tool.settle_after_call.json"]
/** Built into every Tavus conversation; never attached, never listed. */
const SYSTEM_TOOLS = ["end_call"]

export function loadDefinitions() {
  return TOOL_FILES.map((f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8")))
}

/** An https origin with nothing after it. Returns the origin, or throws with the reason. */
export function gateOrigin(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("PAL_GATE_URL is not set")
  let u
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error("PAL_GATE_URL is not a URL")
  }
  if (u.protocol !== "https:") throw new Error("PAL_GATE_URL must be https (Tavus refuses anything else)")
  if (u.username || u.password) throw new Error("PAL_GATE_URL must not carry credentials")
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("PAL_GATE_URL must be an origin only: no path, no query")
  return u.origin
}

export function checkSecret(secret) {
  if (typeof secret !== "string" || secret === "") throw new Error("TAVUS_TOOL_SECRET is not set")
  if (/\s/.test(secret)) throw new Error("TAVUS_TOOL_SECRET contains whitespace (a stray newline from a paste?)")
  if (secret.length < 32) throw new Error("TAVUS_TOOL_SECRET is shorter than 32 characters")
  return secret
}

/** The two Create Tool request bodies: the tracked definitions plus the endpoint and the secret. */
export function buildBodies({ gateUrl, secret }) {
  const origin = gateOrigin(gateUrl)
  checkSecret(secret)
  return loadDefinitions().map((def) => {
    const route = ROUTES[def.name]
    if (!route) throw new Error(`no Worker route is known for a tool named ${def.name}`)
    const body = structuredClone(def)
    body.delivery.api.url = origin + route
    body.delivery.api.auth = { type: "hmac", secret }
    return body
  })
}

/** The same body, safe to print. */
export function masked(body) {
  const copy = structuredClone(body)
  if (copy.delivery?.api?.auth?.secret !== undefined) copy.delivery.api.auth.secret = "********"
  return copy
}

/**
 * The documented Create Tool constraints this script can check before sending. Returns the list
 * of problems; empty means none found.
 */
export function problems(body) {
  const out = []
  if (typeof body.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(body.name)) out.push("name must be letters, digits and underscores, not start with a digit, 64 characters at most")
  if (typeof body.description !== "string" || body.description.trim() === "") out.push("description is required")
  const params = body.parameters ?? {}
  if ((body.description ?? "").length + JSON.stringify(params).length > 10000) out.push("description plus serialized parameters must be 10000 characters at most")
  if (params.type !== "object" || !params.properties || typeof params.properties !== "object") out.push("parameters must be a JSON Schema object with properties")
  for (const key of Object.keys(params.properties ?? {})) if (key.startsWith("tavus_")) out.push(`parameter ${key}: the tavus_ prefix is reserved`)
  const api = body.delivery?.api
  if (!api || body.delivery.app_message) out.push("delivery must be api only")
  else {
    if (typeof api.url !== "string" || !api.url.startsWith("https://")) out.push("delivery.api.url must be https")
    if (!(typeof api.timeout === "number" && api.timeout > 0 && api.timeout <= 60)) out.push("delivery.api.timeout must be above 0 and at most 60 seconds")
    if (api.auth?.type !== "hmac" || typeof api.auth.secret !== "string" || api.auth.secret === "") out.push("delivery.api.auth must be hmac with a secret")
    if (api.body_template !== undefined || api.query_params !== undefined) out.push("body_template and query_params are ignored in hmac mode; remove them")
  }
  if (body.trigger_type === "post_call") {
    if (body.origin !== undefined && body.origin !== null) out.push("a post_call tool must not set origin")
    for (const [key, schema] of Object.entries(params.properties ?? {})) if (schema.const === undefined) out.push(`post_call parameter ${key} is not fixed (no const): Tavus would write it from the transcript`)
  } else {
    if (body.on_resolve !== "response_in_result") out.push("the in-call tool must use on_resolve response_in_result, so the gate's sentence is spoken word for word")
    if (body.on_call !== "static_filler" || typeof body.static_filler !== "string" || body.static_filler.trim() === "") out.push("the in-call tool must use on_call static_filler with a fixed line (generate_filler lets the model speak first)")
  }
  return out
}

/**
 * A signed envelope naming a tool that does not exist. The Worker verifies the signature, reads
 * the name, and refuses with 400 wrong_tool before it touches any record. So:
 *   400 wrong_tool        this secret is the Worker's secret
 *   401 bad_signature     it is not
 *   503 gate_not_configured  the Worker has no secret at all
 */
export function probe({ gateUrl, secret }) {
  const body = JSON.stringify({ conversation_id: "register-probe", name: "register_probe" })
  return {
    method: "POST",
    url: gateOrigin(gateUrl) + ROUTES.settle_after_call,
    headers: { "content-type": "application/json", "x-tavus-signature": createHmac("sha256", checkSecret(secret)).update(body).digest("hex") },
    body,
  }
}

async function call(fetchImpl, method, url, { headers = {}, body } = {}) {
  const res = await fetchImpl(url, { method, headers, body })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text }
}

/** Names out of a list response whose exact shape is not pinned by the docs. null = not understood. */
function namesFrom(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.tools) ? json.tools : null
  if (!list) return null
  const names = list.map((t) => (t && typeof t === "object" ? (t.name ?? t.tool_name) : null))
  return names.every((n) => typeof n === "string") ? names : null
}

/**
 * Everything the PAL can call besides the two gate tools.
 *   extra    other things it can call
 *   missing  gate tools that are not attached to it
 *   unread   answers this could not interpret; if any, the report is incomplete and must not be
 *            read as clean
 */
export async function ruleFourReport(fetchImpl, apiKey, palId, api = TAVUS_API) {
  const headers = { "x-api-key": apiKey }
  const extra = []
  const unread = []
  const missing = []

  const attached = await call(fetchImpl, "GET", `${api}/v2/pals/${encodeURIComponent(palId)}/tools`, { headers })
  const names = attached.status === 200 ? namesFrom(attached.json) : null
  if (!names) unread.push(`attached tools (HTTP ${attached.status})`)
  else {
    for (const n of names) if (!(n in ROUTES)) extra.push(`attached tool: ${n}`)
    for (const need of Object.keys(ROUTES)) if (!names.includes(need)) missing.push(need)
  }

  const pal = await call(fetchImpl, "GET", `${api}/v2/pals/${encodeURIComponent(palId)}`, { headers })
  if (pal.status !== 200 || !pal.json || typeof pal.json !== "object") unread.push(`the PAL itself (HTTP ${pal.status})`)
  else {
    const layers = pal.json.layers ?? {}
    const inline = layers.llm?.tools
    if (Array.isArray(inline)) for (const t of inline) extra.push(`inline tool (layers.llm.tools): ${t?.function?.name ?? t?.name ?? "unnamed"}`)
    else if (inline !== undefined && inline !== null) unread.push("layers.llm.tools")
    const mcp = layers.mcp
    if (mcp !== undefined && mcp !== null && !(typeof mcp === "object" && Object.keys(mcp).length === 0)) extra.push(`MCP connectors are configured (layers.mcp): read layers.mcp.connector_tools and confirm none of them moves value`)
  }

  const skills = await call(fetchImpl, "GET", `${api}/v2/pals/${encodeURIComponent(palId)}/skills`, { headers })
  if (skills.status !== 200 || !skills.json || typeof skills.json !== "object" || Array.isArray(skills.json)) unread.push(`skills (HTTP ${skills.status})`)
  else for (const id of Object.keys(skills.json)) extra.push(`skill: ${id}`)

  return { extra, unread, missing, system: SYSTEM_TOOLS }
}

/** Exit codes: 0 done, 1 refused before or during sending, 2 sent but the rule 4 report needs reading. */
export async function run({ argv = [], env = {}, fetchImpl = fetch, out = console.log } = {}) {
  const send = argv.includes("--send")
  let bodies
  try {
    bodies = buildBodies({ gateUrl: env.PAL_GATE_URL, secret: env.TAVUS_TOOL_SECRET })
  } catch (e) {
    out(`REFUSED: ${e.message}`)
    return 1
  }
  for (const b of bodies) {
    const found = problems(b)
    if (found.length) {
      out(`REFUSED: ${b.name}: ${found.join("; ")}`)
      return 1
    }
  }

  if (!send) {
    out("DRY RUN. Nothing was sent. Re-run with --send to do this:")
    out(`  1. preflight ${gateOrigin(env.PAL_GATE_URL)}: GET /health, then a signed probe that must answer 400 wrong_tool`)
    for (const b of bodies) out(`  2. POST ${TAVUS_API}/v2/tools\n${JSON.stringify(masked(b), null, 2)}`)
    out(env.TAVUS_PAL_ID ? `  3. POST ${TAVUS_API}/v2/pals/${env.TAVUS_PAL_ID}/tools  {"tool_ids": [the two ids]}\n  4. rule 4 report for that PAL` : "  3. (TAVUS_PAL_ID is not set: the tools would be created and not attached)")
    return 0
  }

  const apiKey = env.TAVUS_API_KEY
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    out("REFUSED: TAVUS_API_KEY is not set")
    return 1
  }

  // 1. preflight the gate
  const origin = gateOrigin(env.PAL_GATE_URL)
  const health = await call(fetchImpl, "GET", `${origin}/health`)
  if (health.status !== 200 || health.json?.service !== "djzs-pal-gate") {
    out(`REFUSED: ${origin}/health did not answer as djzs-pal-gate (HTTP ${health.status}). Is PAL_GATE_URL the deployed Worker?`)
    return 1
  }
  const p = probe({ gateUrl: env.PAL_GATE_URL, secret: env.TAVUS_TOOL_SECRET })
  const probed = await call(fetchImpl, p.method, p.url, { headers: p.headers, body: p.body })
  if (!(probed.status === 400 && probed.json?.error === "wrong_tool")) {
    const why = probed.status === 401 ? "the secret in this shell is NOT the Worker's TAVUS_TOOL_SECRET" : probed.status === 503 ? "the Worker has no TAVUS_TOOL_SECRET set" : `unexpected answer (HTTP ${probed.status} ${probed.json?.error ?? ""})`
    out(`REFUSED: signed probe failed: ${why}. Nothing was sent to Tavus.`)
    return 1
  }
  out(`gate ok: ${origin} (gate_mode ${health.json.gate_mode}, executor ${health.json.executor}, store_bound ${health.json.store_bound}); the secret matches`)

  // 2. create
  const ids = []
  for (const b of bodies) {
    const made = await call(fetchImpl, "POST", `${TAVUS_API}/v2/tools`, { headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify(b) })
    const id = made.json?.tool_id
    if (made.status !== 200 || typeof id !== "string") {
      const hint = made.status === 409 ? " A tool with this name already exists in the account: delete it in Tavus, then run this again." : ""
      out(`REFUSED by Tavus: create ${b.name}: HTTP ${made.status} ${JSON.stringify(made.json?.error ?? made.json?.message ?? "")}.${hint}`)
      if (ids.length) out(`NOTE: already created in this run and left in place: ${ids.join(", ")}`)
      return 1
    }
    ids.push(id)
    out(`created ${b.name}: ${id}`)
  }

  // 3. attach
  const palId = env.TAVUS_PAL_ID
  if (typeof palId !== "string" || palId.trim() === "") {
    out("TAVUS_PAL_ID is not set: the tools exist and are attached to nothing. Attach them, then check rule 4 by hand.")
    return 0
  }
  const attach = await call(fetchImpl, "POST", `${TAVUS_API}/v2/pals/${encodeURIComponent(palId)}/tools`, { headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify({ tool_ids: ids }) })
  if (attach.status < 200 || attach.status >= 300) {
    out(`REFUSED by Tavus: attach to ${palId}: HTTP ${attach.status} ${JSON.stringify(attach.json?.error ?? attach.json?.message ?? "")}`)
    return 1
  }
  out(`attached to ${palId}`)

  // 4. rule 4
  const report = await ruleFourReport(fetchImpl, apiKey, palId)
  out(`RULE 4 REPORT for ${palId} (built in, cannot be removed: ${report.system.join(", ")})`)
  if (report.unread.length) {
    out(`  INCOMPLETE. Could not read: ${report.unread.join("; ")}. Do not treat this PAL as gated until you have read those yourself.`)
    for (const x of report.extra) out(`  also callable: ${x}`)
    return 2
  }
  if (report.missing.length) {
    out(`  MISSING. Tavus does not list these as attached to the PAL: ${report.missing.join(", ")}. Without request_transfer the PAL cannot reach the gate; without settle_after_call no approval settles on its own.`)
    for (const x of report.extra) out(`  also callable: ${x}`)
    return 2
  }
  if (report.extra.length) {
    out("  READ THIS. Besides the two gate tools, this PAL can also call:")
    for (const x of report.extra) out(`    ${x}`)
    out("  The gate does not see any of these. Remove whatever can move value.")
    return 2
  }
  out("  Nothing else is attached: the two gate tools are the only tools this PAL can call.")
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2), env: process.env }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`FAILED: ${e instanceof Error ? e.name : "error"} (network or unexpected response). Nothing further was sent.`)
      process.exit(1)
    },
  )
}
