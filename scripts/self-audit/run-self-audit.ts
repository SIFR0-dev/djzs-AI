/**
 * RETROSPECTIVE SELF-AUDIT PILOT — runner
 * ============================================================
 * ONLY ALLOWED CLAIM:
 *   "DJZS is being tested against the operator's historical
 *    reasoning patterns."
 * NOT a claim of predictive power. Outcomes were known at
 * collection time. This is retrospective, contaminated by
 * design, and suggestive only.
 *
 * It runs each REAL strategy_memo through the calibrated
 * executeAudit path (DJZS-LF v1.1, treasury tier) and compares
 * the verdict to the recorded WIN/LOSS result.
 *
 * Run: export $(cat .env.test) && npx tsx scripts/self-audit/run-self-audit.ts
 * (adjust import paths if your repo resolves them differently)
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { executeAudit } from "../../server/audit-agent";
import * as schema from "../../shared/audit-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Entry {
  id: string;
  title: string;
  strategy_memo: string;
  predicted_outcome_or_action: string;
  actual_outcome: string;
  result: "WIN" | "LOSS" | "PARTIAL" | "INVALID" | "UNKNOWN" | string;
  position_size_or_stakes?: string;
  confidence_at_time?: string;
  thesis_provenance?: string;
  notes?: string;
  _status?: string;
}

// A memo is "real" only if it isn't a placeholder.
function isReal(memo: string): boolean {
  if (!memo) return false;
  const m = memo.trim().toUpperCase();
  if (m.length < 20) return false;
  return !m.startsWith("REQUIRED_FROM_USER") && m !== "UNKNOWN" && m !== "";
}

function prov(name: string, fallback = "unavailable"): string {
  const v = (schema as Record<string, unknown>)[name];
  return typeof v === "string" || typeof v === "number" ? String(v) : fallback;
}

async function main() {
  const data = JSON.parse(
    readFileSync(join(__dirname, "dataset-self-audit.json"), "utf-8")
  ) as { _pilot?: { only_allowed_claim?: string }; entries: Entry[] };

  console.log("=".repeat(64));
  console.log("RETROSPECTIVE SELF-AUDIT PILOT");
  console.log("=".repeat(64));
  console.log("ALLOWED CLAIM: " + (data._pilot?.only_allowed_claim ?? ""));
  console.log("NOT a claim of predictive power. Retrospective, contaminated by design.\n");

  // provenance (read at runtime so it tracks whatever the repo actually exports)
  console.log("PROVENANCE:");
  console.log("  schema_version : " + prov("SCHEMA_VERSION"));
  console.log("  lf_version     : " + prov("DJZS_LF_VERSION"));
  console.log("  weights_hash   : " + prov("WEIGHTS_HASH"));
  console.log("  taxonomy_hash  : " + prov("TAXONOMY_HASH"));

  const all = data.entries || [];
  const ready = all.filter(e => isReal(e.strategy_memo));
  const pending = all.filter(e => !isReal(e.strategy_memo));

  if (ready.length === 0) {
    console.log(`\nNo auditable entries yet — ${pending.length} awaiting real strategy_memo text.`);
    console.log("Fill strategy_memo with your ACTUAL reasoning, then re-run.\n");
    if (pending.length) {
      console.log("AWAITING INPUT:");
      pending.forEach(e => console.log(`  ${e.id}  ${e.title || "(untitled)"}  result=${e.result}`));
    }
    return;
  }

  const caught: Entry[] = [];      // LOSS + FAIL
  const gaps: Entry[] = [];        // LOSS + PASS
  const clean: Entry[] = [];       // WIN + PASS
  const overblocks: Entry[] = [];  // WIN + FAIL
  const other: { e: Entry; verdict: string }[] = [];
  let degraded = 0;

  console.log("\nPER-ENTRY:");
  for (const e of ready) {
    let cert: any = null;
    try {
      cert = await executeAudit({
        strategy_memo: e.strategy_memo,
        audit_type: "general",
        tier: "treasury",
      });
    } catch (err) {
      console.log(`  ${e.id}  AUDIT ERROR — ${(err as Error).message}`);
      continue;
    }
    if (cert?.degraded) degraded++;

    const verdict: string = cert.verdict;
    const risk = cert.risk_score;
    const flags = (cert.flags || []).map((f: any) => f.code).join(", ") || "none";
    const tHash = cert.taxonomy_hash ?? prov("TAXONOMY_HASH");
    const tVer = cert.taxonomy_version ?? prov("DJZS_LF_VERSION");

    let tag = "·";
    if (e.result === "LOSS" && verdict === "FAIL") { caught.push(e); tag = "✓ CAUGHT"; }
    else if (e.result === "LOSS" && verdict === "PASS") { gaps.push(e); tag = "✗ DETECTOR GAP"; }
    else if (e.result === "WIN" && verdict === "PASS") { clean.push(e); tag = "✓ clean"; }
    else if (e.result === "WIN" && verdict === "FAIL") { overblocks.push(e); tag = "! caution/overblock?"; }
    else { other.push({ e, verdict }); tag = `~ ${e.result}`; }

    console.log(`  ${e.id}  result=${String(e.result).padEnd(7)} verdict=${verdict.padEnd(4)} risk=${String(risk).padStart(3)}  ${tag}`);
    console.log(`         flags: ${flags}`);
    console.log(`         taxonomy ${tVer} / ${String(tHash).slice(0, 14)}…${cert?.degraded ? "  [DEGRADED — invalid]" : ""}`);
  }

  // ---- WHAT DJZS CAUGHT / WHAT DJZS MISSED -------------------
  console.log("\n" + "=".repeat(64));
  console.log("WHAT DJZS CAUGHT / WHAT DJZS MISSED");
  console.log("=".repeat(64));

  console.log(`\nCAUGHT (LOSS -> FAIL) — ${caught.length}:`);
  caught.forEach(e => console.log(`  ✓ ${e.id} ${e.title}`));
  if (!caught.length) console.log("  (none)");

  console.log(`\nDETECTOR GAPS (LOSS -> PASS) — ${gaps.length}  << the important column:`);
  gaps.forEach(e => console.log(`  ✗ ${e.id} ${e.title} — DJZS missed a losing thesis`));
  if (!gaps.length) console.log("  (none — no losing thesis slipped through)");

  console.log(`\nPOSSIBLE OVERBLOCKS (WIN -> FAIL) — ${overblocks.length}:`);
  overblocks.forEach(e => console.log(`  ! ${e.id} ${e.title} — flagged a winner (useful caution, or too strict?)`));
  if (!overblocks.length) console.log("  (none)");

  console.log(`\nCLEAN (WIN -> PASS) — ${clean.length}:`);
  clean.forEach(e => console.log(`  ✓ ${e.id} ${e.title}`));
  if (!clean.length) console.log("  (none)");

  if (other.length) {
    console.log(`\nPARTIAL / INVALID / OTHER — ${other.length} (excluded from the 2x2):`);
    other.forEach(o => console.log(`  ~ ${o.e.id} ${o.e.title} result=${o.e.result} verdict=${o.verdict}`));
  }

  // ---- honest read ------------------------------------------
  const n = ready.length;
  const losses = caught.length + gaps.length;
  console.log("\n" + "-".repeat(64));
  console.log("HONEST READ:");
  console.log(`  n=${n} (${losses} losses, ${clean.length + overblocks.length} wins).`);
  if (losses > 0) {
    console.log(`  Of ${losses} losing theses, DJZS would have FAILed ${caught.length} and MISSED ${gaps.length}.`);
  }
  console.log("  This is RETROSPECTIVE and contaminated (outcomes known at collection).");
  console.log("  It does NOT show DJZS predicts outcomes. The only supported claim:");
  console.log("  \"DJZS is being tested against the operator's historical reasoning patterns.\"");
  if (gaps.length) {
    console.log(`\n  ACTION: ${gaps.length} detector gap(s) above are the real finding — a losing`);
    console.log("  thesis DJZS waved through. That is where the taxonomy needs work (e.g. DJZS-M).");
  }
  if (degraded) {
    console.log(`\n  WARNING: ${degraded} audit(s) ran DEGRADED (Claude unavailable) — invalid. Fix key and re-run.`);
  }
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
