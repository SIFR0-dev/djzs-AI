/**
 * POST /ledger/anchor + the commit/reveal derivation — fully offline.
 * Run: npx tsx test/ledger-anchor.test.mjs
 */
import { readFileSync } from "node:fs"
import { Hono } from "hono"
import { makeLedgerAnchorHandler, LEDGER_ANCHOR_PATH } from "../src/ledger-route.ts"
import { buildLedgerPayload, validateLedgerRecord, commitmentOf, anchorLedger, LEDGER_SCHEMA } from "../src/ledger-anchor.ts"
import { canonical, sha256Hex } from "../src/correction-anchor.ts"

let pass = 0; const failures = []
const check = (n, label, ok) => { if (ok) { pass++; console.log(`  ok  ${n} ${label}`) } else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) } }

const KEY = "anchor-key-for-tests-0123456789"
const ENV = { DJZS_Q3_ANCHOR_KEY: KEY, IRYS_UPLOAD_KEY: "11".repeat(32), IRYS_NODE_URL: "https://devnet.irys.xyz" }
const PRE = { venue: "polymarket.com", market: "will-microstrategy-be-delisted-from-the-msci-index-by-march-31/dec-31", side: "no", size: 100, price: 0.06, opened_at: "2026-10-17T01:00:00Z", salt: "0x" + "ab".repeat(32) }
const COMMITMENT = await commitmentOf(PRE)
const COMMIT = { id: "DJZS-LEDGER-001", kind: "commit", ledger_schema: LEDGER_SCHEMA, scan_row: "2026-10-16/msci-on-notice", venue: PRE.venue, market: PRE.market, opened_at: PRE.opened_at, commitment: COMMITMENT, anchored_irys_id: null, anchored_at: null }
const REVEAL = { ...COMMIT, kind: "reveal", commit_irys_id: "IRYS-COMMIT-ID", preimage: PRE, closed_at: "2026-11-12T00:00:00Z", close_price: 0.0, note: null }

// 1. derivation
check(1, "commitment is sha256 of canonical preimage", COMMITMENT === await sha256Hex(canonical(PRE)))
check(2, "commitment changes with salt", (await commitmentOf({ ...PRE, salt: "0x" + "cd".repeat(32) })) !== COMMITMENT)
check(3, "commit validates", (await validateLedgerRecord(COMMIT)).ok)
check(4, "reveal validates and opens the commit", (await validateLedgerRecord(REVEAL)).ok)
const r5 = await validateLedgerRecord({ ...REVEAL, preimage: { ...PRE, size: 101 } })
check(5, "reveal with a different position is refused", !r5.ok && /does not open/.test(r5.error))
const r6 = await validateLedgerRecord({ ...COMMIT, side: "no" })
check(6, "commit carrying a side is refused (it would leak)", !r6.ok && /hides/.test(r6.error))
const r7 = await validateLedgerRecord({ ...REVEAL, commit_irys_id: undefined })
check(7, "reveal without the commit's irys id is refused", !r7.ok)
const r8 = await validateLedgerRecord({ ...COMMIT, anchored_irys_id: "X" })
check(8, "already-anchored is refused", !r8.ok && /already anchored/.test(r8.error))
const r9 = await validateLedgerRecord({ ...REVEAL, preimage: { ...PRE, salt: "0x1234" } })
check(9, "short salt refused", !r9.ok && /salt/.test(r9.error))
const pc = await buildLedgerPayload(COMMIT)
check(10, "anchored bytes exclude anchored_irys_id/anchored_at", !("anchored_irys_id" in pc.payload) && !("anchored_at" in pc.payload))
check(11, "commit tags carry no side/size/price", !pc.tags.some(t => /side|size|price|salt/.test(t.name)) && pc.body.indexOf('"side"') === -1)
const pr = await buildLedgerPayload(REVEAL)
check(12, "reveal tags name the commit it opens", pr.tags.some(t => t.name === "opens-irys-id" && t.value === "IRYS-COMMIT-ID"))

// 2. route
const uploads = []
const served = new Map()
const uploadFn = async (raw) => { uploads.push(raw); const id = "ITEM" + uploads.length; return { id } }
const fetchFn = async (url) => { const id = url.split("/").pop(); const b = served.get(id); return b == null ? { ok: false, status: 404, text: async () => "" } : { ok: true, text: async () => b } }
const app = new Hono()
app.post(LEDGER_ANCHOR_PATH, makeLedgerAnchorHandler("https://devnet.irys.xyz", { uploadFn, fetchFn, verifyAttempts: 2, verifyDelayMs: 1 }))
const post = (body, headers = {}, env = ENV) => app.request(LEDGER_ANCHOR_PATH, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env)

let res = await post(COMMIT, {}, { ...ENV, IRYS_UPLOAD_KEY: undefined })
check(13, "503 when not configured", res.status === 503)
res = await post(COMMIT, { "X-DJZS-Anchor-Key": "wrong" })
check(14, "401 on bad key, before any upload", res.status === 401 && uploads.length === 0)
res = await post("{nope", { "X-DJZS-Anchor-Key": KEY })
check(15, "400 on invalid JSON", res.status === 400)
res = await post({ ...COMMIT, anchored_irys_id: "X" }, { "X-DJZS-Anchor-Key": KEY })
check(16, "409 on already anchored", res.status === 409)
res = await post({ ...REVEAL, preimage: { ...PRE, price: 0.07 } }, { "X-DJZS-Anchor-Key": KEY })
check(17, "400 when the reveal does not open the commit, nothing uploaded", res.status === 400 && uploads.length === 0)
// gateway serves nothing → 502, no id
res = await post(COMMIT, { "X-DJZS-Anchor-Key": KEY })
let body = await res.json()
check(18, "502 when the gateway never serves the item; no irys_id returned", res.status === 502 && body.irys_id === undefined && uploads.length === 1)
// gateway serves wrong bytes → 502
served.set("ITEM2", "not the record")
res = await post(COMMIT, { "X-DJZS-Anchor-Key": KEY }); body = await res.json()
check(19, "502 when the gateway serves different bytes", res.status === 502 && /different bytes/.test(body.detail))
// gateway serves the exact bytes → anchored, sha equals local derivation
served.set("ITEM3", pc.body)
res = await post(COMMIT, { "X-DJZS-Anchor-Key": KEY }); body = await res.json()
check(20, "anchored when the gateway serves the exact bytes", res.status === 200 && body.status === "anchored" && body.irys_id === "ITEM3" && body.kind === "commit")
check(21, "Worker sha equals the harness derivation", body.sha256 === pc.sha256)
served.set("ITEM4", pr.body)
res = await post(REVEAL, { "X-DJZS-Anchor-Key": KEY }); body = await res.json()
check(22, "reveal anchors with kind=reveal and matching sha", res.status === 200 && body.kind === "reveal" && body.sha256 === pr.sha256)

// 3. wiring, asserted as text (index.ts is not importable from Node)
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
check(23, "index.ts registers the exported handler at the exported path", /app\.post\(LEDGER_ANCHOR_PATH, makeLedgerAnchorHandler\(DEFAULT_IRYS_NODE_URL\)\)/.test(index))
const gi = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8")
check(24, ".gitignore excludes the private preimage files", /ledger\/\*\.private\.json/.test(gi))

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join("\n")); process.exit(1) }
