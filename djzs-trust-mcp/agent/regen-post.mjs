// regen v3: intents are text (.md). Binds entry.intent_sha256 by deriving the
// wire sha through the agent's own exports across input shapes, then rebuilds
// post_text via buildPostText. Read-only until --write; one entry only.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildPostText, validateIntent, renderWire, sha256 } from "./refusal-agent.mjs";

const seq = Number(process.argv[2] ?? 7);
const write = process.argv.includes("--write");
const raw = JSON.parse(readFileSync("./refusal-log.json", "utf8"));
const arr = Array.isArray(raw) ? raw : raw.entries;
const entry = arr.find((e) => Number(e.seq) === seq);
if (!entry) { console.error(`no entry ${seq}`); process.exit(1); }
const norm = (s) => String(s ?? "").toLowerCase().replace(/^0x/, "");
const target = norm(entry.intent_sha256);
const rawSha = (b) => createHash("sha256").update(b).digest("hex");

function candidates(f, bytes) {
  const out = [];
  const push = (label, fn) => { try { const s = norm(fn()); if (/^[0-9a-f]{64}$/.test(s)) out.push([label, s]); } catch {} };
  const text = bytes.toString("utf8");
  let v = null, vhow = null;
  for (const [h, arg] of [["text", text], ["path", `./intents/${f}`]]) {
    if (!v) { try { const r = validateIntent(arg); if (r && typeof r === "object") { v = r; vhow = h; } } catch {} }
  }
  if (v) {
    push(`renderWire(validated:${vhow})`, () => sha256(renderWire(v)));
    if (v.fields) push("renderWire(fields)", () => sha256(renderWire(v.fields)));
  }
  push("renderWire(text)", () => sha256(renderWire(text)));
  push("sha256(text)", () => sha256(text));
  push("sha256(bytes)", () => rawSha(bytes));
  return { out, v };
}

let fields = null, bound = null, how = null, matched = false;
const report = [];
for (const f of readdirSync("./intents").sort()) {
  const bytes = readFileSync(`./intents/${f}`);
  const { out, v } = candidates(f, bytes);
  for (const [label, s] of out) {
    report.push(`  ${f} :: ${label} -> ${s.slice(0, 8)}`);
    if (!matched && s === target) { matched = true; bound = f; how = label; fields = v?.fields ?? null; }
  }
}
console.log("// derivation table:\n" + report.join("\n"));
if (!matched) { console.error(`NO_BIND: nothing derives ${target.slice(0, 8)} — paste this output whole.`); process.exit(2); }
if (!fields) { console.error(`BOUND intents/${bound} via ${how}, but no fields from validateIntent — paste this output whole.`); process.exit(3); }
console.log(`// intent bound: intents/${bound} via ${how} (${target.slice(0, 8)})`);

const next = buildPostText({ ...entry, fields });
console.log("\n=== OLD ===\n" + entry.post_text);
console.log("\n=== NEW ===\n" + next);
if (write) {
  entry.post_text = next;
  writeFileSync("./refusal-log.json", JSON.stringify(raw, null, 2) + "\n");
  console.log(`\n// written -> refusal-log.json (entry ${String(seq).padStart(3, "0")} only)`);
} else console.log("\n// dry (pass --write to persist)");
