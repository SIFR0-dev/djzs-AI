// Final health fix: line 467's comparison used a second, LOWERCASE literal that
// two case-sensitive patchers correctly reported as absent. Fix removes the
// literal class entirely: compare against base.expected_writer_prefix, the one
// constant, so prefix and comparison can never diverge again.
import { readFileSync, writeFileSync } from "node:fs";
const FILE = "./index.ts";
const OLD = 'matches_expected_prefix: diag.address.toLowerCase().startsWith("0x7010b0e6")';
const NEW = 'matches_expected_prefix: diag.address.toLowerCase().startsWith(base.expected_writer_prefix.toLowerCase())';
let src = readFileSync(FILE, "utf8");
if (src.includes(NEW)) { console.log("op6: already patched"); process.exit(0); }
const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`op6: expected exactly 1 site, found ${n}; nothing changed`); process.exit(2); }
writeFileSync(FILE, src.replace(OLD, NEW));
console.log("op6: comparison now reads base.expected_writer_prefix — literal class retired");
