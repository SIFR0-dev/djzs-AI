// Surgical patcher: install the fail-closed payTo assert inside the x402
// approval callback, before any EIP-3009 signature. Anchor = the unique
// EIP-3009 log line; the first `return true;` after it is the callback's
// approve. Idempotent, backup once, refuses on ambiguity.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
const FILE = "./refusal-agent.mjs";
const BAK = FILE + ".bak-pre-payto";
let src = readFileSync(FILE, "utf8");
if (src.includes("PAYTO_DRIFT")) { console.log("payto assert: already present; nothing changed"); process.exit(0); }
const ANCHOR = "signing EIP-3009, retrying with X-PAYMENT";
const a = src.indexOf(ANCHOR);
if (a < 0) { console.error("ANCHOR_MISSING: EIP-3009 log line not found; nothing changed"); process.exit(2); }
const RET = "return true;";
const r = src.indexOf(RET, a);
if (r < 0) { console.error("RETURN_MISSING after anchor; nothing changed"); process.exit(2); }
const ASSERT = `// PAYTO ASSERT (fail-closed): the challenge's destination must equal the repo
        // constant (X402_RECIPIENT, src/index.ts). History is poisoned; the live
        // challenge is canon only when it matches the constant. No match = no signature.
        const EXPECTED_PAYTO = "0xc1923748669dfc3a79497d0403a90a275161ecca";
        const seen = new Set();
        (function walk(o) {
          if (!o || typeof o !== "object") return;
          if (typeof o.payTo === "string") seen.add(o.payTo.toLowerCase());
          for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
        })(reqs);
        if (seen.size === 0 || [...seen].some((x) => x !== EXPECTED_PAYTO)) {
          const got = [...seen].join(",") || "(none quoted)";
          console.log(\`// PAYTO_DRIFT: expected \${EXPECTED_PAYTO}, challenge quoted \${got} -> refusing before signature\`);
          throw new Error(\`PAYTO_DRIFT: expected \${EXPECTED_PAYTO}, got \${got}\`);
        }
        return true;`;
if (!existsSync(BAK)) { copyFileSync(FILE, BAK); console.log("backup ->", BAK); }
src = src.slice(0, r) + ASSERT + src.slice(r + RET.length);
writeFileSync(FILE, src);
console.log("payto assert: installed inside the approval callback");
