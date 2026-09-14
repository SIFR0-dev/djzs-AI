/**
 * Anchor a Correction Record — operator shell.
 *
 * --via-worker IS THE INTENDED PATH, and the operator never holds the funded
 * key. IRYS_UPLOAD_KEY is a Worker secret and the Q3 design keeps it there.
 * Signing and uploading happen inside the Worker; this script proves the Worker
 * anchored the bytes the operator reviewed.
 *
 * HOW THE PROOF WORKS. Both sides call the SAME `buildCorrectionPayload`
 * (src/correction-anchor.ts). The harness computes the payload sha locally,
 * POSTs the record to /corrections/anchor, and REFUSES THE WRITE-BACK unless the
 * sha the Worker returns equals the local one. A mismatch means the Worker
 * anchored something other than the reviewed record — different code, different
 * record, a proxy in between — and the correct response is to write nothing and
 * look, not to trust the id. Had each side derived the payload its own way, that
 * comparison would compare two derivations and pass or fail for the wrong
 * reason; one shared function makes it a real end-to-end check.
 *
 * THERE IS NO LOCAL-SIGNING MODE. One existed briefly behind a --local-key flag
 * and is deleted. Its only defensible use was a devnet rehearsal, which
 * --via-worker covers against the deployed Worker anyway, and the flag cost more
 * than it bought: testing it put a real permanent item on Irys MAINNET
 * (8Kqfic6PVkUUVhEEBppGTzcpr2sZCkbDjventu3W1Fvk) signed by a throwaway key.
 * A mode whose own test writes a permanent record by accident is not a mode.
 *
 * Modes:
 *   --dry-run       compute and print the payload, sha and tags. No network.
 *   --via-worker    POST to the Worker, verify the sha, write both files.
 *   --inspect <id>  READ-ONLY. No key, no writes. Fetches an Irys item, hashes
 *                   what the gateway serves, asks the index who signed it and
 *                   what it is tagged, and says whether it is ours. Use it on
 *                   anything claiming to be a DJZS record — including anything
 *                   this script is about to write back.
 *
 * Optional, and recommended whenever the record was reviewed earlier:
 *   --expect-sha 0x…   refuse before ANY network call unless the locally
 *                      computed payload sha equals this. Mirrors the refusal
 *                      agent's ticket gate (CLAUDE.md §14): a record edited
 *                      between the dry run and the anchor can no longer be
 *                      spent on. 001's reviewed sha is
 *                      0xb63d929060bf624f4a063d7b0f44cd7b03b2c1b047eff2e24fd611456264e5b9.
 *
 * Run from djzs-trust-mcp/ (repo root resolves as `..`):
 *   npx tsx harness/anchor-correction.ts 001 --dry-run
 *   DJZS_ANCHOR_KEY=… npx tsx harness/anchor-correction.ts 001 --via-worker \
 *     --url https://mcp.djzs.ai --expect-sha 0xb63d9290…
 */
import { readFileSync, writeFileSync } from "node:fs"
import {
  buildCorrectionPayload, validateCorrectionRecord, ANCHOR_EXCLUDE,
  inspectIrysItem,
} from "../src/correction-anchor"
import { POL_GATEWAY_BASE } from "../src/pol-certificate"

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

/**
 * READ-ONLY inspection of an Irys item.
 *
 * Separate from every writing path on purpose: it takes no key, sets no flag
 * that could anchor anything, and touches only two public endpoints — the
 * gateway (what bytes are served) and the index (who signed, what tags). It
 * exists because "is this item ours?" was previously only answerable by reading
 * source and trusting it, and the answer matters most in exactly the case where
 * an item's tags claim more than its signature supports.
 */
