/**
 * Anchor a Correction Record — operator shell, WITHOUT holding the funded key.
 *
 * THE LOCAL-SIGNING PATH IS GONE, DELIBERATELY. An earlier version of this file
 * read IRYS_UPLOAD_KEY from the environment and signed here. That worked, and it
 * was wrong: IRYS_UPLOAD_KEY is a Worker secret, the Q3 design keeps it there,
 * and a harness that wants it on the operator's disk contradicts the custody
 * rule it exists to serve. It is not behind a flag either — a flag is an
 * invitation, and there is no case where exporting the funded key to a laptop is
 * the right answer. Signing and uploading happen inside the Worker; this script
 * proves the Worker anchored the bytes the operator meant.
 *
 * HOW THE PROOF WORKS. Both sides call the SAME `buildCorrectionPayload`
 * (src/correction-anchor.ts). The harness computes the payload sha locally,
 * POSTs the record to /corrections/anchor, and REFUSES THE WRITE-BACK unless the
 * sha the Worker returns equals the local one. A mismatch means the Worker
 * anchored something other than the reviewed record — different code, different
 * record, a proxy in between — and the correct response is to write nothing and
 * look, not to trust the id.
 *
 * Modes:
 *   --dry-run       compute and print the payload, sha and tags. No network.
 *   --via-worker    POST to the Worker, verify the sha, write both files.
 *
 * Run from djzs-trust-mcp/ (repo root resolves as `..`):
 *   npx tsx harness/anchor-correction.ts 001 --dry-run
 *   DJZS_ANCHOR_KEY=… npx tsx harness/anchor-correction.ts 001 --via-worker \
 *     --url https://mcp.djzs.ai
 */
import { readFileSync, writeFileSync } from "node:fs"
import { buildCorrectionPayload, validateCorrectionRecord, ANCHOR_EXCLUDE } from "../src/correction-anchor"

class Halt extends Error {}
/** Throws rather than process.exit: TypeScript narrows through a throw, and one
 *  exit path means a failure can never fall through to the write-back. */
function die(msg: string): never { throw new Halt(msg) }

