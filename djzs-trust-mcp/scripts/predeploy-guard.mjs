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
 * deploy, a pasted command). wrangler sets WRANGLER_COMMAND for that child; `dev` and `types`
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
 * DRY RUNS. `wrangler deploy --dry-run` builds and uploads nothing, and CI runs it on pull-request
 * merge commits that are never origin/main. Those invocations set DJZS_BUILD_ONLY=1, which makes
 * the guard stand down loudly. It is a conscious opt-out for a build that cannot ship; do not set
 * it on a real deploy.
 *
 * Reads no secret and prints none: SHAs and path names only.
 */
import { execFileSync } from "node:child_process"

const TAG = "[predeploy-guard]"
const say = (m) => console.error(`${TAG} ${m}`)

const command = process.env.WRANGLER_COMMAND ?? ""
if (command === "dev" || command === "types") process.exit(0)
if (process.env.DJZS_BUILD_ONLY === "1") {
  say("DJZS_BUILD_ONLY=1: this invocation only builds a bundle (--dry-run); the guard stands down. Never set this on a real deploy.")
  process.exit(0)
}

/** Run git, return trimmed stdout, or throw with git's own message. */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
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

  let dirty = ""
  try {
    dirty = git(["status", "--porcelain=v1", "--untracked-files=all"], top)
  } catch (e) {
    problems.push(`could not read the working tree status (${String(e.message).split("\n")[0]})`)
  }
  if (dirty) {
    const lines = dirty.split("\n")
    const shown = lines.slice(0, 10).map((l) => `      ${l}`).join("\n")
    problems.push(`working tree is dirty: ${lines.length} path(s) differ from HEAD or are untracked:\n${shown}${lines.length > 10 ? "\n      ..." : ""}`)
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
