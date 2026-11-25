#!/usr/bin/env node
/**
 * build-skills-bundle.mjs - writes src/skills-bundle.generated.ts from the repo's skills/ directory.
 *
 * WHY A GENERATED MODULE. Skills over MCP (io.modelcontextprotocol/skills) serves each skill file through
 * resources/read and publishes a manifest of every file's SHA-256 digest and byte size; a host refuses any
 * file whose bytes do not match. The Worker bundle has no filesystem, so the bytes have to be compiled in.
 * A generated TypeScript module does that with no wrangler module rule, and the digests are computed here,
 * from the files on disk, so the manifest describes exactly the bytes that are served.
 *
 * ONE SOURCE OF TRUTH. skills/<name>/ in the repo root stays the canonical copy. The CI step
 * (test/skills-over-mcp.test.mjs) regenerates this module in memory and fails if the committed file differs,
 * so an edit to a SKILL.md that is not regenerated cannot ship stale bytes under a stale digest.
 *
 * Usage (from djzs-trust-mcp/):   node scripts/build-skills-bundle.mjs
 * Check only:                      node scripts/build-skills-bundle.mjs --check
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SKILLS_ROOT = path.resolve(HERE, "..", "..", "skills")
export const OUT_FILE = path.resolve(HERE, "..", "src", "skills-bundle.generated.ts")

/**
 * The skills this server publishes. Explicit on purpose: a skill directory added to skills/ is not served
 * until it is listed here. djzs-audit-gate is NOT served: it is the MetaMask Agent Wallet integration, and
 * its v1.0.1 text predates the free check (it still says no free path exists).
 */
export const SERVED_SKILLS = ["djzs-trade-audit"]

/** Agent Skills naming rule: lowercase letters, digits and single hyphens, at most 64 characters. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MIME = { ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json" }
/** Spec limits a server SHOULD NOT exceed per skill. */
const MAX_FILES = 512
const MAX_BYTES = 16 * 1024 * 1024

function walk(dir, rel = "") {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue
    const abs = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    if (statSync(abs).isDirectory()) out.push(...walk(abs, r))
    else out.push(r)
  }
  return out
}

/** A plain YAML scalar this parser will not type: anything YAML 1.2 core would read as a bool, null or number. */
const AMBIGUOUS_PLAIN = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i

