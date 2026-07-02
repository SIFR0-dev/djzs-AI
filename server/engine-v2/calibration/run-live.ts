/**
 * FULL LIVE CALIBRATION RUN — all reviewed coded_v0.1 cases through real Claude.
 * ===========================================================================
 * Reads calibration-dataset.json, runs each scoreable case (reviewed + scope
 * coded_v0.1) through LIVE extraction → engine, prints a per-case line, and
 * writes predictions.json for score.ts.
 *
 * Run from repo root:
 *   npx tsx --env-file=.env.test server/engine-v2/calibration/run-live.ts
 * Then score:
 *   npx tsx server/engine-v2/calibration/score.ts \
 *     server/engine-v2/calibration/predictions.json \
 *     server/engine-v2/calibration/calibration-dataset.json
 *
 * This is the FIRST end-to-end number across the whole bench: recall on rogue
 * intents, false-block on legit ones. Extraction is the variable under test;
 * the engine is fixed. Where a verdict is wrong, it's an EXTRACTION miss to
 * tune in the prompt, not an engine change.
 */
import { readFileSync, writeFileSync } from "fs";
import { extractAuditInputConsensus } from "../extraction-layer";
import { runDeterministicAudit } from "../deterministic-engine";

const DIR = "server/engine-v2/calibration";
const DATASET = `${DIR}/calibration-dataset.json`;
const OUT = `${DIR}/predictions.json`;

interface Case {
  id: string; intent: string; label: "block" | "execute";
  expected_codes?: string[]; reviewed: boolean; scope?: string;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("NO ANTHROPIC_API_KEY — run with --env-file=.env.test");
    process.exit(2);
  }
  const ds = JSON.parse(readFileSync(DATASET, "utf8")) as { cases: Case[] };
  const cases = ds.cases.filter(c => c.reviewed && c.scope === "coded_v0.1");
  console.log(`LIVE calibration — ${cases.length} scoreable cases (reviewed + coded_v0.1)\n` + "=".repeat(70));

  const predictions: { id: string; verdict: string; flags: { code: string }[]; risk_score: number }[] = [];
  let okCount = 0;

  for (const c of cases) {
    try {
      const { input, disagreements } = await extractAuditInputConsensus(c.intent); // live, N=3 consensus
      const r = runDeterministicAudit(input);
      predictions.push({ id: c.id, verdict: r.verdict, flags: r.flags.map(f => ({ code: f.code })), risk_score: r.risk_score });

      // a "block" case is correct if it stopped (FAIL or WAIT); "execute" is correct if PASS
      const stopped = r.verdict === "FAIL" || r.verdict === "WAIT";
      const correct = c.label === "block" ? stopped : r.verdict === "PASS";
      if (correct) okCount++;
      const codes = r.flags.map(f => f.code).join(",") || "—";
      console.log(`${correct ? "OK " : "XX "} [${c.id}] ${c.label.padEnd(7)} → ${r.verdict.padEnd(4)} ${codes}${correct ? "" : `  (expected ${c.label})`}${disagreements.length ? ` [disagree: ${disagreements.join(", ")}]` : ""}`);
    } catch (e: any) {
      console.log(`ERR [${c.id}] extraction/engine failed: ${e?.message ?? e}`);
      predictions.push({ id: c.id, verdict: "ERROR", flags: [], risk_score: 0 });
    }
  }

  writeFileSync(OUT, JSON.stringify(predictions, null, 2));
  console.log("=".repeat(70));
  console.log(`Raw: ${okCount}/${cases.length} verdicts matched label. predictions.json written.`);
  console.log(`Now score: npx tsx ${DIR}/score.ts ${OUT} ${DATASET}`);
}
main();
