/**
 * Skills over MCP, offline: the compiled-in skill bundle cannot drift from skills/ on disk, and the frontmatter
 * this server publishes is what a YAML parser reads from the same SKILL.md.
 *
 *   1. src/skills-bundle.generated.ts equals a fresh render from skills/ (edit a SKILL.md without regenerating
 *      and this fails, instead of shipping new bytes under an old digest).
 *   2. Every file's digest and size are the bytes on disk.
 *   3. The frontmatter subset parser agrees with the `yaml` package when it is installed (it is a transitive
 *      dependency today; the check is skipped, not failed, if it ever is not).
 *   4. The parser refuses what it cannot read faithfully (typed plain scalars, colons, deeper nesting).
 *
 * Run from djzs-trust-mcp/:   npx tsx test/skills-over-mcp.test.mjs
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildBundle, renderModule, parseFrontmatter, OUT_FILE, SKILLS_ROOT, SERVED_SKILLS } from "../scripts/build-skills-bundle.mjs"

let checks = 0
const failures = []
function check(name, cond, detail) {
  checks++
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.error(`  FAIL ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`) }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

const skills = buildBundle()
check("committed skills-bundle.generated.ts matches skills/ on disk", readFileSync(OUT_FILE, "utf8") === renderModule(skills), "run: node scripts/build-skills-bundle.mjs")
check("served set is exactly the SERVED_SKILLS list", JSON.stringify(skills.map((s) => s.name)) === JSON.stringify(SERVED_SKILLS))
for (const s of skills) {
  check(`${s.name}: SKILL.md is first and is the skill URI`, s.files[0].path === "SKILL.md" && s.uri === s.files[0].uri)
  for (const f of s.files) {
    const bytes = readFileSync(path.join(SKILLS_ROOT, s.name, f.path))
    check(`${s.name}/${f.path}: digest and size are the bytes on disk`, f.sha256 === createHash("sha256").update(bytes).digest("hex") && f.size === bytes.length)
  }
  let yaml = null
  try { yaml = await import("yaml") } catch { /* not installed: skip the cross-check */ }
  if (yaml) {
    const text = s.files[0].text
    const raw = text.slice(4, text.indexOf("\n---\n", 4))
    check(`${s.name}: frontmatter equals the yaml package's reading`, JSON.stringify(s.frontmatter) === JSON.stringify(yaml.parse(raw)), JSON.stringify(yaml.parse(raw)))
  } else {
    console.log(`  skip ${s.name}: yaml package not installed, cross-check skipped`)
  }
}

check("parser refuses a plain value YAML would type", throws(() => parseFrontmatter("---\nname: x\nversion: 1.0\n---\n")))
check("parser refuses a plain value with ': '", throws(() => parseFrontmatter("---\nname: x\ndescription: a: b\n---\n")))
check("parser refuses nesting deeper than one level", throws(() => parseFrontmatter("---\nmetadata:\n  a:\n    b: c\n---\n")))
check("parser reads quoted values and one nested map", JSON.stringify(parseFrontmatter("---\nname: x\nmetadata:\n  version: \"1.0.0\"\n  who: 'it''s'\n---\n")) === JSON.stringify({ name: "x", metadata: { version: "1.0.0", who: "it's" } }))

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length) { console.error(`SKILLS: FAIL (${failures.length})`); process.exit(1) }
console.log("SKILLS: PASS")
