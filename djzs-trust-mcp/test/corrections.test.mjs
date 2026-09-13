/**
 * Correction registry <-> record file consistency.
 *
 * The registry in src/corrections.ts is what the Worker serves; the record in
 * tests/q3/corrections/<n>.json is the thing that gets anchored. They are two
 * copies of the same facts, which is exactly the shape that drifts — the same
 * failure mode as the PASS/PROCEED vocabulary bug and the two WAIT counters.
 * This test makes drift a CI failure instead of a discovery.
 *
 * It also pins the invariant that matters most: a registry entry may never
 * claim an anchor the record file does not have.
 *
 * Run: npx tsx test/corrections.test.mjs
 */
import { readFileSync } from "node:fs"
import { CORRECTIONS, correctionsFor, DJZS_IRYS_SIGNER } from "../src/corrections.ts"
import { verifyAnchorSigner } from "../src/correction-anchor.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

console.log("CORRECTIONS · registry matches the anchored record")

let n = 1
for (const c of CORRECTIONS) {
  const rec = JSON.parse(readFileSync(`../${c.record_file}`, "utf8"))
  check(n++, `${c.id}: record file exists and parses (${c.record_file})`, !!rec)
  check(n++, `${c.id}: id matches the record`, rec.id === c.id)
  check(n++, `${c.id}: scope matches the record`, rec.scope === c.scope)
  check(n++, `${c.id}: corrects_audit_id matches supersedes.audit_id`, rec.supersedes?.audit_id === c.corrects_audit_id)
  check(n++, `${c.id}: corrects_irys_id matches supersedes.irys_id`, rec.supersedes?.irys_id === c.corrects_irys_id)
  check(n++, `${c.id}: anchored_irys_id matches the record`, (rec.anchored_irys_id ?? null) === c.anchored_irys_id)
  check(n++, `${c.id}: eas_uid matches the record`, (rec.eas_uid ?? null) === c.eas_uid)
  check(n++, `${c.id}: statement is non-empty`, Array.isArray(rec.statement) && rec.statement.length > 0 && rec.statement.every((p) => typeof p === "string" && p.length))
  // THE INVARIANT: the registry can never advertise an anchor the record lacks.
  // A correction that claims to be anchored when it is not is worse than one
  // that admits it is pending — it tells a reader the remedy is permanent when
  // nothing has been written.
  check(n++, `${c.id}: registry never claims an anchor the record does not have`,
    c.anchored_irys_id === null || (typeof rec.anchored_irys_id === "string" && rec.anchored_irys_id === c.anchored_irys_id))
}

// Join behaviour
const byAudit = correctionsFor("a3a5ad8f-0418-4d63-ae7b-85b39973a25b", undefined)
const byIrys = correctionsFor(undefined, "7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br")
check(n++, "joins by audit_id", byAudit.length === 1 && byAudit[0].correction_id === "DJZS-CORR-001")
check(n++, "joins by irys_id", byIrys.length === 1 && byIrys[0].correction_id === "DJZS-CORR-001")
check(n++, "unanchored correction reports authored_pending_anchor, not anchored", byAudit[0].status === "authored_pending_anchor")
check(n++, "unanchored correction exposes no irys_url", byAudit[0].irys_url === null)
check(n++, "an unrelated certificate gets no corrections", correctionsFor("00000000-0000-0000-0000-000000000000", "nope").length === 0)
check(n++, "both identifiers absent yields nothing", correctionsFor(undefined, undefined).length === 0)


// ── PROVENANCE: an anchor is ours only if the DJZS signer signed it ───────
// Anyone can upload an item wearing our tag names; the signer is the one part a
// third party cannot forge. Offline here, with the Irys index stubbed — the live
// check runs below only if something is actually anchored.
console.log("\nCORRECTIONS · anchor provenance")
const idx = (addr) => async () => new Response(JSON.stringify({
  data: { transactions: { edges: addr ? [{ node: { id: "x", address: addr } }] : [] } },
}), { status: 200 })

