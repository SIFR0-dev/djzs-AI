/**
 * The home page's sample ideas. site/index.html carries a small set, each with the answer the live free
 * check (/try/verdict) gave for that exact text. Offline: no network, no key, no model.
 *
 * A recorded answer on a public page is a claim about the engine, so this pins it to the text beside it:
 *   - intent_sha256 is the sha256 of renderIntentText({ thesis }) for the text shown, so an answer cannot
 *     sit next to a text it was not given for;
 *   - verdict_hash recomputes from the verdict, score, codes and unknown fields recorded with it, so the
 *     stamp, the score and the reasons on the page are the ones the engine hashed;
 *   - each fired code carries the live taxonomy's name and severity, the score is the sum of their weights,
 *     and the verdict is what the engine's rule gives for them;
 *   - the ruleset is the one the routes serve today. A ruleset change fails here on purpose: the answers
 *     were given under the old one and have to be recorded again;
 *   - every button has an example and every example a button.
 *
 * To record one: POST { kind, anon, intent: { thesis } } to https://mcp.djzs.ai/try/verdict twice, keep it
 * only if both answers carry the same verdict_hash, paste the answer unchanged, and move `closes`.
 *
 * Run: npx tsx test/site-examples.test.mjs
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { intentSha256 } from "../src/engine-adapter.ts"
import { PM_RESOURCE, PERP_RESOURCE } from "../src/http-x402-bazaar.v2.ts"
import { canonicalize, sha256Hex } from "../../shared/hash.ts"
import { LOGIC_FAILURE_TAXONOMY } from "../../shared/audit-schema.ts"
import { PM_TAXONOMY, PM_FAIL_THRESHOLD } from "../../shared/pm-taxonomy.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}

// The perp failing line lives in the engine as a module constant; the page restates it as LINE.perp.
const PERP_FAIL_THRESHOLD = 50
const DAY = /^\d{4}-\d{2}-\d{2}$/

const html = readFileSync(fileURLToPath(new URL("../../site/index.html", import.meta.url)), "utf8")
const block = /<script type="application\/json" id="examples-data">\n([\s\S]*?)\n<\/script>/.exec(html)
check(1, "the page carries one examples-data block", block !== null)

let data = null
try { data = JSON.parse(block[1]) } catch { /* reported by check 2 */ }
check(2, "the block parses, with a checked day, a closes day and a list", data !== null && DAY.test(data.checked) && DAY.test(data.closes) && Array.isArray(data.examples) && data.examples.length > 0)

const examples = data?.examples ?? []
const buttons = [...html.matchAll(/<button type="button" class="btn" data-ex="([a-z0-9-]+)"/g)].map((m) => m[1])
check(3, "every button has an example and every example a button, in the same order", buttons.length > 0 && buttons.join() === examples.map((e) => e.id).join(), `buttons ${buttons.join()} vs examples ${examples.map((e) => e.id).join()}`)
check(4, "ids are unique", new Set(examples.map((e) => e.id)).size === examples.length)

for (const ex of examples) {
  const b = ex.body ?? {}
  const tag = `[${ex.id}]`
  const bytes = new TextEncoder().encode(ex.thesis ?? "").length
  check(10, `${tag} kind is pm or perp and the answer is for that kind`, (ex.kind === "pm" || ex.kind === "perp") && b.kind === ex.kind)
  check(11, `${tag} the text is one the box would send: 40 characters or more, within 4096 bytes, no [brackets]`, typeof ex.thesis === "string" && ex.thesis.trim() === ex.thesis && ex.thesis.length >= 40 && bytes <= 4096 && !/\[[^\]\n]{1,80}\]/.test(ex.thesis))
  check(12, `${tag} names where the market is`, typeof ex.where === "string" && ex.where.length > 0 && (ex.url === undefined || /^https:\/\//.test(ex.url)))

  // The answer belongs to this text.
  check(13, `${tag} intent_sha256 is the hash of this exact text`, intentSha256({ thesis: ex.thesis }) === b.intent_sha256, `recomputed ${intentSha256({ thesis: ex.thesis })}`)

  // The answer is internally the one the engine hashed.
  const detail = Array.isArray(b.flags_detail) ? b.flags_detail : []
  const unknown = Array.isArray(b.unknown_fields) ? b.unknown_fields : []
  const codes = detail.map((f) => f.code)
  const recomputed = sha256Hex(canonicalize({ verdict: b.verdict, risk_score: b.risk_score, flags: [...codes].sort(), unknown_fields: unknown }))
  check(14, `${tag} verdict_hash recomputes from the verdict, score, codes and unknown fields shown`, recomputed === b.verdict_hash, `recomputed ${recomputed}`)
  check(15, `${tag} flags on the wire are the codes, then unknown:<field>`, JSON.stringify(b.flags) === JSON.stringify([...codes, ...unknown.map((u) => `unknown:${u}`)]))

  // The codes are live ones, named and weighted as the taxonomy has them today.
  const taxonomy = ex.kind === "pm" ? PM_TAXONOMY : LOGIC_FAILURE_TAXONOMY
  const defs = detail.map((f) => taxonomy[f.code])
  check(16, `${tag} every code is in the ${ex.kind} taxonomy with the recorded name and severity`, defs.every((d, i) => d && d.name === detail[i].name && d.severity === detail[i].severity))
  const sum = defs.reduce((n, d) => n + (d?.weight ?? NaN), 0)
  check(17, `${tag} the score is the sum of the fired codes' weights`, sum === b.risk_score, `sum ${sum}, recorded ${b.risk_score}`)
  const line = ex.kind === "pm" ? PM_FAIL_THRESHOLD : PERP_FAIL_THRESHOLD
  const mustFail = defs.some((d) => d?.severity === "CRITICAL") || sum >= line
  check(18, `${tag} the verdict is the engine's for those codes: FAIL exactly when a critical fired or the score reaches ${line}`, ["PASS", "WAIT", "FAIL"].includes(b.verdict) && (b.verdict === "FAIL") === mustFail)
  check(19, `${tag} a WAIT has something unsettled, and names only fields it left unknown`, (b.verdict !== "WAIT" || unknown.length > 0) && (b.unsettled === undefined || (Array.isArray(b.unsettled) && b.unsettled.every((u) => unknown.includes(u.field)))))

  // Recorded under the ruleset the routes serve now.
  const ruleset = ex.kind === "pm" ? PM_RESOURCE.rulesetVersion : PERP_RESOURCE.rulesetVersion
  check(20, `${tag} recorded under today's ruleset (${ruleset})`, b.ruleset === ruleset, `recorded ${b.ruleset}: record the example again`)
}

// Site copy rule (2026-09-15): no em dash anywhere on the page, the sample text included.
check(30, "no em dash on the home page", !html.includes("—"))

// A warning, not a failure: past `closes` the page stops offering the examples, which is honest, and a red
// build on that day would block unrelated work. It prints on every run until new ones are recorded.
const today = new Date().toISOString().slice(0, 10)
if (data && today > data.closes) console.log(`  WARN the examples closed on ${data.closes}: the home page offers none until new ones are recorded`)
else if (data) console.log(`  note the examples are offered through ${data.closes} (UTC)`)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
