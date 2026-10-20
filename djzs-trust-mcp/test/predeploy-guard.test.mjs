/**
 * scripts/predeploy-guard.mjs: refuses a deploy from a dirty tree or from a HEAD that is not
 * origin/main. Offline: every scenario builds a throwaway git repo and a local bare "origin" in a
 * temp directory; nothing touches the network, a key, or this repository's own state.
 *
 * Two layers:
 *   1. the script, run directly against temp repos (every verdict and every reason);
 *   2. the wiring, through the REAL wrangler: `wrangler deploy --dry-run` must run the guard as
 *      its [build] step (so a bare `npx wrangler deploy` is covered too), and the guard must
 *      block it. The refusal is made deterministic by pointing GIT_DIR at nothing, so the result
 *      does not depend on which commit this test happens to run on.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/predeploy-guard.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const WORKER = path.resolve(import.meta.dirname, "..")
const GUARD = path.join(WORKER, "scripts", "predeploy-guard.mjs")

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}

const TMP = mkdtempSync(path.join(tmpdir(), "djzs-guard-"))
// A clean environment for git and the guard: nothing from the developer's shell (a stray
// DJZS_BUILD_ONLY, GIT_DIR, WRANGLER_COMMAND, a global git identity) may decide a verdict.
const CLEAN_ENV = {
  PATH: process.env.PATH,
  HOME: TMP,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: CLEAN_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim()

let n = 0
/** A repo with a bare origin, one pushed commit on main, a .gitignore, and the worker subdirectory the guard runs from. */
function world() {
  const dir = path.join(TMP, `w${++n}`)
  const origin = path.join(dir, "origin.git")
  const work = path.join(dir, "work")
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "--bare", "-b", "main", origin)
  git(dir, "init", "-b", "main", work)
  git(work, "remote", "add", "origin", origin)
  mkdirSync(path.join(work, "djzs-trust-mcp"))
  writeFileSync(path.join(work, "djzs-trust-mcp", "a.txt"), "one\n")
  writeFileSync(path.join(work, ".gitignore"), ".dev.vars\nnode_modules\n")
  git(work, "add", "-A")
  git(work, "commit", "-m", "base")
  git(work, "push", "-u", "origin", "main")
  return { dir, origin, work, cwd: path.join(work, "djzs-trust-mcp") }
}

