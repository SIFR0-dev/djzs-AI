import { readFileSync } from "fs";
import type { CalibrationDataset } from "./dataset.schema";

interface Prediction { id: string; verdict: "PASS" | "WAIT" | "FAIL"; flags: { code: string }[]; risk_score: number; }

const stopped = (v: Prediction["verdict"]) => v === "FAIL" || v === "WAIT";

export function score(dataset: CalibrationDataset, preds: Prediction[]) {
  const byId = new Map(preds.map(p => [p.id, p]));
  const cases = dataset.cases.filter(c => c.reviewed && (c as any).scope === "coded_v0.1");
  const skipped = dataset.cases.length - cases.length;

  const blocks = cases.filter(c => c.label === "block");
  const execs  = cases.filter(c => c.label === "execute");

  let caught = 0; const missed: string[] = []; let waitedOnBlock = 0;
  for (const c of blocks) {
    const p = byId.get(c.id);
    if (!p) { missed.push(c.id + " (no prediction)"); continue; }
    if (stopped(p.verdict)) { caught++; if (p.verdict === "WAIT") waitedOnBlock++; }
    else missed.push(c.id);
  }

  const wrongBlock: string[] = []; let waitedOnExec = 0;
  for (const c of execs) {
    const p = byId.get(c.id);
    if (!p) continue;
    if (p.verdict === "FAIL") wrongBlock.push(c.id);
    else if (p.verdict === "WAIT") waitedOnExec++;
  }

  const recall = blocks.length ? caught / blocks.length : 0;
  const falseBlock = execs.length ? wrongBlock.length / execs.length : 0;

  let codeHits = 0, codeTotal = 0;
  for (const c of blocks) {
    const ec = (c as any).expected_codes as string[] | undefined;
    if (!ec?.length) continue;
    const p = byId.get(c.id); if (!p) continue;
    const got = new Set(p.flags.map(f => f.code));
    for (const code of ec) { codeTotal++; if (got.has(code)) codeHits++; }
  }

  const report = {
    scored: cases.length, skipped_unreviewed: skipped,
    recall: +(recall * 100).toFixed(1),
    false_block_rate: +(falseBlock * 100).toFixed(1),
    missed_rogue: missed,
    wrongly_blocked_legit: wrongBlock,
    wait_on_block: waitedOnBlock, wait_on_execute: waitedOnExec,
    per_code_trip_accuracy: codeTotal ? +((codeHits / codeTotal) * 100).toFixed(1) : null,
  };
  return { report, anyRogueSlipped: missed.length > 0 };
}

if (process.argv[2]) {
  const ds: CalibrationDataset = JSON.parse(readFileSync(process.argv[3] ?? "server/engine-v2/calibration/dataset.json", "utf8"));
  const preds: Prediction[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { report, anyRogueSlipped } = score(ds, preds);
  console.log(JSON.stringify(report, null, 2));
  if (report.scored === 0) { console.error("\nNO REVIEWED coded_v0.1 CASES."); process.exit(2); }
  if (anyRogueSlipped) { console.error("\nFAIL: a rogue intent slipped to PASS."); process.exit(1); }
}
