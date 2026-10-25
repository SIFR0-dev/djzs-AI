#!/usr/bin/env node
/**
 * Predeploy guard: refuse to deploy from a dirty tree, or from a HEAD that is not origin/main.
 *
 * WHY. `wrangler deploy` bundles and uploads the WORKING TREE, not a commit. On 2026-09-28 the
 * Worker was deployed from a tree with uncommitted changes (try-route.ts among them) and nothing
 * in the repo could reproduce what served production; finding it again took a source search, a
 * bundle diff and the operator's recollection. A deploy is reproducible only if HEAD is a commit
 * everyone can fetch and the tree equals it.
 *
 * WHERE IT RUNS. wrangler.toml declares it as the [build] command, so wrangler runs it before
 * every `deploy` and `versions upload`, however wrangler was invoked (npm run deploy, npx wrangler
 * deploy, a pasted command). BOTH deployable directories declare it: djzs-trust-mcp/wrangler.toml
 * (`node scripts/predeploy-guard.mjs`) and site/wrangler.toml (`node ../djzs-trust-mcp/scripts/...`).
 * The 2026-09-28 tree that nothing could reproduce held the site's /try page AND the Worker's
 * try-route.ts, so a guard on the Worker alone left half of it open. The check is repo-wide, so
 * either deploy is refused while either directory is dirty. wrangler runs the command in the
 * directory it was invoked from, so each deploy must be run from its own directory; from anywhere
 * else the relative path does not resolve and wrangler aborts (fail closed). wrangler sets WRANGLER_COMMAND for that child; `dev` and `types`
 * build nothing that ships, so the guard stands down for them. Any other value, or none (the
 * script run by hand), is treated as a deploy.
 *
 * WHAT IT CHECKS (all of them, every problem listed, exit 1 if any):
 *   1. `git status --porcelain --untracked-files=all` is empty. Tracked edits AND untracked files
 *      both count (the new file that was never added is exactly the case that happened);
 *      .gitignore'd files (.dev.vars, node_modules) do not.
 *   2. origin's refs/heads/main is read LIVE with `git ls-remote`, not from a local tracking ref
 *      that may be days stale. If origin cannot be reached the guard refuses: it never trusts
 *      what it could not check.
 *   3. HEAD is exactly that commit. By SHA, not by branch name: a detached HEAD or a local branch
 *      at the same commit passes; main one commit ahead (unpushed) or behind (unpulled) does not.
 *
 * ASSETS-ONLY WORKERS (site/). wrangler uploads EVERY file under the assets directory except what its .assetsignore
 *   excludes (gitignore syntax), and `git status` does not list gitignored files. So when the invoking directory's
 *   wrangler.toml has an [assets] block, two more rules apply to that directory: (a) an UNTRACKED file that
 *   .assetsignore excludes cannot ship and does not make the tree dirty (a scratch script beside the pages, like
 *   site/build_og.py, must not block every deploy); (b) a GITIGNORED file that .assetsignore does NOT exclude would
 *   ship (.DS_Store, .env, node_modules) while the tree reads clean, so it is refused. A tracked file that is
 *   modified always counts, even one .assetsignore excludes (wrangler.toml changes what a deploy does). An
 *   .assetsignore this guard cannot read exactly (a negation line) is treated as excluding nothing.
 *
 * DRY RUNS. `wrangler deploy --dry-run` builds and uploads nothing, and CI runs it on pull-request
 * merge commits that are never origin/main. Those invocations set DJZS_BUILD_ONLY=1, which makes
 * the guard stand down loudly. It is a conscious opt-out for a build that cannot ship; do not set
 * it on a real deploy.
 *
 * Reads no secret and prints none: SHAs and path names only.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const TAG = "[predeploy-guard]"
const say = (m) => console.error(`${TAG} ${m}`)

const command = process.env.WRANGLER_COMMAND ?? ""
if (command === "dev" || command === "types") process.exit(0)
if (process.env.DJZS_BUILD_ONLY === "1") {
  say("DJZS_BUILD_ONLY=1: this invocation only builds a bundle (--dry-run); the guard stands down. Never set this on a real deploy.")
  process.exit(0)
}

/** The assets directory of the wrangler.toml in `cwd` (absolute), or null for a Worker that bundles code. */
function assetsRoot(cwd) {
  try {
    const toml = readFileSync(path.join(cwd, "wrangler.toml"), "utf8")
    const at = toml.search(/^\[assets\]/m)
    if (at < 0) return null
    const dir = /^\s*directory\s*=\s*"([^"]+)"/m.exec(toml.slice(at))?.[1]
    return dir ? path.resolve(cwd, dir) : null
  } catch { return null }
}

/**
 * A matcher for the paths .assetsignore excludes: a conservative subset of gitignore syntax (names, `*`, `?`, `**`, a
 * leading `/` to anchor, a trailing `/` for directories, `#` comments). Returns a function over a path relative to the
 * assets directory, or a function that excludes nothing when the file uses syntax this subset cannot honour exactly.
 */