check(n++, "a published DJZS signer exists and is a 0x address", /^0x[0-9a-f]{40}$/.test(DJZS_IRYS_SIGNER))
check(n++, "item signed by the DJZS signer -> ok",
  (await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, idx(DJZS_IRYS_SIGNER))).ok)
check(n++, "signer match is case-insensitive",
  (await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, idx(DJZS_IRYS_SIGNER.toUpperCase()))).ok)
const wrong = await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, idx("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"))
check(n++, "item signed by ANY OTHER key -> NOT ours", !wrong.ok)
check(n++, "...and the failure names the foreign signer", wrong.detail.includes("0x19e7e376"))
check(n++, "item unknown to the index -> not ok, and says so",
  !(await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, idx(null))).ok)
const down = await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, async () => new Response("nope", { status: 500 }))
check(n++, "index down -> not ok (never a silent pass)", !down.ok && down.detail.includes("500"))
const threw = await verifyAnchorSigner("id", DJZS_IRYS_SIGNER, async () => { throw new Error("offline") })
check(n++, "index unreachable -> not ok, no throw escapes", !threw.ok && threw.detail.includes("unreachable"))

// ── the stray, recorded rather than hidden ───────────────────────────────
const one = CORRECTIONS.find((c) => c.id === "DJZS-CORR-001")
const stray = one?.known_strays?.[0]
check(n++, "001 records the known stray", stray?.irys_id === "8Kqfic6PVkUUVhEEBppGTzcpr2sZCkbDjventu3W1Fvk")
check(n++, "the stray's signer is recorded and is NOT the DJZS signer",
  stray?.signer === "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a" && stray.signer !== DJZS_IRYS_SIGNER)
check(n++, "the stray is NEVER the anchored id", one?.anchored_irys_id !== stray?.irys_id)
check(n++, "the note says plainly it is not a DJZS record", /NOT a DJZS record/.test(stray?.note ?? ""))
check(n++, "correctionsFor publishes expected_signer", byAudit[0].expected_signer === DJZS_IRYS_SIGNER)
check(n++, "correctionsFor surfaces known_strays", Array.isArray(byAudit[0].known_strays) && byAudit[0].known_strays.length === 1)

// ── /verify mirrors the register. Mirrors drift; this makes drift fail. ──
// site/verify.html is a static page and cannot import corrections.ts, so it
// carries copies of the signer, the anchored id and the strays. Two copies of
// the same facts is the shape that drifts — the PASS/PROCEED bug, the two WAIT
// counters. Asserted against the page source rather than trusted.
const verifySrc = readFileSync("../site/verify.html", "utf8")
check(n++, "/verify mirrors the same DJZS_IRYS_SIGNER", verifySrc.includes(`DJZS_IRYS_SIGNER="${DJZS_IRYS_SIGNER}"`))
check(n++, "/verify names the stray id", verifySrc.includes(stray.irys_id))
check(n++, "/verify names the stray's signer", verifySrc.includes(stray.signer))
check(n++, "/verify mirrors 001's anchored state (null while unanchored)",
  one.anchored_irys_id === null ? /anchored_irys_id:null/.test(verifySrc) : verifySrc.includes(one.anchored_irys_id))
check(n++, "/verify checks the signer against the Irys index, not the tags",
  verifySrc.includes("uploader.irys.xyz/graphql") && verifySrc.includes("NOT OURS"))

// ── live: only when something is anchored. Never a silent skip. ──────────
const anchored = CORRECTIONS.filter((c) => c.anchored_irys_id)
if (anchored.length === 0) {
  console.log(`  --  NOT EXERCISED: no correction is anchored yet, so no live signer check ran.`)
  console.log(`      This is reported, not counted as a pass. It starts running the moment`)
  console.log(`      an anchored_irys_id is recorded.`)
} else {
  for (const c of anchored) {
    const r = await verifyAnchorSigner(c.anchored_irys_id, DJZS_IRYS_SIGNER)
    check(n++, `LIVE: ${c.id} anchor is signed by the DJZS signer (${r.detail})`, r.ok)
  }
}

console.log(`\nCORRECTIONS · ${pass}/${pass + failures.length} assertions pass`)
if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
