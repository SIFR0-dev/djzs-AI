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
 * ── WHY --local-key EXISTS AND WHY YOU SHOULD NOT USE IT ──────────────────
 *
 * --local-key reads IRYS_UPLOAD_KEY from the environment and signs here. It is
 * kept for one narrow case: a devnet rehearsal against a throwaway key, when no
 * Worker carrying /corrections/anchor is deployed yet. Everything else about it
 * is worse than --via-worker:
 *
 *   - IT MOVES THE FUNDED KEY OUT OF THE ONLY PLACE IT IS SUPPOSED TO LIVE.
 *     A Worker secret is held by one system with one access path. An env var is
 *     in a shell history, a process list, a dotfile, and whatever backed that
 *     dotfile up. The custody rule is not a formality; it is the reason the key
 *     has stayed uncompromised.
 *   - IT DESTROYS THE PROOF. With --via-worker the sha comparison is evidence
 *     that an independent system anchored the reviewed bytes. Signing locally,
 *     the same process computes the payload, signs it, and then "verifies" its
 *     own work — a check that cannot fail for the reason it is meant to catch.
 *   - IT ANCHORS FROM AN UNREVIEWED BUILD. --via-worker exercises the deployed
 *     Worker. --local-key exercises whatever is in the working tree, which may
 *     be mid-edit.
 *
 * So: --local-key on mainnet is never right, and it REFUSES a non-devnet node
 * outright rather than warning — a printed warning does not stop an upload, as
 * one test run proved by anchoring a real item to mainnet before the warning
 * had finished being read. There is no override flag, by design. If the Worker
 * is not deployed yet, deploy it — that is the smaller problem to fix.
 *
 * Modes:
 *   --dry-run       compute and print the payload, sha and tags. No network.
 *   --via-worker    POST to the Worker, verify the sha, write both files.
 *   --local-key     sign here with IRYS_UPLOAD_KEY. Read the block above first.
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
import { anchorCorrection, buildCorrectionPayload, validateCorrectionRecord, ANCHOR_EXCLUDE } from "../src/correction-anchor"

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
  const localKey = args.includes("--local-key")
  const expectSha = flagValue(args, "--expect-sha")
  if (!id) die("usage: anchor-correction.ts <n> [--dry-run | --via-worker --url <worker> | --local-key] [--expect-sha 0x…]")
  const modes = [dryRun, viaWorker, localKey].filter(Boolean).length
  if (modes > 1) die("--dry-run, --via-worker and --local-key are mutually exclusive")
  if (modes === 0) {
    die("pick a mode: --dry-run to inspect, --via-worker to anchor (the intended path),\n" +
        "or --local-key to sign here — which moves the funded key onto this machine and\n" +
        "collapses the sha check into self-verification. Read the header before using it.")
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

  const mode = dryRun ? "  (DRY RUN — nothing will be uploaded)" : viaWorker ? "  (VIA WORKER)" : "  (LOCAL KEY — see header)"
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

  // ── --local-key: signs here. Reuses the SAME anchorCorrection the route
  // calls, so this branch adds no second signing path — only a second, worse
  // place for the key to live. The warning is printed at runtime because a
  // header comment is not read by someone pasting a command.
  let irysId: string
  if (localKey) {
    const uploadKey = process.env.IRYS_UPLOAD_KEY
    if (!uploadKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(uploadKey)) {
      die("IRYS_UPLOAD_KEY unset or malformed (expect 32-byte hex).\n" +
          "It is a Worker secret. If you are reaching for it here, --via-worker is the answer.")
    }
    const node = process.env.IRYS_NODE_URL ?? "https://devnet.irys.xyz"
    console.error(`\n  !! --local-key: the funded key is in this process's environment.`)
    console.error(`  !! The sha check below is this process verifying its own work — it is NOT`)
    console.error(`  !! evidence that an independent system anchored the reviewed bytes.`)
    console.error(`  !! Intended for a devnet rehearsal only. Node: ${node}`)
    // A PRINTED WARNING DOES NOT STOP ANYTHING — learned the hard way. An
    // earlier version of this branch warned about a non-devnet node and then
    // uploaded anyway; a test run with a throwaway key against
    // uploader.irys.xyz put a real, permanent item on Irys MAINNET before the
    // warning had finished being read. Non-devnet is now a REFUSAL, and there
    // is deliberately no override flag: an override would rebuild exactly the
    // hazard this refusal exists to remove.
    if (!/devnet/.test(node)) {
      die(`--local-key refuses a non-devnet node (${node}).\n` +
          `On mainnet this writes a PERMANENT item signed by whatever key is in this\n` +
          `environment, from an unreviewed working tree, with no independent verification.\n` +
          `Use --via-worker. If the Worker is not deployed yet, deploy it — that is the\n` +
          `smaller problem. There is no override for this.`)
    }
    const out = await anchorCorrection(rec, uploadKey, node)
    irysId = out.irys_id
    console.log(`\n  irys_id        ${out.irys_id}`)
    console.log(`  sha256         ${out.sha256}`)
    console.log(`  gateway reads  ${out.verify_attempts}`)
    if (out.sha256 !== localSha) die(`internal inconsistency: anchorCorrection returned ${out.sha256}, expected ${localSha}`)
  } else {
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
  irysId = wIrysId
  }

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
