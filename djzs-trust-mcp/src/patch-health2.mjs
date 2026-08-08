// Follow-up patcher: (op4) retire EVERY remaining "0x7010B0E6" literal -> "0x41c2304b"
// (the first patcher's exactly-one guard correctly left comparison sites alone);
// (op5) classifier returns "ok" on empty input so a clean read stops printing "rpc error: ".
import { readFileSync, writeFileSync } from "node:fs";
const FILE = "./index.ts";
let src = readFileSync(FILE, "utf8");
let changed = false;

const n4 = src.split('"0x7010B0E6"').length - 1;
if (n4 > 0) { src = src.split('"0x7010B0E6"').join('"0x41c2304b"'); changed = true; console.log(`op4 stale literal: replaced ${n4} remaining site(s)`); }
else console.log("op4 stale literal: none remain");

const T_LINE = 'const t = String(s ?? "")';
const GUARD = 'const t = String(s ?? "")\n  if (!t) return "ok"';
if (src.includes('if (!t) return "ok"')) console.log("op5 empty guard: already present");
else if (src.split(T_LINE).length - 1 === 1) { src = src.replace(T_LINE, GUARD); changed = true; console.log("op5 empty guard: installed"); }
else console.error("op5 empty guard: anchor not unique; untouched");

if (changed) { writeFileSync(FILE, src); console.log("written ->", FILE); }
else console.log("no changes written");
