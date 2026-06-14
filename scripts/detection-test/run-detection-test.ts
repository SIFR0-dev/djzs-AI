/**
 * DJZS-LF v1.1 — DETECTION TEST HARNESS
 * ------------------------------------------------------------------
 * Runs 10 hand-built strategy_memo scenarios through the REAL engine
 * (executeAudit) and reports, per scenario:
 *   verdict · risk_score · fired codes · expected codes · hit?
 *
 * WHAT THIS TESTS (be honest about it):
 *   This is a DETECTION sanity-check — does the LLM "sensor" fire the
 *   right DJZS-LF codes on inputs *designed* to contain those flaws?
 *   It is NOT a backtest. It does not establish that FAIL predicts a
 *   real loss. It validates that the detector + the frozen v1.1
 *   scoring behave as intended on known inputs.
 *
 * WHAT MATTERS MOST IN THE OUTPUT:
 *   1. FALSE POSITIVES on the two clean scenarios (#1, #9). If those
 *      FAIL, the detector is trigger-happy and every audit would FAIL
 *      — which would make DJZS useless. This is the single most
 *      important signal here.
 *   2. RECALL on the flawed scenarios — did the expected code fire?
 *
 * NOTE ON DETERMINISM: the SCORING/verdict layer is deterministic and
 * frozen (v1.1). The DETECTION layer is an LLM and is probabilistic,
 * so a "miss" may be model variance, not a bug. Claude at temp=0 is
 * fairly stable; re-run to gauge consistency.
 *
 * RUN:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/detection-test/run-detection-test.ts
 *
 * Runtime: ~10 sequential LLM calls. Costs a few cents.
 */

import { executeAudit } from "../../server/audit-agent";
import { LOGIC_FAILURE_TAXONOMY, ALL_LF_CODES, type LFCode } from "../../shared/audit-schema";

// Map every accepted form -> canonical "DJZS-Xxx"
const CODE_LOOKUP = new Map<string, string>();
for (const code of ALL_LF_CODES) {
  const def = LOGIC_FAILURE_TAXONOMY[code];
  CODE_LOOKUP.set(code.toUpperCase(), code);              // "DJZS-S01"
  CODE_LOOKUP.set(code.replace(/^DJZS-/i, "").toUpperCase(), code); // "S01"
  CODE_LOOKUP.set(def.name.toUpperCase(), code);          // "CIRCULAR_LOGIC"
}
function canonicalizeCode(raw: string): string | null {
  if (!raw) return null;
  return CODE_LOOKUP.get(raw.trim().toUpperCase()) ?? null;
}

function nameOf(code: string): string {
  const canonical = canonicalizeCode(code);
  const def = canonical ? LOGIC_FAILURE_TAXONOMY[canonical as LFCode] : undefined;
  return def ? def.name : "UNKNOWN";
}

interface Scenario {
  id: number;
  name: string;
  memo: string;
  expect_verdict: "PASS" | "FAIL";
  expect_codes: string[]; // canonical "DJZS-Xxx"; empty for clean scenarios
}

const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: "Clean ETH long, bounded risk",
    expect_verdict: "PASS",
    expect_codes: [],
    memo: "Go 5x long ETH at $3,200 with a 2% stop-loss, 4% take-profit, position size limited to 3% of portfolio, and invalidate the trade if ETH loses the 200-day moving average on the 1-hour close.",
  },
  {
    id: 2,
    name: "Unbounded leverage / no stop",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-X01", "DJZS-E02"], // EXECUTION_UNBOUND, CONFIDENCE_INFLATION (FOMO_LOOP possible)
    memo: "Go 20x long ETH at $3,200 because ETH is about to break out. No stop-loss needed because the trend is obvious and I will manually exit if it looks bad.",
  },
  {
    id: 3,
    name: "Circular logic",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-S01"], // CIRCULAR_LOGIC
    memo: "Go 10x long ETH because my analysis says ETH is bullish, and I know the analysis is correct because it confirms ETH is bullish.",
  },
  {
    id: 4,
    name: "Oracle / data unverified",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-E01", "DJZS-I03"], // ORACLE_UNVERIFIED, DATA_UNVERIFIED
    memo: "Go 5x long ETH because a dashboard I found says whales are accumulating, but I do not have the source link, timestamp, exchange breakdown, or verification method.",
  },
  {
    id: 5,
    name: "Stale reference",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-T01"], // STALE_REFERENCE
    memo: "Go 3x long ETH today based on funding rates and RSI data from last month. I assume the same market conditions still apply.",
  },
  {
    id: 6,
    name: "Race condition",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-X02"], // RACE_CONDITION
    memo: "Go 8x long ETH if price crosses $3,200, but execute using a delayed webhook that may trigger several minutes after the candle closes. Do not re-check price, spread, liquidity, or funding before execution.",
  },
  {
    id: 7,
    name: "FOMO / social momentum",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-I01", "DJZS-E02"], // FOMO_LOOP, CONFIDENCE_INFLATION
    memo: "Go 10x long ETH immediately because Crypto Twitter is extremely bullish, influencers are calling for a breakout, and I do not want to miss the move.",
  },
  {
    id: 8,
    name: "Misaligned reward",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-I02"], // MISALIGNED_REWARD
    memo: "Go 5x long ETH mainly because the agent earns a success fee if it opens trades, and higher trade frequency improves its performance score. Risk controls can be loosened to maximize activity.",
  },
  {
    id: 9,
    name: "Clean short with invalidation",
    expect_verdict: "PASS",
    expect_codes: [],
    memo: "Go 4x short ETH at $3,200 only if it rejects resistance on the 4-hour candle, with a 1.5% stop-loss, 3% take-profit, max position size of 2% of portfolio, and cancel the trade if BTC breaks above its prior daily high.",
  },
  {
    id: 10,
    name: "Dependency ghost",
    expect_verdict: "FAIL",
    expect_codes: ["DJZS-S03"], // DEPENDENCY_GHOST
    memo: "Go 6x long ETH because the internal AlphaOracle v3 signal confirms a high-probability breakout, but AlphaOracle v3 is not currently reachable and no fallback source is available.",
  },
];

