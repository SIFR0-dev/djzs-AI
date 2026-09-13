/**
 * POST /corrections/anchor + the shared payload derivation — fully offline.
 *
 * No key, no network, no Irys. The upload and the gateway read are injected, so
 * every branch the route can take is exercised here rather than discovered on a
 * live anchor of a permanent record.
 *
 * The assertions that matter most:
 *   - the auth gate refuses BEFORE any upload is attempted (a route that signs
 *     first and checks later spends the funded key on an unauthorized caller);
 *   - an already-anchored record is refused with 409, not anchored twice;
 *   - a gateway that serves different bytes, or nothing, FAILS rather than
 *     returning an id — an unretrievable anchor must never be recorded as one;
 *   - the harness and the route derive the same sha from the same record.
 *
 * Run: npx tsx test/correction-anchor.test.mjs
 */
import { readFileSync } from "node:fs"
import { Hono } from "hono"
import { makeCorrectionAnchorHandler, CORRECTION_ANCHOR_PATH } from "../src/correction-route.ts"
import {
  buildCorrectionPayload, validateCorrectionRecord, anchorCorrection,
  canonical, sha256Hex, ANCHOR_EXCLUDE, CORRECTION_SCHEMA,
} from "../src/correction-anchor.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

const KEY = "anchor-key-for-tests-0123456789"
const REC = JSON.parse(readFileSync("../tests/q3/corrections/001.json", "utf8"))
const ENV = {
  DJZS_Q3_ANCHOR_KEY: KEY,
  IRYS_UPLOAD_KEY: "11".repeat(32),
  IRYS_NODE_URL: "https://devnet.irys.xyz",
}
// The SAME handler index.ts registers, mounted at the SAME exported path.
// index.ts itself cannot be imported from Node (pre-existing module-scope TDZ in
// http-x402-bazaar.v2.ts, reordered away by esbuild in the shipped bundle), so
// the wiring is asserted separately by reading the registration as text below.
const app = new Hono()
app.post(CORRECTION_ANCHOR_PATH, makeCorrectionAnchorHandler("https://devnet.irys.xyz"))

const post = (body, headers = {}, env = ENV) =>
  app.request(CORRECTION_ANCHOR_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, env)
const auth = { "X-DJZS-Anchor-Key": KEY }

console.log("CORRECTION ANCHOR · payload derivation")
let n = 1

// ── the shared derivation ────────────────────────────────────────────────
const built = await buildCorrectionPayload(REC)
check(n++, "anchored payload EXCLUDES anchored_irys_id and eas_uid",
  !("anchored_irys_id" in built.payload) && !("eas_uid" in built.payload))
check(n++, "every other field survives",
  ["id", "scope", "supersedes", "effective", "signer", "statement"].every((k) => k in built.payload))
check(n++, "sha256 matches an independent canonical+hash of the same record",
  built.sha256 === (await sha256Hex(canonical(Object.fromEntries(
    Object.entries(REC).filter(([k]) => !ANCHOR_EXCLUDE.has(k)))))))
// The whole point of the exclusion: filling in the anchor later must not change
// what was anchored, or the committed record stops matching the gateway bytes.
const afterAnchor = { ...REC, anchored_irys_id: "SomeIrysIdWrittenLater", eas_uid: "0xabc" }
check(n++, "sha is UNCHANGED once anchored_irys_id/eas_uid are filled in",
  (await buildCorrectionPayload(afterAnchor)).sha256 === built.sha256)
check(n++, "key order in the source record does not change the sha",
  (await buildCorrectionPayload(Object.fromEntries(Object.entries(REC).reverse()))).sha256 === built.sha256)
check(n++, "a changed statement DOES change the sha",
  (await buildCorrectionPayload({ ...REC, statement: [...REC.statement, "extra"] })).sha256 !== built.sha256)
const tag = (name) => built.tags.find((t) => t.name === name)?.value
check(n++, "tagged application-id DJZS-Correction, never DJZS-Oracle", tag("application-id") === "DJZS-Correction")
check(n++, "correction-schema tag", tag("correction-schema") === CORRECTION_SCHEMA)
check(n++, "corrects-irys-id tag names the certificate", tag("corrects-irys-id") === REC.supersedes.irys_id)
check(n++, "record-sha256 tag equals the payload sha", tag("record-sha256") === built.sha256)

// ── validation ───────────────────────────────────────────────────────────
check(n++, "valid record passes", validateCorrectionRecord(REC).ok)
check(n++, "already-anchored record is refused",
  validateCorrectionRecord({ ...REC, anchored_irys_id: "X" }).error?.startsWith("already anchored"))
for (const [label, bad] of [
  ["no id", { ...REC, id: undefined }],
  ["no scope", { ...REC, scope: "" }],
  ["no supersedes", { ...REC, supersedes: undefined }],
  ["supersedes without irys_id", { ...REC, supersedes: { audit_id: "a" } }],
  ["empty statement", { ...REC, statement: [] }],
  ["statement of non-strings", { ...REC, statement: [1, 2] }],
  ["an array", []],
  ["null", null],
]) check(n++, `refused: ${label}`, !validateCorrectionRecord(bad).ok)

