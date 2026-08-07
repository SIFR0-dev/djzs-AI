// Surgical patcher for refusal-agent.mjs. Backs up once, replaces shorten()
// by anchor span, refuses on unrecognized body, idempotent. Optional flag
// --residual-240 / --residual-120 sets the residual cap.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
const FILE = "./refusal-agent.mjs";
const BAK = FILE + ".bak-pre-shorten";
const want240 = process.argv.includes("--residual-240");
const want120 = process.argv.includes("--residual-120");

let src = readFileSync(FILE, "utf8");
if (!existsSync(BAK)) { copyFileSync(FILE, BAK); console.log("backup ->", BAK); }

const anchor = "function shorten(s, max = 120) {";
const i = src.indexOf(anchor);
if (i < 0) { console.error("ANCHOR_MISSING: shorten() head not found; nothing changed"); process.exit(2); }
const j = src.indexOf("\n}", i);
if (j < 0) { console.error("SPAN_UNCLOSED; nothing changed"); process.exit(2); }
const span = src.slice(i, j + 2);
const isOld = span.includes('lastIndexOf(" ")') && span.includes('+ "..."');
const isNew = span.includes("matchAll(/[.;!?]");
if (!isOld && !isNew) { console.error("UNRECOGNIZED shorten() body; nothing changed"); process.exit(2); }

const NEW_FN = `function shorten(s, max = 120) {
  // Clamp to complete clauses. Contract: whole clauses only, never an elided
  // fragment, no terminal punctuation (the template supplies it). Boundary =
  // . ; ! ? followed by whitespace; the lookahead keeps decimals intact.
  // Last boundary at or under max; else first boundary past max; else the
  // whole string. Soft cap by design: a long clause ships whole rather than
  // as "against the....".
  const t = squash(s).replace(/[.;\\s]+$/, "");
  if (t.length <= max) return t;
  const bounds = [...t.matchAll(/[.;!?](?=\\s|$)/g)].map((m) => m.index);
  const within = bounds.filter((idx) => idx < max);
  const cutAt = within.length ? within[within.length - 1] : (bounds.length ? bounds[0] : t.length);
  return t.slice(0, cutAt).replace(/[,;:.\\s]+$/, "");
}`;

if (isOld) { src = src.slice(0, i) + NEW_FN + src.slice(j + 2); console.log("shorten(): patched (old body replaced)"); }
else console.log("shorten(): already patched — left as-is");

const capRe = /shorten\(fields\?\.residual \?\? "", (120|240)\)/g;
const hits = [...src.matchAll(capRe)];
if (want240 || want120) {
  if (hits.length !== 1) console.error(`RESIDUAL_CAP: expected exactly 1 site, found ${hits.length}; cap untouched`);
  else {
    const target = want240 ? "240" : "120";
    src = src.replace(capRe, `shorten(fields?.residual ?? "", ${target})`);
    console.log("residual cap ->", target);
  }
}
writeFileSync(FILE, src);
console.log("written ->", FILE);
