/**
 * ANCHOR: pm-block-008 hash-parity instrument.
 * Reproduces the first-external-audit verdict_hash (CLAUDE.md:91) via
 * live extraction into the frozen engine, or reports the divergence.
 * Run from repo root:
 *   npx tsx --env-file=.env.test server/engine-v2/calibration/anchor-pm-block-008.ts
 * Exit: 0 parity, 1 divergence, 2 setup error.
 */
import { readFileSync } from "fs";
import { extractAuditInputConsensus } from "../extraction-layer";
import { runDeterministicAudit } from "../deterministic-engine";

const EXPECTED = "0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937";
const CASE_ID = "pm-block-008";
const DATASET = "server/engine-v2/calibration/calibration-dataset.json";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("NO ANTHROPIC_API_KEY (run with --env-file=.env.test)");
    process.exit(2);
  }
  const ds = JSON.parse(readFileSync(DATASET, "utf8")) as { cases: { id: string; intent: string }[] };
  const c = ds.cases.find(x => x.id === CASE_ID);
  if (!c) { console.error(`case ${CASE_ID} not found in dataset`); process.exit(2); }

  console.log(`ANCHOR ${CASE_ID}: live extraction into frozen engine`);
  const { input, disagreements } = await extractAuditInputConsensus(c.intent);
  const r: any = runDeterministicAudit(input);

  console.log("disagreements:", JSON.stringify(disagreements));
  console.log("engine result:");
  console.log(JSON.stringify(r, null, 2));

  const got = r.verdict_hash;
  if (!got) {
    console.error("engine result has no verdict_hash field; read the engine return before trusting this script");
    process.exit(2);
  }
  console.log(`expected ${EXPECTED}`);
  console.log(`got      ${got}`);
  console.log(got === EXPECTED ? "PARITY: MATCH" : "PARITY: DIVERGENCE");
  process.exit(got === EXPECTED ? 0 : 1);
}
main();
