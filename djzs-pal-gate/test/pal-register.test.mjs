/**
 * The Tavus side of the gate: the two tool definitions, and the script that registers them.
 * Offline. The network is a stub written in this file; nothing is sent to Tavus and no key exists.
 *
 * Pins:
 *   - NO ENDPOINT AND NO SECRET IN A TRACKED FILE: pal/*.json carry neither; the script adds both
 *     at send time from the environment, and never prints the secret or the API key;
 *   - the definitions meet the documented Create Tool constraints, and say what the Worker expects:
 *     the tool names, the routes, and the four argument names are the ones the Worker reads;
 *   - RULE 1 on the Tavus side: the in-call tool speaks the gate's answer word for word
 *     (response_in_result) and speaks a fixed line while waiting (static_filler), so the model
 *     never gets to announce a payout before the gate has answered;
 *   - RULE 3 on the Tavus side: the settle tool is post_call and every parameter is fixed, so
 *     nothing from the transcript reaches it;
 *   - the preflight probe really does tell a matching secret from a wrong one, against the real
 *     Worker code, without touching the store;
 *   - RULE 4: the report lists everything else the PAL can call, and never reports clean on an
 *     answer it could not read.
 *
 * Run: npx tsx test/pal-register.test.mjs
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import app from "../src/index.ts"
import { parseToolArguments } from "../src/intent.ts"
import { ROUTES, TAVUS_API, TOOL_FILES, buildBodies, gateOrigin, loadDefinitions, masked, probe, problems, run } from "../pal/register.mjs"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${String(detail).slice(0, 400)}` : ""}`) }
}

const ROOT = path.resolve(import.meta.dirname, "..")
const SECRET = "test-only-secret-0123456789abcdef0123456789"
const APIKEY = "test-only-tavus-api-key"
const GATE = "https://gate.example.test"
const ENV = { PAL_GATE_URL: GATE, TAVUS_TOOL_SECRET: SECRET, TAVUS_API_KEY: APIKEY, TAVUS_PAL_ID: "p123" }
const thrown = (fn) => { try { fn(); return null } catch (e) { return e.message } }

// ════ 1. the tracked definitions ════════════════════════════════════════════════════════
const [reqDef, settleDef] = loadDefinitions()
const rawFiles = TOOL_FILES.map((f) => readFileSync(path.join(ROOT, "pal", f), "utf8"))
check(1, "NO ENDPOINT AND NO SECRET IN A TRACKED FILE: neither definition has a url or a secret", rawFiles.every((t) => !/"url"\s*:/.test(t) && !/"secret"\s*:/.test(t) && !/https?:\/\//.test(t)) && reqDef.delivery.api.auth.secret === undefined && settleDef.delivery.api.url === undefined)
const INDEX = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8")
check(2, "the tool names are the ones the Worker pins, and each has its route in the Worker", reqDef.name === "request_transfer" && settleDef.name === "settle_after_call" && INDEX.includes(`const TOOL_NAME = "${reqDef.name}"`) && INDEX.includes(`const POST_CALL_TOOL_NAME = "${settleDef.name}"`) && Object.values(ROUTES).every((r) => INDEX.includes(`app.post("${r}"`)))
const args = Object.keys(reqDef.parameters.properties)
const parsed = await parseToolArguments(JSON.stringify({ recipient: "0x" + "a".repeat(40), amount_usdc: "1.00", reference: "PG7K2M9QX4", reason: "prize" }))
check(3, "the four arguments the tool declares are the four the Worker reads, and none is required", args.join(",") === "recipient,amount_usdc,reference,reason" && parsed.recipient.state === "present" && parsed.amount.state === "present" && parsed.reference.state === "present" && parsed.reason.state === "present" && (reqDef.parameters.required ?? []).length === 0 && args.every((k) => reqDef.parameters.properties[k].type === "string"))
check(4, "RULE 1: the gate's answer is spoken word for word, and the wait is a fixed line, not the model's", reqDef.on_resolve === "response_in_result" && reqDef.on_call === "static_filler" && typeof reqDef.static_filler === "string" && reqDef.static_filler.length > 10 && !/sent|sending|approved|transfer(r)?ing/i.test(reqDef.static_filler), reqDef.static_filler)
check(5, "RULE 3: the settle tool is post_call, sets no origin or in-call behaviour, and every parameter is fixed", settleDef.trigger_type === "post_call" && settleDef.origin === undefined && settleDef.on_call === undefined && settleDef.on_resolve === undefined && Object.values(settleDef.parameters.properties).every((p) => p.const !== undefined))
check(6, "both use API delivery with hmac and a timeout inside Tavus's 60 second ceiling", [reqDef, settleDef].every((d) => d.delivery.app_message === undefined && d.delivery.api.auth.type === "hmac" && d.delivery.api.method === "POST" && d.delivery.api.timeout > 0 && d.delivery.api.timeout <= 60))

// ════ 2. what the script builds ═════════════════════════════════════════════════════════
const bodies = buildBodies({ gateUrl: GATE + "/", secret: SECRET })
check(7, "the endpoint and the secret are added at build time, one route per tool", bodies[0].delivery.api.url === `${GATE}/tavus/tool/request_transfer` && bodies[1].delivery.api.url === `${GATE}/tavus/post-call/settle` && bodies.every((b) => b.delivery.api.auth.secret === SECRET && b.delivery.api.auth.type === "hmac"))
check(8, "both bodies meet every documented constraint the script checks", bodies.every((b) => problems(b).length === 0), bodies.map((b) => problems(b).join("; ")).join(" | "))
check(9, "the definitions in memory were not altered by building (the tracked shape stays clean)", loadDefinitions()[0].delivery.api.url === undefined)
check(10, "masked() hides the secret and nothing else", JSON.stringify(masked(bodies[0])).includes("********") && !JSON.stringify(masked(bodies[0])).includes(SECRET) && masked(bodies[0]).delivery.api.url === bodies[0].delivery.api.url && bodies[0].delivery.api.auth.secret === SECRET)
check(11, "PAL_GATE_URL must be an https origin: http, a path, a query and credentials are refused", [undefined, "", "gate.example.test", "http://gate.example.test", `${GATE}/tavus`, `${GATE}/?x=1`, "https://user:pw@gate.example.test"].every((u) => thrown(() => gateOrigin(u)) !== null) && gateOrigin(GATE) === GATE)
check(12, "a missing, short or whitespace-carrying secret is refused before anything is built", [undefined, "", "short", SECRET + "\n", "has space " + SECRET].every((s) => thrown(() => buildBodies({ gateUrl: GATE, secret: s })) !== null))
const bad = structuredClone(bodies[0]); bad.on_resolve = "generate_response"; bad.on_call = "generate_filler"; bad.parameters.properties.tavus_x = { type: "string" }; bad.delivery.api.timeout = 90
const openParam = structuredClone(bodies[1]); openParam.parameters.properties.note = { type: "string", description: "summary of the call" }
check(13, "problems() catches a model-spoken result, a model-spoken filler, a reserved name, a long timeout, and an AI-filled post-call parameter", problems(bad).length === 4 && problems(openParam).length === 1 && problems(openParam)[0].includes("note"), `${problems(bad).join(" | ")} || ${problems(openParam).join(" | ")}`)

// ════ 3. the preflight probe, against the real Worker ═══════════════════════════════════
const askWorker = (p, env) => app.fetch(new Request(p.url, { method: p.method, headers: p.headers, body: p.body }), env)
const right = await askWorker(probe({ gateUrl: GATE, secret: SECRET }), { TAVUS_TOOL_SECRET: SECRET, GATE_MODE: "open", EXECUTOR: "dry_run" })
const wrong = await askWorker(probe({ gateUrl: GATE, secret: SECRET }), { TAVUS_TOOL_SECRET: "the-workers-secret-is-a-different-one-0000", GATE_MODE: "open", EXECUTOR: "dry_run" })
const unset = await askWorker(probe({ gateUrl: GATE, secret: SECRET }), { GATE_MODE: "open", EXECUTOR: "dry_run" })
check(14, "the probe: 400 wrong_tool when the secrets match, 401 when they do not, 503 when the Worker has none", right.status === 400 && (await right.json()).error === "wrong_tool" && wrong.status === 401 && unset.status === 503)
check(15, "the probe is answered with no store bound at all: it is refused before any record is touched", right.status === 400)

// ════ 4. the script, end to end, on a stubbed network ═══════════════════════════════════
/** A stub of the two hosts the script talks to. `world` sets what Tavus and the gate answer. */
function stub(world = {}) {
  const calls = []
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? "GET"
    calls.push({ method, url, headers: init.headers ?? {}, body: init.body })
    if (u.origin === GATE) {
      if (u.pathname === "/health") return world.health ?? j({ ok: true, service: "djzs-pal-gate", gate_mode: "closed", executor: "dry_run", store_bound: true })
      // the real Worker answers the probe
      return app.fetch(new Request(url, { method, headers: init.headers, body: init.body }), { TAVUS_TOOL_SECRET: world.workerSecret ?? SECRET, GATE_MODE: "closed", EXECUTOR: "dry_run" })
    }
    if (u.origin !== TAVUS_API) return new Response("unexpected host", { status: 599 })
    if (method === "POST" && u.pathname === "/v2/tools") {
      const body = JSON.parse(init.body)
      if (world.conflict === body.name) return j({ error: "Bad Request. A tool with this name already exists" }, 409)
      return j({ tool_id: `t_${body.name}`, name: body.name, delivery: { api: { ...body.delivery.api, auth: { type: "hmac", secret: "********" } } } })
    }
    if (method === "POST" && u.pathname === "/v2/pals/p123/tools") return j({})
    if (method === "GET" && u.pathname === "/v2/pals/p123/tools") return world.attached ?? j({ data: [{ tool_id: "t_request_transfer", name: "request_transfer" }, { tool_id: "t_settle_after_call", name: "settle_after_call" }] })
    if (method === "GET" && u.pathname === "/v2/pals/p123") return world.pal ?? j({ pal_id: "p123", layers: { llm: { model: "x" } } })
    if (method === "GET" && u.pathname === "/v2/pals/p123/skills") return world.skills ?? j({})
    return j({ error: "not found" }, 404)
  }
  return { calls, fetchImpl }
}
async function go(world, env = ENV, argv = ["--send"]) {
  const s = stub(world)
  const lines = []
  const code = await run({ argv, env, fetchImpl: s.fetchImpl, out: (l) => lines.push(l) })
  return { code, text: lines.join("\n"), calls: s.calls }
}

