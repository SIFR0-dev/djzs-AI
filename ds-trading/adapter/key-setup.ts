// key-setup — interactive credential installer for ws-pin. Run:
//   npx tsx key-setup.ts
// Paste the private key AT THE PROMPT (inside this program): stdin paste
// never executes as shell commands, never lands in shell history, and has
// no clipboard-ordering hazard. The key is validated by an actual WebCrypto
// import before the tool reports success. Files written:
//   ~/kalshi-demo-key.pem (mode 600) and ~/kalshi-demo-key.id
import { createInterface } from "node:readline";
import { writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { importKalshiPrivateKey } from "./kalshi-sign.ts";

const PEM_FILE = `${homedir()}/kalshi-demo-key.pem`;
const ID_FILE = `${homedir()}/kalshi-demo-key.id`;

console.log("== ws-pin key setup ==");
console.log("1) In the Kalshi DEMO console: revoke any burned key, create a new one.");
console.log("2) Copy the PRIVATE KEY block and paste it below (multi-line is fine).");
console.log("   The -----END line is detected automatically.\n");
process.stdout.write("paste private key> ");

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
// The async iterator buffers lines during awaits — nothing pasted is dropped.
const lines: string[] = [];
let keyDone = false;

for await (const raw of rl) {
  const line = raw;
  if (!keyDone) {
    lines.push(line);
    if (!line.includes("-----END")) continue;
    keyDone = true;
    const pem = lines.join("\n").trim() + "\n";
    if (!pem.includes("-----BEGIN")) {
      console.error("\nthat did not start with a -----BEGIN line — start over: npx tsx key-setup.ts");
      process.exit(2);
    }
    try {
      await importKalshiPrivateKey(pem);
    } catch (e) {
      console.error(`\nkey did not import: ${(e as Error).message}`);
      console.error("re-copy the whole block from the console and start over: npx tsx key-setup.ts");
      process.exit(2);
    }
    writeFileSync(PEM_FILE, pem, { mode: 0o600 });
    chmodSync(PEM_FILE, 0o600);
    console.log(`key imports OK -> ${PEM_FILE} (mode 600)`);
    process.stdout.write("\nnow paste the KEY ID (short uuid)> ");
    continue;
  }
  const id = line.trim();
  if (!id) continue;
  if (id.includes("-----") || /\s/.test(id) || id.length > 80) {
    console.error("that does not look like a key id — expected a short uuid. Try again:");
    process.stdout.write("paste the KEY ID> ");
    continue;
  }
  writeFileSync(ID_FILE, id + "\n");
  console.log(`id saved -> ${ID_FILE}`);
  console.log("\nDone. Run the pin:  npx tsx ws-pin.ts");
  process.exit(0);
}

console.error(keyDone ? "\nno key id received — rerun: npx tsx key-setup.ts" : "\nno key received — rerun: npx tsx key-setup.ts");
process.exit(2);