async function inspect(irysId: string): Promise<void> {
  const { CORRECTIONS, DJZS_IRYS_SIGNER } = await import("../src/corrections")
  const rep = await inspectIrysItem(irysId, DJZS_IRYS_SIGNER)
  console.log(`IRYS INSPECT · ${irysId}   (read-only, no key, nothing written)`)

  if (rep.served_sha256 === null) {
    console.log(`  gateway        UNREACHABLE from here (${rep.gateway_error})`)
    console.log(`                 ${POL_GATEWAY_BASE}/${irysId}`)
  } else {
    console.log(`  gateway        ${rep.served_bytes} bytes`)
    console.log(`  served sha256  ${rep.served_sha256}`)
    let matched = false
    for (const c of CORRECTIONS) {
      try {
        const rec = JSON.parse(readFileSync(`../${c.record_file}`, "utf8")) as Record<string, unknown>
        const expected = (await buildCorrectionPayload(rec)).sha256
        const same = expected === rep.served_sha256
        console.log(`  vs ${c.id}  ${expected}  ${same ? "MATCH — these are that record's bytes" : "differs"}`)
        if (same) matched = true
      } catch { /* an unparseable record file is not this command's problem */ }
    }
    if (!matched) console.log(`  content        matches no registered correction record`)
  }

  if (rep.indexed_at) console.log(`  indexed at     ${rep.indexed_at}`)
  console.log(`  signer         ${rep.signer ?? "unknown"}`)
  console.log(`  expected       ${rep.expected_signer}`)
  console.log(`  VERDICT        ${rep.ours ? "OURS — signed by the DJZS signer" : "NOT OURS — " + rep.detail}`)

  const tagNames = Object.keys(rep.tags)
  if (tagNames.length) {
    console.log(`  tags`)
    for (const k of tagNames) console.log(`    ${k.padEnd(18)} ${rep.tags[k]}`)
    // Tags are strings anyone can write. Saying so next to them is the point.
    if (rep.tags["correction-id"] && !rep.ours) {
      console.log(`\n  !! This item is TAGGED correction-id ${rep.tags["correction-id"]} but is NOT signed by DJZS.`)
      console.log(`  !! Tags are strings any uploader can write. The signature is not.`)
    }
  }

  const stray = CORRECTIONS.flatMap((c) => (c.known_strays ?? []).map((x) => ({ ...x, correction: c.id })))
    .find((x) => x.irys_id === irysId)
  if (stray) {
    console.log(`\n  KNOWN STRAY, already recorded against ${stray.correction}:`)
    console.log(`  ${stray.note}`)
  }
  const anchored = CORRECTIONS.find((c) => c.anchored_irys_id === irysId)
  if (anchored) console.log(`\n  This is the registered anchor for ${anchored.id}.`)
  else if (!stray) console.log(`\n  Not referenced by the correction register.`)
}

async function main() {
  const args = process.argv.slice(2)
  const id = args.find((a) => !a.startsWith("--") && !/^https?:\/\//.test(a))
  const dryRun = args.includes("--dry-run")
  const viaWorker = args.includes("--via-worker")
  const expectSha = flagValue(args, "--expect-sha")
  const inspectId = flagValue(args, "--inspect")
  if (inspectId) { await inspect(inspectId); return }
  if (!id) die("usage: anchor-correction.ts <n> [--dry-run | --via-worker --url <worker>] [--expect-sha 0x…]")
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

  // ── GATE 0: the ticket. Before keys, before any network call. ────────────
  // CLAUDE.md §14's lesson, applied here: a paid run once anchored an intent
  // file rewritten four minutes after the dry run that approved it, binding a
  // permanent certificate to a wire string no review ever saw. If the operator
  // pins the sha they reviewed, a record edited since cannot be anchored.
  if (expectSha && expectSha.toLowerCase() !== localSha.toLowerCase()) {
    die(`TICKET MISMATCH — this record does not produce the sha you pinned.\n` +
        `  --expect-sha ${expectSha}\n  computed     ${localSha}\n` +
        `The record changed since it was reviewed. Nothing was sent.`)
  }

  const mode = dryRun ? "  (DRY RUN — nothing will be uploaded)" : "  (VIA WORKER)"
  console.log(`CORRECTION ANCHOR · ${entry.id}${mode}`)
  console.log(`  record file    ${entry.record_file}`)
  console.log(`  corrects       ${entry.corrects_irys_id}  (audit ${entry.corrects_audit_id})`)
  console.log(`  scope          ${rec.scope}`)
  console.log(`  payload bytes  ${Buffer.byteLength(body)}`)
  console.log(`  local sha256   ${localSha}${expectSha ? "  (matches --expect-sha)" : ""}`)
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

  const wIrysId = out.irys_id
  const workerSha = out.sha256
  console.log(`  worker status  ${String(out.status)}`)
  console.log(`  irys_id        ${String(wIrysId)}`)
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
        `NOTHING WRITTEN BACK. Do not record ${String(wIrysId)}: it does not attest to the reviewed record.\n` +
        `Check that the deployed Worker carries this commit's correction-anchor.ts.`)
  }
  if (typeof wIrysId !== "string" || !wIrysId) die(`worker returned no irys_id: ${JSON.stringify(out)}`)
  console.log(`  sha match      OK — worker anchored the reviewed bytes`)
  const irysId = wIrysId

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