const dry = await go({}, ENV, [])
check(16, "DRY RUN BY DEFAULT: without --send nothing is requested, and the printed bodies carry a masked secret", dry.code === 0 && dry.calls.length === 0 && dry.text.includes("DRY RUN") && dry.text.includes("********") && !dry.text.includes(SECRET) && !dry.text.includes(APIKEY))

const clean = await go({})
const seq = clean.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)
check(17, "--send: preflight, create two, attach, then the three rule 4 reads, in that order", clean.code === 0 && seq.join(" > ") === "GET /health > POST /tavus/post-call/settle > POST /v2/tools > POST /v2/tools > POST /v2/pals/p123/tools > GET /v2/pals/p123/tools > GET /v2/pals/p123 > GET /v2/pals/p123/skills", `${clean.code} ${seq.join(" > ")}\n${clean.text}`)
const creates = clean.calls.filter((c) => c.method === "POST" && c.url === `${TAVUS_API}/v2/tools`)
const attach = clean.calls.find((c) => c.url === `${TAVUS_API}/v2/pals/p123/tools` && c.method === "POST")
check(18, "the Tavus requests carry the API key in x-api-key, the real secret in the body, and the two tool ids", creates.length === 2 && creates.every((c) => c.headers["x-api-key"] === APIKEY && JSON.parse(c.body).delivery.api.auth.secret === SECRET) && JSON.stringify(JSON.parse(attach.body)) === JSON.stringify({ tool_ids: ["t_request_transfer", "t_settle_after_call"] }))
check(19, "the API key goes to Tavus only: no request to the gate carries it", clean.calls.filter((c) => c.url.startsWith(GATE)).every((c) => !JSON.stringify(c.headers).includes(APIKEY)) && clean.calls.filter((c) => c.url.startsWith(GATE)).length === 2)
check(20, "nothing the script prints contains the secret or the API key; a clean PAL is reported as clean", !clean.text.includes(SECRET) && !clean.text.includes(APIKEY) && clean.text.includes("the two gate tools are the only tools this PAL can call"))

