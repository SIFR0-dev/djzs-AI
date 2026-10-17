/**
 * Ledger commit-and-reveal — operator shell.
 *
 * The scan author's positions in graded markets. Hash at open, reveal at close,
 * both anchored through the Worker (the funded key never leaves it; see
 * harness/anchor-correction.ts for the custody argument, which is identical).
 *
 * FILES, all under ../tests/q3/ledger/ (repo root resolves as `..`):
 *   <id>.private.json   the preimage: side, size, price, salt. GITIGNORED. Never
 *                       leaves the operator's machine until `close` copies it
 *                       into the reveal. Lose it and the commit can never be
 *                       opened — back it up where the anchor key lives.
 *   <id>.commit.json    public. Scan row, venue, market, open time, commitment.
 *   <id>.reveal.json    public, written by `close`. The preimage, the close,
 *                       and the commit's Irys id.
 *
 * COMMANDS
 *   open   --scan-row <row> --venue <v> --market <m> --side yes|no|long|short --size <n> --price <p>
 *          writes private + commit; prints the commitment. No network.
 *   close  <id> --close-price <p>      writes reveal from private + commit. No network.
 *   verify <id>                        recomputes the commitment from private and checks it against
 *                                      commit (and reveal if present). No network.
 *   anchor <id> commit|reveal --dry-run            payload, sha, tags. No network.
 *   anchor <id> commit|reveal --via-worker [--url U] [--expect-sha 0x…]
 *          POSTs the public record; refuses the write-back unless the Worker's
 *          sha equals the local one (same proof as anchor-correction.ts).
 *          A reveal can only be anchored after its commit has an irys id.
 *
 * ORDER THAT KEEPS THE DISCLOSURE HONEST: open → anchor commit → (say on camera
 * that the author holds a position in that market) → trade → close → anchor
 * reveal. A commit anchored AFTER the trade is still a commit, but the Irys
 * timestamp will show it, and the scan spec says that order is a breach.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { buildLedgerPayload, validateLedgerRecord, validatePreimage, commitmentOf, LEDGER_SCHEMA, type LedgerPreimage } from "../src/ledger-anchor"

class Halt extends Error {}
function die(msg: string): never { throw new Halt(msg) }
const DIR = "../tests/q3/ledger"
const DEFAULT_URL = "https://mcp.djzs.ai"

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : undefined
}
const need = (args: string[], name: string) => flag(args, name) ?? die(`${name} required`)
const num = (s: string, name: string) => { const n = Number(s); if (!Number.isFinite(n)) die(`${name} must be a number`); return n }
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n")
const paths = (id: string) => ({ priv: `${DIR}/${id}.private.json`, commit: `${DIR}/${id}.commit.json`, reveal: `${DIR}/${id}.reveal.json` })
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

function nextId(): string {
  mkdirSync(DIR, { recursive: true })
  let n = 1
  while (existsSync(`${DIR}/DJZS-LEDGER-${String(n).padStart(3, "0")}.commit.json`)) n++
  return `DJZS-LEDGER-${String(n).padStart(3, "0")}`
}

async function open(args: string[]) {
  const pre: LedgerPreimage = {
    venue: need(args, "--venue"), market: need(args, "--market"), side: need(args, "--side"),
    size: num(need(args, "--size"), "--size"), price: num(need(args, "--price"), "--price"),
    opened_at: flag(args, "--opened-at") ?? nowIso(), salt: "0x" + randomBytes(32).toString("hex"),
  }
  const v = validatePreimage(pre); if (!v.ok) die(v.error)
  const id = flag(args, "--id") ?? nextId(); const p = paths(id)
  if (existsSync(p.commit) || existsSync(p.priv)) die(`${id} already exists`)
  const commitment = await commitmentOf(pre)
  const commit = { id, kind: "commit", ledger_schema: LEDGER_SCHEMA, scan_row: need(args, "--scan-row"), venue: pre.venue, market: pre.market, opened_at: pre.opened_at, commitment, anchored_irys_id: null, anchored_at: null }
  const cv = await validateLedgerRecord(commit); if (!cv.ok) die(cv.error)
  mkdirSync(DIR, { recursive: true })
  writeJson(p.priv, { id, preimage: pre })
  writeJson(p.commit, commit)
  console.log(`${id} opened\n  commitment ${commitment}\n  private → ${p.priv}  (GITIGNORED; back it up)\n  commit  → ${p.commit}\nNEXT: npx tsx harness/ledger.ts anchor ${id} commit --via-worker   (before the trade, before camera)`)
}

async function close(args: string[]) {
  const id = args[0] ?? die("close <id>"); const p = paths(id)
  const priv = readJson(p.priv); const commit = readJson(p.commit)
  if (!commit.anchored_irys_id) die(`${id}: commit not anchored yet; a reveal must open an anchored commit`)
  if (existsSync(p.reveal)) die(`${id}: reveal already written`)
  const pre = priv.preimage as LedgerPreimage
  const reveal = {
    id, kind: "reveal", ledger_schema: LEDGER_SCHEMA, scan_row: commit.scan_row, venue: pre.venue, market: pre.market, opened_at: pre.opened_at,
    commitment: commit.commitment, commit_irys_id: commit.anchored_irys_id, preimage: pre,
    closed_at: flag(args, "--closed-at") ?? nowIso(), close_price: num(need(args, "--close-price"), "--close-price"),
    note: flag(args, "--note") ?? null, anchored_irys_id: null, anchored_at: null,
  }
  const v = await validateLedgerRecord(reveal); if (!v.ok) die(v.error)
  writeJson(p.reveal, reveal)
  console.log(`${id} closed → ${p.reveal}\nNEXT: npx tsx harness/ledger.ts anchor ${id} reveal --via-worker`)
}

async function verify(args: string[]) {
  const id = args[0] ?? die("verify <id>"); const p = paths(id)
  const priv = readJson(p.priv); const commit = readJson(p.commit)
  const c = await commitmentOf(priv.preimage as LedgerPreimage)
  const ok = c === commit.commitment
  console.log(`${id}\n  private → ${c}\n  commit  → ${commit.commitment}\n  ${ok ? "MATCH" : "MISMATCH — the private file does not open this commit"}`)
  if (existsSync(p.reveal)) {
    const r = readJson(p.reveal); const rv = await validateLedgerRecord({ ...r, anchored_irys_id: null })
    console.log(`  reveal  → ${rv.ok ? "valid, opens the commit" : "INVALID: " + rv.error}`)
    if (!rv.ok) process.exitCode = 1
  }
  if (!ok) process.exitCode = 1
}

async function anchor(args: string[]) {
  const id = args[0] ?? die("anchor <id> commit|reveal"); const kind = args[1]
  if (kind !== "commit" && kind !== "reveal") die("anchor <id> commit|reveal")
  const p = paths(id); const file = kind === "commit" ? p.commit : p.reveal
  const rec = readJson(file)
  const v = await validateLedgerRecord(rec); if (!v.ok) die(v.error)
  const { sha256, tags, body } = await buildLedgerPayload(v.rec)
  const expect = flag(args, "--expect-sha")
  if (expect && expect.toLowerCase() !== sha256) die(`ticket gate: local sha ${sha256} != --expect-sha ${expect}. The file changed since review. Nothing sent.`)
  if (args.includes("--dry-run")) {
    console.log(`${id} ${kind} · DRY RUN\n  sha256 ${sha256}\n  tags ${JSON.stringify(tags)}\n  body ${body}`)
    return
  }
  if (!args.includes("--via-worker")) die("choose --dry-run or --via-worker")
  const key = process.env.DJZS_ANCHOR_KEY ?? die("DJZS_ANCHOR_KEY not set (the Worker's DJZS_Q3_ANCHOR_KEY bearer)")
  const url = (flag(args, "--url") ?? DEFAULT_URL).replace(/\/$/, "") + "/ledger/anchor"
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-DJZS-Anchor-Key": key }, body: JSON.stringify(v.rec) })
  const out = await res.json() as Record<string, unknown>
  if (!res.ok || out.status !== "anchored") die(`Worker: HTTP ${res.status} ${JSON.stringify(out).slice(0, 300)}`)
  if (out.sha256 !== sha256) die(`SHA MISMATCH: Worker anchored ${out.sha256}, local ${sha256}. Writing NOTHING. Inspect ${out.gateway_url} before trusting it.`)
  writeJson(file, { ...rec, anchored_irys_id: out.irys_id, anchored_at: nowIso() })
  console.log(`${id} ${kind} anchored → ${out.gateway_url}\n  sha256 ${sha256} (Worker agrees)\n  → ${file}  COMMIT this file.`)
}

;(async () => {
  const [cmd, ...rest] = process.argv.slice(2)
  const run = { open, close, verify, anchor }[cmd ?? ""]
  if (!run) { console.error("usage: ledger.ts open|close|verify|anchor …  (see header)"); process.exit(1) }
  try { await run(rest) } catch (e) { console.error(e instanceof Halt ? e.message : e); process.exit(1) }
})()
