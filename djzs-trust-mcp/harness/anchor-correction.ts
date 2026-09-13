/**
 * Anchor a Correction Record to Irys — operator shell only.
 *
 * WHY THIS EXISTS RATHER THAN REUSING /q3/anchor. The Q3 anchor route commits a
 * MERKLE ROOT OF HASHES, not a document: `validateQ3AnchorRequest` accepts only
 * `0x`+64-hex `record_hashes`, and `anchorQ3` uploads a summary
 * ({schema, date, protocol_version, record_count, merkle_root, record_hashes}).
 * Pushing 001.json through it would publish a hash commitment whose gateway URL
 * returns a Q3 daily-anchor summary — no statement, no certificate id, nothing a
 * reader could act on — and tag it `application-id: DJZS-Q3`. The certificate
 * being corrected stores its FULL payload, so that route would make the
 * correction less retrievable than the error it corrects. This script uploads
 * the record body itself, through the same proven ANS-104 path the PoL
 * certificates use.
 *
 * WHAT IS ANCHORED, and why it is not the file byte-for-byte: the payload is the
 * record MINUS `anchored_irys_id` and `eas_uid`. Those two fields are filled in
 * AFTER the upload — they cannot be known before it — so including them would
 * make the anchored bytes disagree with the committed file the moment the
 * anchor succeeded. Excluding them is the same exclusion-set pattern Phase A
 * already uses (tests/q3/lib.ts PHASE_A_EXCLUDE), and it means the anchored
 * bytes stay verifiable against the committed record forever:
 *
 *     canonical(strip(record, ANCHOR_EXCLUDE))  ==  the bytes at gateway.irys.xyz/<id>
 *
 * SAFETY, in order, all before any network write:
 *   1. refuses a record that is already anchored (never double-anchor);
 *   2. refuses if the registry entry and the record file disagree;
 *   3. --dry-run does everything except the upload, so the payload and its
 *      sha256 can be inspected before anything permanent happens;
 *   4. after upload, re-fetches from the gateway and compares bytes BEFORE
 *      writing anything back — an unretrievable anchor is not recorded as one.
 *
 * Run from djzs-trust-mcp/ (paths resolve to the repo root as `..`):
 *   npx tsx harness/anchor-correction.ts 001 --dry-run
 *   IRYS_UPLOAD_KEY=0x… npx tsx harness/anchor-correction.ts 001
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { EthereumSigner, createData } from "@irys/bundles/web"
import { buildIrysUploadFn, POL_GATEWAY_BASE, POL_UPLOAD_TOKEN } from "../src/pol-certificate"

export const CORRECTION_SCHEMA = "DJZS-Correction-1"
/** Filled in only after the upload; excluded so the anchored bytes stay stable. */
const ANCHOR_EXCLUDE = new Set(["anchored_irys_id", "eas_uid"])

const DEFAULT_NODE = "https://uploader.irys.xyz"

/** Byte-for-byte canonical JSON: sorted keys, undefined skipped. Mirrors tests/q3/lib.ts. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]"
  const o = v as Record<string, unknown>
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}"
}
const sha256hex = (s: string | Buffer) => "0x" + createHash("sha256").update(s).digest("hex")
const strip = (r: Record<string, unknown>, ex: Set<string>) => {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(r)) if (!ex.has(k)) o[k] = r[k]
  return o
}
class Halt extends Error {}
/** Throws rather than process.exit: TypeScript narrows through a throw, and one
 *  exit path means a failure can never fall through to the write-back. */
function die(msg: string): never { throw new Halt(msg) }

