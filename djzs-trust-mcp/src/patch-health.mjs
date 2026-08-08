// Surgical patcher for src/index.ts health route: (1) stale prefix -> writer-2,
// (2) install classifyRpcError helper, (3) route raw auth.detail through it.
// Substring anchors, whitespace-independent, idempotent, backup once, per-op report.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
const FILE = "./index.ts";
const BAK = FILE + ".bak-pre-health";
let src = readFileSync(FILE, "utf8");
if (!existsSync(BAK)) { copyFileSync(FILE, BAK); console.log("backup ->", BAK); }
let changed = false;

const OLD_PFX = 'expected_writer_prefix: "0x7010B0E6"';
const NEW_PFX = 'expected_writer_prefix: "0x41c2304b"';
const n1 = src.split(OLD_PFX).length - 1;
if (n1 === 1) { src = src.replace(OLD_PFX, NEW_PFX); changed = true; console.log("op1 prefix: patched -> 0x41c2304b"); }
else if (src.includes(NEW_PFX)) console.log("op1 prefix: already patched");
else console.error(`op1 prefix: expected 1 site, found ${n1}; untouched`);

const HELPER = `// Public error hygiene: /health/writer must never echo raw transport errors.
// Known classes map to fixed strings; unknowns get URLs stripped to host and
// user@host tokens removed, hard-capped. Raw messages can carry the RPC URL
// (which embeds the API key) or pasted terminal content - both have happened.
const classifyRpcError = (s: unknown): string => {
  const t = String(s ?? "")
  if (/rate limit|429/i.test(t)) return "rpc error: over rate limit"
  if (/invalid url/i.test(t)) return "config error: BASE_RPC_URL malformed"
  if (/timeout|timed out/i.test(t)) return "rpc error: timeout"
  if (/401|403|unauthorized|authenticated/i.test(t)) return "rpc error: auth rejected by provider"
  if (/nonce/i.test(t)) return "rpc error: nonce conflict"
  const scrubbed = t
    .replace(/(https?:\\/\\/[^\\/\\s"']+)[^\\s"']*/g, "$1/[redacted]")
    .replace(/\\S+@\\S+/g, "[redacted]")
    .slice(0, 80)
  return "rpc error: " + scrubbed
}

`;
const ROUTE_ANCHOR = 'app.get("/health/writer"';
if (src.includes("classifyRpcError")) console.log("op2 helper: already present");
else {
  const i = src.indexOf(ROUTE_ANCHOR);
  if (i < 0) console.error("op2 helper: route anchor missing; untouched");
  else { src = src.slice(0, i) + HELPER + src.slice(i); changed = true; console.log("op2 helper: installed above the route"); }
}

const OLD_ECHO = "authorization_detail: auth.detail,";
const NEW_ECHO = "authorization_detail: classifyRpcError(auth.detail),";
const n3 = src.split(OLD_ECHO).length - 1;
if (n3 === 1) { src = src.replace(OLD_ECHO, NEW_ECHO); changed = true; console.log("op3 echo: detail now routed through classifier"); }
else if (src.includes(NEW_ECHO)) console.log("op3 echo: already patched");
else console.error(`op3 echo: expected 1 site, found ${n3}; untouched`);

if (changed) { writeFileSync(FILE, src); console.log("written ->", FILE); }
else console.log("no changes written");