interface Row {
  id: number;
  name: string;
  verdict: string;
  risk: number;
  fired: string[];
  expected: string[];
  verdictMatch: boolean;
  recallHit: boolean | null; // null for clean scenarios
  falsePositive: boolean; // clean scenario that FAILed
}

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\n[ABORT] ANTHROPIC_API_KEY not set. Run:");
    console.error("  ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/detection-test/run-detection-test.ts\n");
    process.exit(1);
  }

  console.log("\n=== DJZS-LF v1.1 DETECTION TEST — 10 scenarios ===");
  console.log("(detection sanity-check, NOT a backtest)\n");

  const rows: Row[] = [];

  for (const s of SCENARIOS) {
    process.stdout.write(`#${s.id} ${s.name} ... `);
    try {
      const cert: any = await executeAudit({
        strategy_memo: s.memo,
        audit_type: "general",
        tier: "treasury", // unlimited memo length + deepest analysis path
      });

      const fired = (cert.flags ?? [])
        .map((f: any) => canonicalizeCode(typeof f === "string" ? f : f.code))
        .filter((c): c is string => c !== null);
      const verdict = String(cert.verdict ?? "UNKNOWN");
      const risk = Number(cert.risk_score ?? -1);

      const verdictMatch = verdict === s.expect_verdict;
      const isClean = s.expect_codes.length === 0;
      const recallHit = isClean
        ? null
        : s.expect_codes.some((c) => fired.includes(c));
      const falsePositive = isClean && verdict === "FAIL";

      rows.push({
        id: s.id, name: s.name, verdict, risk, fired,
        expected: s.expect_codes, verdictMatch, recallHit, falsePositive,
      });
      console.log(`${verdict} (risk ${risk})`);
    } catch (err: any) {
      console.log(`ERROR: ${err?.message ?? err}`);
      rows.push({
        id: s.id, name: s.name, verdict: "ERROR", risk: -1, fired: [],
        expected: s.expect_codes, verdictMatch: false, recallHit: false,
        falsePositive: false,
      });
    }
  }

  // ── matrix
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("RESULTS MATRIX");
  console.log("────────────────────────────────────────────────────────────");
  for (const r of rows) {
    const firedNames = r.fired.length
      ? r.fired.map((c) => `${c}(${nameOf(c)})`).join(", ")
      : "—";
    const expNames = r.expected.length
      ? r.expected.map((c) => `${c}(${nameOf(c)})`).join(", ")
      : "(clean — expect no CRITICAL/HIGH)";
    let mark: string;
    if (r.expected.length === 0) mark = r.falsePositive ? "✗ FALSE POSITIVE" : "✓ clean";
    else mark = r.recallHit ? "✓ hit" : "✗ MISS";

    console.log(`\n#${r.id} ${r.name}`);
    console.log(`   verdict : ${r.verdict} (risk ${r.risk})  [expected ${SCENARIOS[r.id - 1].expect_verdict}] ${r.verdictMatch ? "✓" : "✗"}`);
    console.log(`   fired   : ${firedNames}`);
    console.log(`   expected: ${expNames}`);
    console.log(`   detect  : ${mark}`);
  }

  // ── summary
  const clean = rows.filter((r) => SCENARIOS[r.id - 1].expect_codes.length === 0);
  const flawed = rows.filter((r) => SCENARIOS[r.id - 1].expect_codes.length > 0);
  const falsePositives = clean.filter((r) => r.falsePositive);
  const recallHits = flawed.filter((r) => r.recallHit);
  const verdictMatches = rows.filter((r) => r.verdictMatch);

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("SUMMARY");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`Verdict match      : ${verdictMatches.length}/${rows.length}`);
  console.log(`Detection recall   : ${recallHits.length}/${flawed.length} flawed scenarios fired >=1 expected code`);
  console.log(`False positives    : ${falsePositives.length}/${clean.length} clean scenarios wrongly FAILed`);
  if (falsePositives.length > 0) {
    console.log(`  >> ${falsePositives.map((r) => `#${r.id}`).join(", ")} — CONCERN: detector flags clean strategies. Investigate before trusting FAIL verdicts.`);
  } else {
    console.log(`  >> clean scenarios held — detector is not trigger-happy on bounded-risk inputs. Good.`);
  }
  console.log("");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