function scalar(raw, where) {
  const v = raw.trim()
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new Error(`${where}: unterminated double-quoted string`)
    return JSON.parse(v) // YAML double-quoted escapes are a superset; this parser accepts only the JSON subset
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`${where}: unterminated single-quoted string`)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (v === "") throw new Error(`${where}: empty value (this parser does not read block scalars)`)
  if (/^[\[{&*!|>%@`#]/.test(v) || /: |\s#/.test(v) || v.endsWith(":")) {
    throw new Error(`${where}: plain value needs quoting for this parser: ${v.slice(0, 60)}`)
  }
  if (AMBIGUOUS_PLAIN.test(v)) throw new Error(`${where}: plain value would be typed by YAML, quote it: ${v}`)
  return v
}

/**
 * Frontmatter subset: `key: value` scalars and one level of `key:` maps of scalars, two-space indent.
 * Anything else throws, so a future edit that needs more YAML fails here instead of shipping a frontmatter
 * object that disagrees with what a host's YAML parser reads (the host compares them field by field).
 */
export function parseFrontmatter(text, where = "SKILL.md") {
  if (!text.startsWith("---\n")) throw new Error(`${where}: must begin with a --- frontmatter line`)
  const end = text.indexOf("\n---\n", 4)
  if (end < 0) throw new Error(`${where}: frontmatter is not closed by ---`)
  const lines = text.slice(4, end).split("\n")
  const out = {}
  let parent = null
  for (const [i, line] of lines.entries()) {
    const at = `${where}:${i + 2}`
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    const child = line.match(/^ {2}([A-Za-z0-9_.\/-]+):(?: (.*))?$/)
    if (child) {
      if (!parent) throw new Error(`${at}: indented key with no parent map`)
      if (child[2] === undefined || child[2].trim() === "") throw new Error(`${at}: nested maps deeper than one level are not supported`)
      if (child[1] in out[parent]) throw new Error(`${at}: duplicate key ${parent}.${child[1]}`)
      out[parent][child[1]] = scalar(child[2], at)
      continue
    }
    const top = line.match(/^([A-Za-z0-9_.\/-]+):(?: (.*))?$/)
    if (!top) throw new Error(`${at}: unsupported frontmatter line: ${line.slice(0, 60)}`)
    if (top[1] in out) throw new Error(`${at}: duplicate key ${top[1]}`)
    if (top[2] === undefined || top[2].trim() === "") { out[top[1]] = {}; parent = top[1]; continue }
    out[top[1]] = scalar(top[2], at)
    parent = null
  }
  return out
}

export function buildBundle() {
  const skills = []
  for (const name of SERVED_SKILLS) {
    if (!NAME_RE.test(name) || name.length > 64) throw new Error(`skill name ${name} breaks the Agent Skills naming rule`)
    const dir = path.join(SKILLS_ROOT, name)
    const rels = walk(dir)
    if (!rels.includes("SKILL.md")) throw new Error(`skills/${name}: no SKILL.md`)
    if (rels.length > MAX_FILES) throw new Error(`skills/${name}: ${rels.length} files, over ${MAX_FILES}`)
    let total = 0
    const files = []
    for (const rel of ["SKILL.md", ...rels.filter((r) => r !== "SKILL.md")]) {
      const bytes = readFileSync(path.join(dir, rel))
      const mimeType = MIME[path.extname(rel).toLowerCase()]
      if (!mimeType) throw new Error(`skills/${name}/${rel}: no MIME type for this extension; add one or keep the file out of the skill`)
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) // throws on invalid UTF-8
      if (text.charCodeAt(0) === 0xfeff) throw new Error(`skills/${name}/${rel}: starts with a byte-order mark`)
      if (Buffer.compare(Buffer.from(text, "utf8"), bytes) !== 0) throw new Error(`skills/${name}/${rel}: bytes do not round-trip through UTF-8`)
      total += bytes.length
      files.push({
        uri: `skill://${name}/${rel}`,
        path: rel,
        mimeType,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text,
      })
    }
    if (total > MAX_BYTES) throw new Error(`skills/${name}: ${total} bytes, over ${MAX_BYTES}`)
    const frontmatter = parseFrontmatter(files[0].text, `skills/${name}/SKILL.md`)
    if (frontmatter.name !== name) throw new Error(`skills/${name}/SKILL.md: frontmatter name ${JSON.stringify(frontmatter.name)} must equal the directory name`)
    if (typeof frontmatter.description !== "string" || frontmatter.description.length < 1 || frontmatter.description.length > 1024) {
      throw new Error(`skills/${name}/SKILL.md: description must be 1 to 1024 characters`)
    }
    skills.push({ name, uri: `skill://${name}/SKILL.md`, frontmatter, files })
  }
  return skills
}

export function renderModule(skills) {
  return [
    "// GENERATED by scripts/build-skills-bundle.mjs from the repo's skills/ directory. Do not edit by hand:",
    "// edit skills/<name>/ and run `node scripts/build-skills-bundle.mjs` from djzs-trust-mcp/.",
    "// test/skills-over-mcp.test.mjs fails CI when this file and the skills on disk disagree.",
    "",
    "export interface SkillFile {",
    "  /** skill://<name>/<path>, the resource URI the file is read through. */",
    "  uri: string",
    "  path: string",
    "  mimeType: string",
    "  /** Byte length of the UTF-8 file. */",
    "  size: number",
    "  /** Lowercase hex SHA-256 of the file's bytes. */",
    "  sha256: string",
    "  text: string",
    "}",
    "",
    "export interface SkillEntry {",
    "  name: string",
    "  /** URI of the skill's SKILL.md. */",
    "  uri: string",
    "  /** Every SKILL.md frontmatter field, unchanged. */",
    "  frontmatter: Record<string, unknown>",
    "  /** SKILL.md first, then every supporting file. */",
    "  files: SkillFile[]",
    "}",
    "",
    `export const SKILLS: SkillEntry[] = ${JSON.stringify(skills, null, 2)}`,
    "",
  ].join("\n")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const next = renderModule(buildBundle())
  if (process.argv.includes("--check")) {
    let current = ""
    try { current = readFileSync(OUT_FILE, "utf8") } catch { /* missing counts as stale */ }
    if (current !== next) {
      console.error("skills-bundle.generated.ts is stale: run `node scripts/build-skills-bundle.mjs` from djzs-trust-mcp/")
      process.exit(1)
    }
    console.log("skills-bundle.generated.ts matches skills/ on disk")
  } else {
    writeFileSync(OUT_FILE, next)
    console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)}`)
  }
}