const mismatch = await go({ workerSecret: "the-workers-secret-is-a-different-one-0000" })
check(21, "a secret that is not the Worker's stops the run before anything reaches Tavus", mismatch.code === 1 && mismatch.calls.every((c) => !c.url.startsWith(TAVUS_API)) && mismatch.text.includes("NOT the Worker's TAVUS_TOOL_SECRET"))
const notGate = await go({ health: new Response("<html>hello</html>", { status: 200 }) })
check(22, "a URL that does not answer as djzs-pal-gate stops the run before the probe", notGate.code === 1 && notGate.calls.length === 1)
const noKey = await go({}, { ...ENV, TAVUS_API_KEY: "" })
check(23, "--send without an API key requests nothing", noKey.code === 1 && noKey.calls.length === 0)
const conflict = await go({ conflict: "settle_after_call" })
check(24, "a name Tavus already has: the run stops, says which tool it already created, and attaches nothing", conflict.code === 1 && conflict.text.includes("already exists") && conflict.text.includes("t_request_transfer") && !conflict.calls.some((c) => c.url.includes("/v2/pals/")))
const noPal = await go({}, { ...ENV, TAVUS_PAL_ID: "" })
check(25, "without TAVUS_PAL_ID the tools are created and nothing is attached or reported as gated", noPal.code === 0 && !noPal.calls.some((c) => c.url.includes("/v2/pals/")) && noPal.text.includes("attached to nothing"))

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })
const extraTool = await go({ attached: j([{ name: "request_transfer" }, { name: "settle_after_call" }, { name: "send_refund" }]) })
check(26, "RULE 4: another attached tool is named, and the run exits non-zero", extraTool.code === 2 && extraTool.text.includes("attached tool: send_refund") && !extraTool.text.includes("only tools this PAL can call"))
const inline = await go({ pal: j({ layers: { llm: { tools: [{ type: "function", function: { name: "legacy_pay" } }] }, mcp: { connectors: [{ name: "bank" }] } } }), skills: j({ search: { config: {} } }) })
check(27, "RULE 4: legacy inline tools, MCP connectors and skills are all listed", inline.code === 2 && inline.text.includes("legacy_pay") && inline.text.includes("MCP connectors are configured") && inline.text.includes("skill: search"))
const unreadable = await go({ attached: j({ something: "else" }) })
const failing = await go({ pal: j({ message: "Invalid access token" }, 401) })
check(28, "RULE 4: an answer it cannot read is INCOMPLETE, never clean", unreadable.code === 2 && unreadable.text.includes("INCOMPLETE") && failing.code === 2 && failing.text.includes("INCOMPLETE") && !unreadable.text.includes("only tools this PAL can call") && !failing.text.includes("only tools this PAL can call"))
const notAttached = await go({ attached: j({ data: [{ name: "request_transfer" }] }) })
check(29, "RULE 4: a gate tool Tavus does not list as attached is reported as MISSING", notAttached.code === 2 && notAttached.text.includes("MISSING") && notAttached.text.includes("settle_after_call"))

// ════ 5. the command itself ═════════════════════════════════════════════════════════════
const cli = execFileSync("node", ["pal/register.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH, PAL_GATE_URL: GATE, TAVUS_TOOL_SECRET: SECRET }, encoding: "utf8" })
check(30, "run as a command with no flag: a dry run, exit 0, secret masked", cli.includes("DRY RUN") && cli.includes("********") && !cli.includes(SECRET) && cli.includes(`${GATE}/tavus/tool/request_transfer`))
let refusedCode = 0
let refusedOut = ""
try { execFileSync("node", ["pal/register.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH, PAL_GATE_URL: "http://gate.example.test", TAVUS_TOOL_SECRET: SECRET }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { refusedCode = e.status; refusedOut = String(e.stdout) }
check(31, "run as a command with an http URL: refused, exit 1", refusedCode === 1 && refusedOut.includes("REFUSED") && refusedOut.includes("https"), `${refusedCode} ${refusedOut}`)

console.log(failures.length ? `\nPAL-REGISTER: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nPAL-REGISTER: PASS (${pass} checks)`)
process.exit(failures.length ? 1 : 0)