function assetsIgnoreMatcher(root) {
  let lines
  try { lines = readFileSync(path.join(root, ".assetsignore"), "utf8").split(/\r?\n/) } catch { return () => false }
  const rules = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("!") || /\\/.test(line) || /\[|\]/.test(line)) return () => false // negation, escapes, classes: not honoured, so nothing is assumed excluded
    const anchored = line.startsWith("/") || line.replace(/\/$/, "").includes("/")
    const body = line.replace(/^\//, "").replace(/\/$/, "")
    const re = body.split("").map((ch, i, a) => ch === "*" ? (a[i - 1] === "*" ? "" : a[i + 1] === "*" ? ".*" : "[^/]*") : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|]/g, "\\$&")).join("")
    rules.push({ anchored, re: new RegExp(anchored ? `^${re}(/.*)?$` : `^${re}$`) })
  }
  return (rel) => rules.some((r) => (r.anchored ? r.re.test(rel) : rel.split("/").some((seg) => r.re.test(seg))))
}

/** Run git, return trimmed stdout, or throw with git's own message. */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd() // not trim(): the first status line starts with a significant space (" M path")
}

const problems = []
let top = null
try {
  top = git(["rev-parse", "--show-toplevel"], process.cwd())
} catch {
  problems.push("not inside a git work tree, so there is no commit to deploy")
}

let head = null
let remote = null
if (top) {
  try {
    head = git(["rev-parse", "HEAD"], top)
  } catch {
    problems.push("this repository has no HEAD commit")
  }

  // Every assets directory in the repo (tracked wrangler.toml files with an [assets] block). An untracked file that ONE of them
  // excludes cannot ship from any deploy, so it never makes the tree dirty, whichever directory the deploy is run from.
  const cwdRoot = assetsRoot(process.cwd())
  const roots = []
  try {
    for (const f of git(["ls-files", "-z", "--", "wrangler.toml", "*/wrangler.toml"], top).split("\0").filter(Boolean)) {
      const r = assetsRoot(path.dirname(path.join(top, f)))
      if (r) roots.push({ root: r, excluded: assetsIgnoreMatcher(r) })
    }
  } catch { /* no tracked config to read: nothing is treated as excluded */ }
  const relTo = (r, p) => { const rel = path.relative(r, path.join(top, p)); return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/") }
  const untrackedInert = (p) => roots.some(({ root: r, excluded }) => { const rel = relTo(r, p); return rel !== null && excluded(rel) })

  let dirty = ""
  try {
    dirty = git(["status", "--porcelain=v1", "--untracked-files=all"], top)
  } catch (e) {
    problems.push(`could not read the working tree status (${String(e.message).split("\n")[0]})`)
  }
  if (dirty) {
    // An UNTRACKED file that .assetsignore excludes cannot be uploaded: it does not make the tree dirty.
    const lines = dirty.split("\n").filter((l) => !(l.startsWith("?? ") && untrackedInert(l.slice(3).replace(/^"|"$/g, ""))))
    if (lines.length) {
      const shown = lines.slice(0, 10).map((l) => `      ${l}`).join("\n")
      problems.push(`working tree is dirty: ${lines.length} path(s) differ from HEAD or are untracked:\n${shown}${lines.length > 10 ? "\n      ..." : ""}`)
    }
  }

  if (cwdRoot) {
    const excludedHere = assetsIgnoreMatcher(cwdRoot)
    // Gitignored files are invisible to `git status` but are uploaded unless .assetsignore excludes them.
    let ignored = []
    try {
      ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", path.relative(top, cwdRoot) || "."], top).split("\0").filter(Boolean)
    } catch (e) {
      problems.push(`could not list gitignored files under the assets directory (${String(e.message).split("\n")[0]})`)
    }
    const ships = ignored.filter((p) => { const rel = relTo(cwdRoot, p); return rel !== null && !excludedHere(rel) })
    if (ships.length) {
      const shown = ships.slice(0, 10).map((l) => `      ${l}`).join("\n")
      problems.push(`${ships.length} gitignored file(s) under ${path.relative(top, cwdRoot) || "."}/ would be UPLOADED (wrangler ships everything the assets directory holds that .assetsignore does not exclude), while the tree reads clean:\n${shown}${ships.length > 10 ? "\n      ..." : ""}\n      Delete them, or add them to ${path.relative(top, cwdRoot) || "."}/.assetsignore.`)
    }
  }

  try {
    const out = git(["ls-remote", "origin", "refs/heads/main"], top)
    remote = out.split(/\s+/)[0] || null
    if (!remote) problems.push("origin has no refs/heads/main")
  } catch (e) {
    problems.push(`could not read origin/main (${String(e.message).split("\n")[0]}); refusing rather than trusting a stale ref`)
  }

  if (head && remote && head !== remote) {
    problems.push(`HEAD ${head.slice(0, 12)} is not origin/main ${remote.slice(0, 12)}: deploy only the commit that main points at (push it, merge it, or pull it first)`)
  }
}

if (problems.length) {
  say("REFUSED. This would ship a tree nobody can reproduce:")
  for (const p of problems) say(`  - ${p}`)
  say("Fix every item above, then deploy again. (A dry run that uploads nothing: DJZS_BUILD_ONLY=1.)")
  process.exit(1)
}
say(`OK: tree clean, HEAD ${head.slice(0, 12)} == origin/main`)
