import fs from "node:fs";
const P = "src/index.ts";
let s = fs.readFileSync(P, "utf8");
const a1 = "    FACILITATOR_AUTH: createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),";
const a2 = "  CDP_API_KEY_ID?: string";
for (const [a, l] of [[a1, "X402Env literal"], [a2, "Env type"]]) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error(`[patch-mpp-env] REFUSED: "${l}" found ${n} times, need 1`); process.exit(1); }
}
if (s.includes("MPP_SECRET_KEY: env.MPP_SECRET_KEY")) { console.log("[patch-mpp-env] already applied"); process.exit(0); }
s = s.replace(a1, a1 + "\n    MPP_SECRET_KEY: env.MPP_SECRET_KEY,");
s = s.replace(a2, a2 + "\n  MPP_SECRET_KEY?: string");
fs.writeFileSync(P, s);
console.log("[patch-mpp-env] applied");