// ── the route ────────────────────────────────────────────────────────────
console.log("\nCORRECTION ANCHOR · route")

// Auth must refuse BEFORE anything is signed or uploaded. The counter proves it.
let uploadCalls = 0
const origFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes("/tx/")) { uploadCalls++; return new Response(JSON.stringify({ id: "STUBBED" }), { status: 200 }) }
  return new Response("unexpected", { status: 500 })
}

let r = await post(REC)
check(n++, "no key -> 401", r.status === 401)
r = await post(REC, { "X-DJZS-Anchor-Key": "wrong-key-same-length-012345678" })
check(n++, "wrong key of equal length -> 401", r.status === 401)
r = await post(REC, { "X-DJZS-Anchor-Key": KEY.slice(0, -1) })
check(n++, "truncated key -> 401", r.status === 401)
check(n++, "NOTHING was uploaded while unauthorized", uploadCalls === 0)

r = await post(REC, auth, { ...ENV, IRYS_UPLOAD_KEY: undefined })
check(n++, "no IRYS_UPLOAD_KEY -> 503", r.status === 503)
r = await post(REC, auth, { ...ENV, DJZS_Q3_ANCHOR_KEY: undefined })
check(n++, "no DJZS_Q3_ANCHOR_KEY -> 503 (not 401)", r.status === 503)
check(n++, "still nothing uploaded", uploadCalls === 0)

r = await post("{not json", auth)
check(n++, "malformed JSON -> 400", r.status === 400)
r = await post({ ...REC, statement: [] }, auth)
check(n++, "invalid record -> 400", r.status === 400)
r = await post({ ...REC, anchored_irys_id: "AlreadyThere" }, auth)
check(n++, "already anchored -> 409 CONFLICT, not 400", r.status === 409)
check(n++, "no upload for any refused request", uploadCalls === 0)

// Happy path: upload stubbed, gateway serves the exact bytes.
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes("/tx/")) { uploadCalls++; return new Response(JSON.stringify({ id: "IrysIdStub001" }), { status: 200 }) }
  if (u.includes("gateway.irys.xyz")) return new Response(built.body, { status: 200 })
  return new Response("unexpected", { status: 500 })
}
r = await post(REC, auth)
const okBody = await r.json()
check(n++, "authorized + valid -> 200", r.status === 200)
check(n++, "returns irys_id", okBody.irys_id === "IrysIdStub001")
check(n++, "returns sha256 equal to the shared derivation", okBody.sha256 === built.sha256)
check(n++, "exactly one upload", uploadCalls === 1)

// Gateway serves DIFFERENT bytes -> must fail, not return an id.
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes("/tx/")) return new Response(JSON.stringify({ id: "IrysIdStub002" }), { status: 200 })
  if (u.includes("gateway.irys.xyz")) return new Response('{"tampered":true}', { status: 200 })
  return new Response("unexpected", { status: 500 })
}
r = await post(REC, auth)
const tamperBody = await r.json()
check(n++, "gateway serving different bytes -> 502", r.status === 502)
check(n++, "...and returns NO irys_id to record", tamperBody.irys_id === undefined)
check(n++, "...and says so", String(tamperBody.detail).includes("different bytes"))

// Gateway never serves it -> must fail.
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes("/tx/")) return new Response(JSON.stringify({ id: "IrysIdStub003" }), { status: 200 })
  return new Response("not found", { status: 404 })
}
const unretrievable = await anchorCorrection(REC, "22".repeat(32), "https://devnet.irys.xyz", {
  uploadFn: async () => ({ id: "IrysIdStub003" }),
  fetchFn: async () => new Response("not found", { status: 404 }),
  verifyAttempts: 2, verifyDelayMs: 1,
}).then(() => null, (e) => e)
check(n++, "gateway never serving it -> throws", unretrievable instanceof Error)
check(n++, "...names the id so the operator can re-check", String(unretrievable?.message).includes("IrysIdStub003"))
check(n++, "...and states nothing was recorded", String(unretrievable?.message).includes("NOTHING RECORDED"))

// Upload itself fails -> no id, no partial success.
const uploadFailed = await anchorCorrection(REC, "22".repeat(32), "https://devnet.irys.xyz", {
  uploadFn: async () => { throw new Error("Irys upload rejected: 402") },
  fetchFn: async () => new Response(built.body, { status: 200 }),
}).then(() => null, (e) => e)
check(n++, "upload failure propagates, no id invented", uploadFailed instanceof Error && String(uploadFailed.message).includes("402"))

globalThis.fetch = origFetch

// ── the one thing mounting the handler here cannot prove ─────────────────
const indexSrc = readFileSync("src/index.ts", "utf8")
check(n++, "index.ts registers the handler at CORRECTION_ANCHOR_PATH",
  /app\.post\(\s*CORRECTION_ANCHOR_PATH\s*,\s*makeCorrectionAnchorHandler\(/.test(indexSrc))
check(n++, "index.ts imports it from correction-route, not a local copy",
  /from "\.\/correction-route"/.test(indexSrc))
check(n++, "the exported path is the documented one", CORRECTION_ANCHOR_PATH === "/corrections/anchor")

console.log(`\nCORRECTION ANCHOR · ${pass}/${pass + failures.length} assertions pass`)
if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