async function main() {
  const args = process.argv.slice(2)
  const id = args.find((a) => !a.startsWith("--"))
  const dryRun = args.includes("--dry-run")
  if (!id) die("usage: anchor-correction.ts <correction-number, e.g. 001> [--dry-run]")

  const { CORRECTIONS } = await import("../src/corrections")
  const entry = CORRECTIONS.find((c) => c.record_file.endsWith(`/${id}.json`))
  if (!entry) die(`no CORRECTIONS entry whose record_file ends with /${id}.json`)

  const path = `../${entry.record_file}`
  const raw = readFileSync(path, "utf8")
  const rec = JSON.parse(raw) as Record<string, unknown>

  // ── GATE 1: never double-anchor ──────────────────────────────────────────
  if (rec.anchored_irys_id != null || entry.anchored_irys_id != null) {
    die(`${entry.id} is already anchored (record ${String(rec.anchored_irys_id)}, registry ${String(entry.anchored_irys_id)}). ` +
        `An Irys item is permanent; anchoring again would publish a second, competing record.`)
  }

  // ── GATE 2: registry and record must already agree ───────────────────────
  const sup = (rec.supersedes ?? {}) as Record<string, unknown>
  const mismatches: string[] = []
  if (rec.id !== entry.id) mismatches.push(`id: record ${String(rec.id)} vs registry ${entry.id}`)
  if (rec.scope !== entry.scope) mismatches.push(`scope: record ${String(rec.scope)} vs registry ${entry.scope}`)
  if (sup.audit_id !== entry.corrects_audit_id) mismatches.push(`audit_id: record ${String(sup.audit_id)} vs registry ${entry.corrects_audit_id}`)
  if (sup.irys_id !== entry.corrects_irys_id) mismatches.push(`irys_id: record ${String(sup.irys_id)} vs registry ${entry.corrects_irys_id}`)
  if (!Array.isArray(rec.statement) || !rec.statement.length) mismatches.push("statement is empty")
  if (mismatches.length) die(`registry and record disagree — fix before anchoring:\n  ${mismatches.join("\n  ")}`)

  // ── The payload ──────────────────────────────────────────────────────────
  const payload = strip(rec, ANCHOR_EXCLUDE)
  const body = canonical(payload)
  const bodySha = sha256hex(body)

  const tags = [
    { name: "Protocol", value: "ProofOfLogic" },
    // NOT DJZS-Oracle: a correction is not a certificate, and tagging it as one
    // would make it show up inside query_pol_certificates' own counts.
    { name: "application-id", value: "DJZS-Correction" },
    { name: "correction-schema", value: CORRECTION_SCHEMA },
    { name: "correction-id", value: String(rec.id) },
    { name: "scope", value: String(rec.scope) },
    { name: "corrects-audit-id", value: String(sup.audit_id) },
    { name: "corrects-irys-id", value: String(sup.irys_id) },
    { name: "record-sha256", value: bodySha },
    { name: "Content-Type", value: "application/json" },
  ]

  console.log(`CORRECTION ANCHOR · ${entry.id}${dryRun ? "  (DRY RUN — nothing will be uploaded)" : ""}`)
  console.log(`  record file    ${entry.record_file}`)
  console.log(`  corrects       ${entry.corrects_irys_id}  (audit ${entry.corrects_audit_id})`)
  console.log(`  scope          ${rec.scope}`)
  console.log(`  payload bytes  ${Buffer.byteLength(body)}`)
  console.log(`  payload sha256 ${bodySha}`)
  console.log(`  excluded       ${[...ANCHOR_EXCLUDE].join(", ")}  (unknowable before upload)`)
  console.log(`  tags`)
  for (const t of tags) console.log(`    ${t.name.padEnd(18)} ${t.value}`)

  if (dryRun) {
    console.log(`\n--- payload as it would be anchored ---\n${body}`)
    console.log(`\nDRY RUN COMPLETE. Nothing uploaded, no file changed.`)
    console.log(`Re-run without --dry-run, with IRYS_UPLOAD_KEY set, to anchor.`)
    return
  }

  const key = process.env.IRYS_UPLOAD_KEY
  if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) die("IRYS_UPLOAD_KEY unset or malformed (expect 32-byte hex)")
  const nodeUrl = process.env.IRYS_NODE_URL ?? DEFAULT_NODE

  const signer = new EthereumSigner(key!.startsWith("0x") ? key!.slice(2) : key!)
  const item = createData(body, signer, { tags })
  await item.sign(signer)
  console.log(`\n  signing        DataItem id ${item.id}`)
  console.log(`  uploading      ${nodeUrl}/tx/${POL_UPLOAD_TOKEN}`)

  const { id: irysId } = await buildIrysUploadFn(nodeUrl)(item.getRaw())
  const url = `${POL_GATEWAY_BASE}/${irysId}`
  console.log(`  anchored       ${irysId}`)
  console.log(`  gateway        ${url}`)

  // ── GATE 3: prove it is retrievable BEFORE recording it as anchored ──────
  console.log(`\n  verifying retrievability (gateways lag; retrying up to 10x)`)
  let served: string | null = null
  for (let i = 1; i <= 10; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) { served = await r.text(); break }
      console.log(`    attempt ${i}: HTTP ${r.status}`)
    } catch (e) {
      console.log(`    attempt ${i}: ${(e as Error).message.slice(0, 80)}`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (served === null) {
    die(`uploaded as ${irysId} but the gateway did not serve it within ~30s.\n` +
        `NOTHING WAS WRITTEN BACK. The upload may still land — re-check ${url} and, if it serves\n` +
        `the expected sha256 ${bodySha}, set anchored_irys_id by hand in BOTH files.`)
  }
  const servedSha = sha256hex(served)
  if (servedSha !== bodySha) {
    die(`gateway served DIFFERENT bytes.\n  expected ${bodySha}\n  served   ${servedSha}\n` +
        `NOTHING WAS WRITTEN BACK.`)
  }
  console.log(`    served bytes match: ${servedSha}`)

  // ── Write back, both files, or neither ───────────────────────────────────
  const updatedRec = raw.replace(/"anchored_irys_id":\s*null/, `"anchored_irys_id": ${JSON.stringify(irysId)}`)
  if (updatedRec === raw) die(`could not find "anchored_irys_id": null in ${entry.record_file}`)

  const regPath = "src/corrections.ts"
  const regRaw = readFileSync(regPath, "utf8")
  const updatedReg = regRaw.replace(/anchored_irys_id:\s*null/, `anchored_irys_id: ${JSON.stringify(irysId)}`)
  if (updatedReg === regRaw) die(`could not find "anchored_irys_id: null" in ${regPath}`)

  writeFileSync(path, updatedRec)
  writeFileSync(regPath, updatedReg)
  console.log(`\n  wrote          ${entry.record_file}`)
  console.log(`  wrote          djzs-trust-mcp/${regPath}`)
  console.log(`\nANCHORED. eas_uid stays null — there is no EAS correction schema yet;`)
  console.log(`the Irys anchor alone flips status to "anchored".`)
  console.log(`\nNext: npx tsx test/corrections.test.mjs, then commit both files.`)
}

main().catch((e) => {
  console.error(`\nHALT: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