function guard(w, extraEnv = {}) {
  const r = spawnSync("node", [GUARD], { cwd: w.cwd, encoding: "utf8", env: { ...CLEAN_ENV, ...extraEnv } })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

try {
  console.log("1. the verdicts")
  {
    const w = world()
    const r = guard(w)
    check("clean tree, HEAD == origin/main -> exit 0", r.status === 0 && /OK: tree clean, HEAD [0-9a-f]{12} == origin\/main/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    writeFileSync(path.join(w.cwd, "a.txt"), "two\n")
    const r = guard(w)
    check("a modified tracked file -> refused, and it names the file", r.status === 1 && /REFUSED/.test(r.out) && /working tree is dirty/.test(r.out) && /a\.txt/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    writeFileSync(path.join(w.cwd, "try-route.ts"), "export {}\n")
    const r = guard(w)
    check("an UNTRACKED new file (the 2026-09-28 case) -> refused, and it names the file", r.status === 1 && /dirty/.test(r.out) && /try-route\.ts/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    writeFileSync(path.join(w.work, ".dev.vars"), "SECRET=x\n")
    mkdirSync(path.join(w.work, "node_modules"))
    writeFileSync(path.join(w.work, "node_modules", "x.js"), "1\n")
    const r = guard(w)
    check("gitignored files (.dev.vars, node_modules) do not count -> exit 0", r.status === 0, `${r.status} ${r.out}`)
  }
  {
    const w = world()
    writeFileSync(path.join(w.cwd, "a.txt"), "ahead\n")
    git(w.work, "commit", "-am", "local only")
    const r = guard(w)
    check("HEAD one commit AHEAD of origin/main (unpushed) -> refused", r.status === 1 && /is not origin\/main/.test(r.out) && !/dirty/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    const other = path.join(w.dir, "other")
    git(w.dir, "clone", w.origin, other)
    writeFileSync(path.join(other, "djzs-trust-mcp", "b.txt"), "b\n")
    git(other, "add", "-A")
    git(other, "commit", "-m", "someone else")
    git(other, "push", "origin", "main")
    const r = guard(w)
    check("HEAD BEHIND origin/main (a newer main exists) -> refused, read live from origin, not from a stale local ref", r.status === 1 && /is not origin\/main/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    git(w.work, "checkout", "--detach")
    let r = guard(w)
    check("detached HEAD at the same commit -> exit 0 (compared by SHA)", r.status === 0, `${r.status} ${r.out}`)
    git(w.work, "checkout", "-b", "feature")
    r = guard(w)
    check("a feature branch at the same commit -> exit 0 (not by branch name)", r.status === 0, `${r.status} ${r.out}`)
    writeFileSync(path.join(w.cwd, "a.txt"), "diverge\n")
    git(w.work, "commit", "-am", "feature work")
    r = guard(w)
    check("a feature branch with its own commit -> refused", r.status === 1 && /is not origin\/main/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    git(w.work, "remote", "set-url", "origin", path.join(w.dir, "does-not-exist.git"))
    const r = guard(w)
    check("origin unreachable -> refused (fail closed, never trusts a stale ref)", r.status === 1 && /could not read origin\/main/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const w = world()
    writeFileSync(path.join(w.cwd, "a.txt"), "dirty\n")
    writeFileSync(path.join(w.cwd, "new.ts"), "x\n")
    git(w.work, "checkout", "-b", "feature")
    git(w.work, "commit", "-am", "x")
    const r = guard(w)
    check("every problem is listed, not just the first (dirty AND not main)", r.status === 1 && /working tree is dirty/.test(r.out) && /is not origin\/main/.test(r.out), `${r.status} ${r.out}`)
  }
  {
    const notRepo = path.join(TMP, "not-a-repo")
    mkdirSync(notRepo)
    const r = spawnSync("node", [GUARD], { cwd: notRepo, encoding: "utf8", env: { ...CLEAN_ENV, GIT_CEILING_DIRECTORIES: TMP } })
    check("outside a git work tree -> refused", r.status === 1 && /not inside a git work tree/.test(`${r.stdout}${r.stderr}`), `${r.status} ${r.stderr}`)
  }

  console.log("2. which wrangler commands it applies to, and the dry-run opt-out")
  {
    const w = world()
    writeFileSync(path.join(w.cwd, "a.txt"), "dirty\n")
    check("WRANGLER_COMMAND=dev on a dirty tree -> stands down (exit 0)", guard(w, { WRANGLER_COMMAND: "dev" }).status === 0)
    check("WRANGLER_COMMAND=types on a dirty tree -> stands down (exit 0)", guard(w, { WRANGLER_COMMAND: "types" }).status === 0)
    check("WRANGLER_COMMAND=deploy on a dirty tree -> refused", guard(w, { WRANGLER_COMMAND: "deploy" }).status === 1)
    check("WRANGLER_COMMAND=\"versions upload\" on a dirty tree -> refused", guard(w, { WRANGLER_COMMAND: "versions upload" }).status === 1)
    check("an unknown WRANGLER_COMMAND is treated as a deploy -> refused", guard(w, { WRANGLER_COMMAND: "something-new" }).status === 1)
    const bo = guard(w, { WRANGLER_COMMAND: "deploy", DJZS_BUILD_ONLY: "1" })
    check("DJZS_BUILD_ONLY=1 stands down, loudly", bo.status === 0 && /DJZS_BUILD_ONLY=1/.test(bo.out) && /Never set this on a real deploy/.test(bo.out), `${bo.status} ${bo.out}`)
    check("DJZS_BUILD_ONLY=0 / empty does NOT stand down", guard(w, { WRANGLER_COMMAND: "deploy", DJZS_BUILD_ONLY: "0" }).status === 1 && guard(w, { WRANGLER_COMMAND: "deploy", DJZS_BUILD_ONLY: "" }).status === 1)
  }

  console.log("3. the wiring, through the real wrangler")
  {
    const toml = readFileSync(path.join(WORKER, "wrangler.toml"), "utf8")
    check("wrangler.toml declares the guard as the [build] command", /^\[build\]\s*\ncommand\s*=\s*"node scripts\/predeploy-guard\.mjs"/m.test(toml))
    const pkg = JSON.parse(readFileSync(path.join(WORKER, "package.json"), "utf8"))
    check("npm run deploy tags the Worker version with the commit it was built from", /wrangler deploy/.test(pkg.scripts.deploy) && /--tag/.test(pkg.scripts.deploy) && /--message/.test(pkg.scripts.deploy) && /git rev-parse/.test(pkg.scripts.deploy), pkg.scripts.deploy)
    const wf = readFileSync(path.join(WORKER, "..", ".github", "workflows", "djzs-gate.yml"), "utf8")
    const dry = wf.split("\n").findIndex((l) => /wrangler deploy --dry-run/.test(l))
    check("CI's dry-run build opts out explicitly (DJZS_BUILD_ONLY) rather than relying on CI=true", dry > 0 && /DJZS_BUILD_ONLY/.test(wf.split("\n").slice(dry, dry + 3).join("\n")))

    const out = path.join(TMP, "bundle-ok")
    const ok = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { cwd: WORKER, encoding: "utf8", env: { ...process.env, DJZS_BUILD_ONLY: "1" } })
    check("`wrangler deploy --dry-run` runs the guard (DJZS_BUILD_ONLY stand-down line appears) and still builds", ok.status === 0 && /predeploy-guard\] DJZS_BUILD_ONLY=1/.test(`${ok.stdout}${ok.stderr}`) && existsSync(path.join(out, "index.js")), `${ok.status} ${(ok.stdout + ok.stderr).slice(-300)}`)

    const blocked = path.join(TMP, "bundle-blocked")
    const env = { ...process.env, GIT_DIR: path.join(TMP, "nowhere", ".git") }
    delete env.DJZS_BUILD_ONLY
    const bad = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", blocked], { cwd: WORKER, encoding: "utf8", env })
    check("a bare `wrangler deploy` is BLOCKED by the guard and writes no bundle", bad.status !== 0 && /predeploy-guard\] REFUSED/.test(`${bad.stdout}${bad.stderr}`) && !existsSync(path.join(blocked, "index.js")), `${bad.status} ${(bad.stdout + bad.stderr).slice(-300)}`)
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nPREDEPLOY-GUARD: FAIL (${failures.length} of ${checks} checks failed)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nPREDEPLOY-GUARD: PASS (${checks} checks)`)
