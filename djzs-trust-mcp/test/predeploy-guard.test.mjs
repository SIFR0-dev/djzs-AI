/**
 * scripts/predeploy-guard.mjs: refuses a deploy from a dirty tree or from a HEAD that is not
 * origin/main. Offline: every scenario builds a throwaway git repo and a local bare "origin" in a
 * temp directory; nothing touches the network, a key, or this repository's own state.
 *
 * Three layers:
 *   1. the script, run directly against temp repos (every verdict and every reason);
 *   1b. the SITE deploy (site/, an assets-only Worker): the exact command site/wrangler.toml declares,
 *      run the way wrangler runs it (a shell, in the invoking directory) against a temp repo with the
 *      real layout. This layer does not run wrangler; layer 2 below proves the Worker's wiring through
 *      the real one, and wrangler's own handling of an assets-only config was read from its source.
 *   2. the wiring, through the REAL wrangler: `wrangler deploy --dry-run` must run the guard as
 *      its [build] step (so a bare `npx wrangler deploy` is covered too), and the guard must
 *      block it. The refusal is made deterministic by pointing GIT_DIR at nothing, so the result
 *      does not depend on which commit this test happens to run on.
 *
 * Run from djzs-trust-mcp/:   npx tsx test/predeploy-guard.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const WORKER = path.resolve(import.meta.dirname, "..")
const GUARD = path.join(WORKER, "scripts", "predeploy-guard.mjs")
const SITE = path.resolve(WORKER, "..", "site")

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

/** The repo's real layout in miniature: djzs-trust-mcp/scripts/predeploy-guard.mjs and site/, committed and pushed. */
function siteWorld() {
  const w = world()
  mkdirSync(path.join(w.work, "djzs-trust-mcp", "scripts"), { recursive: true })
  copyFileSync(GUARD, path.join(w.work, "djzs-trust-mcp", "scripts", "predeploy-guard.mjs"))
  mkdirSync(path.join(w.work, "site"))
  writeFileSync(path.join(w.work, "site", "index.html"), "<h1>one</h1>\n")
  git(w.work, "add", "-A")
  git(w.work, "commit", "-m", "site + guard")
  git(w.work, "push", "origin", "main")
  return { ...w, site: path.join(w.work, "site") }
}
const SITE_TOML = readFileSync(path.join(SITE, "wrangler.toml"), "utf8")
const SITE_COMMAND = /^\[build\]\s*\ncommand\s*=\s*"([^"\n]+)"/m.exec(SITE_TOML)?.[1] ?? ""
/** Run the command the site's wrangler.toml declares, as wrangler does: a shell, in the directory it was invoked from. */
function siteHook(w, extraEnv = {}, cwd = w.site) {
  const r = spawnSync(SITE_COMMAND || "false", { shell: true, cwd, encoding: "utf8", env: { ...CLEAN_ENV, WRANGLER_COMMAND: "deploy", ...extraEnv } })
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

  console.log("2b. the site deploy (site/) is guarded too: production /try came from one uncommitted tree holding BOTH the page and the Worker")
  {
    check("site/wrangler.toml declares the guard as its [build] command", SITE_COMMAND === "node ../djzs-trust-mcp/scripts/predeploy-guard.mjs", SITE_COMMAND || "no [build] command found")
    check("that command resolves to the real script from site/ (the path is not dead)", existsSync(path.resolve(SITE, "..", "djzs-trust-mcp", "scripts", "predeploy-guard.mjs")))
    check("site/ stays assets-only, and .assetsignore keeps wrangler.toml (the hook config) out of the public bundle", !/^main\s*=/m.test(SITE_TOML) && /^\[assets\]/m.test(SITE_TOML) && readFileSync(path.join(SITE, ".assetsignore"), "utf8").split("\n").includes("wrangler.toml"))

    const clean = siteWorld()
    const ok = siteHook(clean)
    check("clean tree, HEAD == origin/main: the site hook passes", ok.status === 0 && /OK: tree clean, HEAD [0-9a-f]{12} == origin\/main/.test(ok.out), `${ok.status} ${ok.out}`)

    const edited = siteWorld()
    writeFileSync(path.join(edited.site, "index.html"), "<h1>edited, not committed</h1>\n")
    const e = siteHook(edited)
    check("an edited site file: refused, and it names the file", e.status === 1 && /REFUSED/.test(e.out) && /working tree is dirty/.test(e.out) && /site\/index\.html/.test(e.out), `${e.status} ${e.out}`)

    const added = siteWorld()
    writeFileSync(path.join(added.site, "try.html"), "<h1>never added</h1>\n")
    const a = siteHook(added)
    check("a NEW untracked site file (the /try page of 2026-09-28): refused, and it names the file", a.status === 1 && /dirty/.test(a.out) && /site\/try\.html/.test(a.out), `${a.status} ${a.out}`)

    const other = siteWorld()
    writeFileSync(path.join(other.work, "djzs-trust-mcp", "a.txt"), "worker edit\n")
    const o = siteHook(other)
    check("a dirty djzs-trust-mcp/ blocks the SITE deploy too (one tree, one verdict)", o.status === 1 && /dirty/.test(o.out) && /djzs-trust-mcp\/a\.txt/.test(o.out), `${o.status} ${o.out}`)

    const ahead = siteWorld()
    writeFileSync(path.join(ahead.site, "index.html"), "<h1>committed, unpushed</h1>\n")
    git(ahead.work, "add", "-A")
    git(ahead.work, "commit", "-m", "unpushed")
    const ah = siteHook(ahead)
    check("site HEAD ahead of origin/main (committed, never pushed): refused", ah.status === 1 && /is not origin\/main/.test(ah.out) && !/dirty/.test(ah.out), `${ah.status} ${ah.out}`)

    const dev = siteHook(edited, { WRANGLER_COMMAND: "dev" })
    check("`wrangler dev` in site/ stands down on a dirty tree", dev.status === 0, `${dev.status} ${dev.out}`)
    const bo = siteHook(edited, { DJZS_BUILD_ONLY: "1" })
    check("DJZS_BUILD_ONLY=1 stands down, loudly (the dry-run opt-out works for the site too)", bo.status === 0 && /Never set this on a real deploy/.test(bo.out), `${bo.status} ${bo.out}`)

    const wrongDir = siteHook(clean, {}, clean.work)
    check("run from the wrong directory (the repo root) the command cannot run: non-zero, so wrangler would abort. It fails closed", wrongDir.status !== 0, `${wrongDir.status} ${wrongDir.out}`)
  }

  console.log("2c. assets-only deploys: what wrangler would UPLOAD is what is checked (the 2026-10-21 review: gitignored files, and the untracked build_og.py)")
  {
    const REAL_IGNORE = readFileSync(path.join(SITE, ".assetsignore"), "utf8")
    /** siteWorld plus the real site/wrangler.toml and the real site/.assetsignore, and a .gitignore that also hides a scratch file. */
    const assetsWorld = (assetsignore = REAL_IGNORE) => {
      const w = siteWorld()
      writeFileSync(path.join(w.site, "wrangler.toml"), SITE_TOML)
      writeFileSync(path.join(w.site, ".assetsignore"), assetsignore)
      writeFileSync(path.join(w.work, ".gitignore"), ".dev.vars\nnode_modules\n.env\n.DS_Store\nsecret-notes.txt\n")
      git(w.work, "add", "-A")
      git(w.work, "commit", "-m", "assets config")
      git(w.work, "push", "origin", "main")
      return w
    }
    check("the real site/.assetsignore excludes the junk and secrets names added in this change (and still wrangler.toml, .wrangler, build_og.py)", ["wrangler.toml", ".wrangler", "build_og.py", ".env", ".env.*", ".dev.vars", ".DS_Store", "node_modules", "*.log", "*.bak", "*.bak.*"].every((l) => REAL_IGNORE.split("\n").includes(l)), REAL_IGNORE)

    const clean = assetsWorld()
    check("assets mode, clean: the site hook passes", siteHook(clean).status === 0, siteHook(clean).out)

    // (b) a gitignored file wrangler would upload while `git status` reads clean
    const leak = assetsWorld()
    writeFileSync(path.join(leak.site, "secret-notes.txt"), "not for the internet\n")
    const l = siteHook(leak)
    check("a gitignored file under site/ that .assetsignore does NOT exclude is REFUSED, named, and described as an upload", l.status === 1 && /would be UPLOADED/.test(l.out) && /site\/secret-notes\.txt/.test(l.out) && !/working tree is dirty/.test(l.out), `${l.status} ${l.out}`)
    check("…git status itself reads clean (that is why the guard has to look)", git(leak.work, "status", "--porcelain", "--untracked-files=all") === "")
    writeFileSync(path.join(leak.site, ".assetsignore"), REAL_IGNORE + "secret-notes.txt\n")
    git(leak.work, "add", "-A"); git(leak.work, "commit", "-m", "exclude it"); git(leak.work, "push", "origin", "main")
    check("…once .assetsignore excludes it, the same file passes (it can no longer ship)", siteHook(leak).status === 0, siteHook(leak).out)

    // the names the real .assetsignore now excludes can sit there without blocking or shipping
    const junk = assetsWorld()
    writeFileSync(path.join(junk.site, ".DS_Store"), "x")
    writeFileSync(path.join(junk.site, ".env"), "PLACEHOLDER=1\n")
    mkdirSync(path.join(junk.site, "node_modules", "x"), { recursive: true })
    writeFileSync(path.join(junk.site, "node_modules", "x", "index.js"), "1\n")
    check("gitignored .DS_Store, .env and node_modules that .assetsignore excludes: pass (they cannot ship)", siteHook(junk).status === 0, siteHook(junk).out)

    // (a) the untracked scratch file next to the pages
    const scratch = assetsWorld()
    writeFileSync(path.join(scratch.site, "build_og.py"), "print('scratch')\n")
    check("an UNTRACKED site/build_og.py (excluded by .assetsignore) does not block a site deploy", siteHook(scratch).status === 0, siteHook(scratch).out)
    const fromWorker = spawnSync("node", [GUARD], { cwd: scratch.cwd, encoding: "utf8", env: { ...CLEAN_ENV, WRANGLER_COMMAND: "deploy" } })
    check("…nor a WORKER deploy (run from djzs-trust-mcp/): no assets directory there, but the repo's assets config still says the file cannot ship", fromWorker.status === 0, `${fromWorker.status} ${fromWorker.stdout}${fromWorker.stderr}`)

    // what must still block
    const added = assetsWorld()
    writeFileSync(path.join(added.site, "try2.html"), "<h1>never added</h1>\n")
    const ad = siteHook(added)
    check("an untracked page that is NOT excluded still blocks, named", ad.status === 1 && /dirty/.test(ad.out) && /site\/try2\.html/.test(ad.out), `${ad.status} ${ad.out}`)
    const both = assetsWorld()
    writeFileSync(path.join(both.site, "build_og.py"), "x\n")
    writeFileSync(path.join(both.site, "try2.html"), "<h1>x</h1>\n")
    const bo2 = siteHook(both)
    check("with both present only the real page is listed (the scratch file is not counted)", bo2.status === 1 && /1 path\(s\)/.test(bo2.out) && /try2\.html/.test(bo2.out) && !/build_og/.test(bo2.out), `${bo2.status} ${bo2.out}`)
    const tomlEdit = assetsWorld()
    writeFileSync(path.join(tomlEdit.site, "wrangler.toml"), SITE_TOML + "\n# edited, not committed\n")
    const te = siteHook(tomlEdit)
    check("a MODIFIED tracked file still counts even when .assetsignore excludes its name (wrangler.toml changes what a deploy does)", te.status === 1 && /dirty/.test(te.out) && /site\/wrangler\.toml/.test(te.out), `${te.status} ${te.out}`)
    const negated = assetsWorld(REAL_IGNORE + "!keep.txt\n")
    writeFileSync(path.join(negated.site, "build_og.py"), "x\n")
    const ng = siteHook(negated)
    check("an .assetsignore with a negation line is not honoured (fail closed): nothing is assumed excluded, so build_og.py blocks", ng.status === 1 && /build_og\.py/.test(ng.out), `${ng.status} ${ng.out}`)
    const globbed = assetsWorld()
    writeFileSync(path.join(globbed.site, "debug.log"), "x\n")
    writeFileSync(path.join(globbed.site, "index.html.bak.2"), "x\n")
    check("glob entries work: an untracked debug.log and index.html.bak.2 (*.log, *.bak.*) do not block", siteHook(globbed).status === 0, siteHook(globbed).out)
    const nested = assetsWorld()
    mkdirSync(path.join(nested.site, "assets", "deep"), { recursive: true })
    writeFileSync(path.join(nested.site, "assets", "deep", "build_og.py"), "x\n")
    check("a bare name matches at any depth, as in gitignore (site/assets/deep/build_og.py)", siteHook(nested).status === 0, siteHook(nested).out)
    const worker = assetsWorld()
    writeFileSync(path.join(worker.site, "secret-notes.txt"), "x\n")
    const wk = spawnSync("node", [GUARD], { cwd: worker.cwd, encoding: "utf8", env: { ...CLEAN_ENV, WRANGLER_COMMAND: "deploy" } })
    check("a gitignored file under site/ does NOT block a WORKER deploy (it never goes into the Worker bundle)", wk.status === 0, `${wk.status} ${wk.stdout}${wk.stderr}`)
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