const DEFAULT_URL = "https://mcp.djzs.ai"

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const id = args.find((a) => !a.startsWith("--") && !/^https?:\/\//.test(a))
  const dryRun = args.includes("--dry-run")
  const viaWorker = args.includes("--via-worker")
  if (!id) die("usage: anchor-correction.ts <correction-number, e.g. 001> [--dry-run | --via-worker --url <worker>]")
  if (dryRun && viaWorker) die("--dry-run and --via-worker are mutually exclusive")
  if (!dryRun && !viaWorker) {
    die("pick a mode: --dry-run to inspect, or --via-worker to anchor.\n" +
        "There is no local-signing mode: IRYS_UPLOAD_KEY is a Worker secret and stays one.")
  }

  const { CORRECTIONS } = await import("../src/corrections")
  const entry = CORRECTIONS.find((c) => c.record_file.endsWith(`/${id}.json`))
  if (!entry) die(`no CORRECTIONS entry whose record_file ends with /${id}.json`)

  const path = `../${entry.record_file}`
  const raw = readFileSync(path, "utf8")
  const rec = JSON.parse(raw) as Record<string, unknown>

  // ── GATE 1: never double-anchor. Checked here AND in the route. ──────────
  const shape = validateCorrectionRecord(rec)
  if (!shape.ok) die(`${entry.id}: ${shape.error}`)
  if (entry.anchored_irys_id != null) {
    die(`${entry.id} is already anchored in the registry as ${entry.anchored_irys_id} while the record file says null. ` +
        `Fix the disagreement before anchoring anything.`)
  }

  // ── GATE 2: registry and record must already agree ───────────────────────
  const sup = (rec.supersedes ?? {}) as Record<string, unknown>
  const mismatches: string[] = []
  if (rec.id !== entry.id) mismatches.push(`id: record ${String(rec.id)} vs registry ${entry.id}`)
  if (rec.scope !== entry.scope) mismatches.push(`scope: record ${String(rec.scope)} vs registry ${entry.scope}`)
  if (sup.audit_id !== entry.corrects_audit_id) mismatches.push(`audit_id: record ${String(sup.audit_id)} vs registry ${entry.corrects_audit_id}`)
  if (sup.irys_id !== entry.corrects_irys_id) mismatches.push(`irys_id: record ${String(sup.irys_id)} vs registry ${entry.corrects_irys_id}`)
  if (mismatches.length) die(`registry and record disagree — fix before anchoring:\n  ${mismatches.join("\n  ")}`)

  // ── The payload, from the SAME function the Worker route calls ───────────
  const { body, sha256: localSha, tags } = await buildCorrectionPayload(rec)

  console.log(`CORRECTION ANCHOR · ${entry.id}${dryRun ? "  (DRY RUN — nothing will be uploaded)" : "  (VIA WORKER)"}`)
  console.log(`  record file    ${entry.record_file}`)
  console.log(`  corrects       ${entry.corrects_irys_id}  (audit ${entry.corrects_audit_id})`)
  console.log(`  scope          ${rec.scope}`)
  console.log(`  payload bytes  ${Buffer.byteLength(body)}`)
  console.log(`  local sha256   ${localSha}`)
  console.log(`  excluded       ${[...ANCHOR_EXCLUDE].join(", ")}  (unknowable before upload)`)
  console.log(`  tags`)
  for (const t of tags) console.log(`    ${t.name.padEnd(18)} ${t.value}`)

  if (dryRun) {
    console.log(`\n--- payload as it would be anchored ---\n${body}`)
    console.log(`\nDRY RUN COMPLETE. Nothing uploaded, no file changed.`)
    console.log(`To anchor: --via-worker --url <worker>, with DJZS_ANCHOR_KEY set.`)
    return
  }

  const anchorKey = process.env.DJZS_ANCHOR_KEY
  if (!anchorKey) die("DJZS_ANCHOR_KEY unset — the route is gated on it (X-DJZS-Anchor-Key)")
  const base = flagValue(args, "--url") ?? args.find((a) => /^https?:\/\//.test(a)) ?? DEFAULT_URL
  const url = `${base.replace(/\/$/, "")}/corrections/anchor`

  console.log(`\n  POST           ${url}`)
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DJZS-Anchor-Key": anchorKey },
    body: JSON.stringify(rec),
  })
  const text = await res.text()
  let out: Record<string, unknown>
  try { out = JSON.parse(text) } catch { die(`worker returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`) }
  if (!res.ok) die(`worker refused (HTTP ${res.status}): ${JSON.stringify(out)}`)

  const irysId = out.irys_id
  const workerSha = out.sha256
  console.log(`  worker status  ${String(out.status)}`)
  console.log(`  irys_id        ${String(irysId)}`)
  console.log(`  worker sha256  ${String(workerSha)}`)
  if (typeof out.verify_attempts === "number") console.log(`  gateway reads  ${out.verify_attempts}`)

  // ── GATE 3: THE POINT OF --via-worker ────────────────────────────────────
  // The operator never held the key, so the only thing tying the returned id to
  // the reviewed record is this comparison. Both shas come from the same
  // buildCorrectionPayload, so a match is an end-to-end agreement on bytes and
  // not two derivations that happen to look alike.
  if (typeof workerSha !== "string" || workerSha !== localSha) {
    die(`SHA MISMATCH — the Worker anchored bytes this record does not produce.\n` +
        `  local  ${localSha}\n  worker ${String(workerSha)}\n` +
        `NOTHING WRITTEN BACK. Do not record ${String(irysId)}: it does not attest to the reviewed record.\n` +
        `Check that the deployed Worker carries this commit's correction-anchor.ts.`)
  }
  if (typeof irysId !== "string" || !irysId) die(`worker returned no irys_id: ${JSON.stringify(out)}`)
  console.log(`  sha match      OK — worker anchored the reviewed bytes`)

  // ── Write back, both files ───────────────────────────────────────────────
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
