/**
 * Q2 — EXTRACTION RELIABILITY. "LLM detects, TypeScript decides": Q1 proved the decider over its
 * whole space. This measures the detector: does N=3 consensus extraction turn the SAME thesis into
 * the SAME tri-state fields — and therefore the same verdict — run after run?
 *
 * PRE-REGISTERED THRESHOLDS (written before any run):
 *   verdict stability  = mean over theses of (modal-verdict count / K)
 *     >= 0.95 and >= 80% of theses at K/K   -> RELIABLE
 *     0.85 - 0.95                            -> MARGINAL   (locate the flipping field; tighten prompt/gates)
 *     <  0.85                                -> UNRELIABLE (the verdict is not a property of the thesis)
 *   failsafe rate <= 2% of consensus runs
 *   designed-class match is REPORTED, not scored — the design labels are the author's intent, not ground truth.
 *
 * Runs: K replays x 15 theses, each replay = one N=3 consensus (3 model calls). Default K=5 -> 225 calls, ~US$3 on Sonnet.
 * No x402. No settlement. Reads ANTHROPIC_API_KEY from djzs-trust-mcp/.dev.vars (or env).
 *   npx tsx tests/q2-extraction-reliability.ts               # real run
 *   npx tsx tests/q2-extraction-reliability.ts --stub        # plumbing self-test, deterministic stub, $0
 *   npx tsx tests/q2-extraction-reliability.ts --stub-noisy  # proves the metrics DETECT instability, $0
 *   K=3 npx tsx ...                                          # cheaper run
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extractAuditInputConsensus, type ModelFn } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";

// ── production-identical rendering (port of engine-adapter.ts renderIntentText) ─────────────────
function renderIntentText(i: unknown): string {
  if (typeof i === "string") return i; if (!i || typeof i !== "object") return String(i);
  const o = i as Record<string, unknown>;
  return Object.keys(o).sort().map(k => { const v = o[k]; const s = typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v); return `${k}: ${s}`; }).join("\n");
}

// ── model function (inlined from verify-pm-trade.ts; same model, temp 0) ────────────────────────
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages", CLAUDE_MODEL = "claude-sonnet-4-6";
function readDevVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const p = "djzs-trust-mcp/.dev.vars"; if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split("\n")) { const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`)); if (m) return m[1].trim(); }
}
function anthropicModelFn(apiKey: string): ModelFn {
  return async (prompt) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await fetch(ANTHROPIC_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, temperature: 0, messages: [{ role: "user", content: prompt }] }) });
      if (r.status === 429 || r.status === 529 || r.status >= 500) { await new Promise(res => setTimeout(res, 1500 * attempt)); continue; }
      if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json() as { content?: { text?: string }[] }; return d.content?.[0]?.text ?? "";
    }
    throw new Error("Claude API: retries exhausted");
  };
}
// ── stubs: deterministic plumbing check, and a noisy variant that MUST register as unstable ────
function stubModelFn(noisy: boolean): ModelFn {
  return async (prompt) => {
    const text = prompt.split("AGENT INTENT:\n")[1] ?? "";
    const pm = !/PERP|leverage/i.test(text);
    const invPresent = noisy ? Math.random() > 0.2 : true; // noisy: 20% of samples flip invalidation -> M02
    const out: Record<string, unknown> = {
      agent_type: "trading-agent", intended_action: "bet", market_type: pm ? "prediction_market" : "perp",
      leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
      invalidation_condition: invPresent ? { state: "present", value: "stub exit" } : { state: "absent" },
      resolution_engagement: { state: "present", value: "stub" }, probability_basis: { state: "present", value: "stub" }, edge_claim: { state: "present", value: "stub" },
      data_sources: { state: "present", value: ["stub"] }, oracle_source: { state: "present", value: "stub" }, confidence: { state: "absent" } };
    if (pm) out.audit_context = "prediction_market";
    return JSON.stringify(out);
  };
}

// ── corpus: 15 intents spanning the Q1 verdict space. `designed` = author's intent, reported not scored. ─
type Intent = Record<string, unknown>;
const CORPUS: { id: string; designed: "PASS" | "FAIL" | "WAIT" | "OUT_OF_SCOPE"; cls: string; intent: Intent }[] = [
  { id: "F1", designed: "PASS", cls: "FULL", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "BTC spot ~$77,263 (Coinbase 2026-09-01T20:08Z) sits ~0.34% above the $77,000 line; absent a close under $77,000 at the Sep 2 settlement, KXBTCD-26SEP0217-T76999.99 resolves YES.", probability_basis: "spot $77,263 vs $77,000 strike = +0.34% ITM; Kalshi book unquoted so implied N/A; model P(YES) approx 0.70; basis Coinbase spot 2026-09-01T20:08Z", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "BTC hourly close below $77,000 on Coinbase before the Sep 2 settlement" } } },
  { id: "F2", designed: "PASS", cls: "FULL", intent: { market: "KXFEDDECISION-26SEP", side: "YES", thesis: "The market resolves YES if the FOMC statement on Sep 17 announces a cut to the target range. CME FedWatch implies 87% for a cut as of 2026-09-01; Kalshi YES trades at 84c, a 3-point gap to the futures-implied probability.", probability_basis: "CME FedWatch 87% (2026-09-01) vs Kalshi YES 84c; edge = +3 pts; source: cmegroup.com FedWatch", size_usd: 400, bounds: { max_loss_usd: 400, exit_condition: "exit if two or more FOMC voters publicly oppose a cut before Sep 10, or if FedWatch drops below 70%" } } },
  { id: "F3", designed: "PASS", cls: "FULL", intent: { market: "polymarket:eth-above-4000-sep-30", side: "NO", thesis: "Resolves per Coinbase ETH-USD close on Sep 30 vs $4,000. Spot $3,610 on 2026-09-01; reaching $4,000 needs +10.8% in 29 days. Realized 30d vol 48% annualized implies ~14% one-month sigma, so a +10.8% move is roughly a 0.77-sigma event, P ~ 0.22 for YES; market YES at 31c overprices it.", probability_basis: "lognormal with 48% ann. vol (Coinbase 30d realized) gives P(YES) ~ 0.22 vs market 0.31; edge ~9 pts to NO", size_usd: 300, bounds: { max_loss_usd: 300, exit_condition: "exit NO if ETH daily close exceeds $3,850 before Sep 20" } } },
  { id: "I1", designed: "FAIL", cls: "NO_INVALIDATION", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "BTC spot $77,263 sits above the $77,000 line for the Sep 2 settlement; the market resolves YES on a close above $77,000.", probability_basis: "spot $77,263 vs $77,000 = +0.34% ITM; P(YES) ~0.70 from Coinbase spot 2026-09-01", size_usd: 250, bounds: { max_loss_usd: 250 } } },
  { id: "I2", designed: "FAIL", cls: "NO_INVALIDATION", intent: { market: "KXFEDDECISION-26SEP", side: "YES", thesis: "Resolves YES on a Sep 17 FOMC cut. FedWatch 87%, Kalshi 84c. Holding to resolution regardless of interim news.", probability_basis: "CME FedWatch 87% vs Kalshi 84c, 2026-09-01", size_usd: 400, bounds: { max_loss_usd: 400 } } },
  { id: "I3", designed: "FAIL", cls: "NO_INVALIDATION", intent: { market: "polymarket:eth-above-4000-sep-30", side: "NO", thesis: "Resolves on Coinbase ETH close Sep 30 vs $4,000. Spot $3,610; +10.8% in 29 days is ~0.77 sigma at 48% vol; P(YES) ~0.22 vs 31c market. No conditions under which I would exit early.", probability_basis: "lognormal, 48% realized vol, P(YES) ~0.22 vs 0.31", size_usd: 300, bounds: { max_loss_usd: 300 } } },
  { id: "R1", designed: "FAIL", cls: "NO_RESOLUTION", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "ETF inflows were $1.2B last week and the halving supply shock is compounding. Institutions are accumulating. BTC is going much higher this quarter.", probability_basis: "ETF inflow data (Farside, week of Aug 25) and post-halving supply schedule; P(higher by year end) ~0.80", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "exit if weekly ETF flows turn net negative" } } },
  { id: "R2", designed: "FAIL", cls: "NO_RESOLUTION", intent: { market: "KXFEDDECISION-26SEP", side: "YES", thesis: "Inflation is structurally falling and the labor market is softening; the Fed's easing cycle will continue through 2027. Rates are coming down.", probability_basis: "CPI trend (BLS, Aug print 2.6% y/y) and unemployment 4.4%; P(easing cycle continues) ~0.85", size_usd: 400, bounds: { max_loss_usd: 400, exit_condition: "exit if core CPI re-accelerates above 3.0% y/y" } } },
  { id: "R3", designed: "FAIL", cls: "NO_RESOLUTION", intent: { market: "polymarket:eth-above-4000-sep-30", side: "YES", thesis: "ETH is the settlement layer for tokenized treasuries and L2 throughput doubled this year. Long-term ETH wins. Fundamentals have never been stronger.", probability_basis: "L2 throughput data (L2Beat) and RWA TVL growth (DefiLlama); P(ETH outperforms over 2 years) ~0.70", size_usd: 300, bounds: { max_loss_usd: 300, exit_condition: "exit if RWA TVL on Ethereum declines 30% from peak" } } },
  { id: "P1", designed: "FAIL", cls: "NO_PROBABILITY", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "Resolves YES on a Sep 2 close above $77,000. BTC is at $77,263 and it feels like it holds.", probability_basis: "gut feel; it just looks strong", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "exit on an hourly close below $77,000" } } },
  { id: "P2", designed: "FAIL", cls: "NO_PROBABILITY", intent: { market: "KXFEDDECISION-26SEP", side: "YES", thesis: "Resolves YES if the FOMC cuts on Sep 17. Everyone knows a cut is coming.", probability_basis: "consensus; everyone expects it", size_usd: 400, bounds: { max_loss_usd: 400, exit_condition: "exit if a voting member publicly opposes a cut" } } },
  { id: "P3", designed: "FAIL", cls: "NO_PROBABILITY", intent: { market: "polymarket:eth-above-4000-sep-30", side: "NO", thesis: "Resolves on the Sep 30 Coinbase close vs $4,000. ETH at $3,610 won't make it; the chart looks heavy.", probability_basis: "chart looks heavy", size_usd: 300, bounds: { max_loss_usd: 300, exit_condition: "exit if ETH closes above $3,850" } } },
  { id: "A1", designed: "WAIT", cls: "AMBIGUOUS", intent: { market: "KXBTCD", side: "YES", thesis: "btc yes", size_usd: 100 } },
  { id: "A2", designed: "WAIT", cls: "AMBIGUOUS", intent: { market: "fed cut market", side: "YES", thesis: "cut incoming, sizing later", size_usd: 50 } },
  { id: "N1", designed: "OUT_OF_SCOPE", cls: "NON_PM", intent: { instrument: "ETH-PERP", side: "LONG", leverage: 5, entry: 4120, stop_loss: 3950, take_profit: 4600, size_usd: 2000, thesis: "ETH-PERP long 5x: breakout above 4,100 resistance with rising OI; stop 3,950, target 4,600." } },
];

// ── run ────────────────────────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2)); const STUB = args.has("--stub") || args.has("--stub-noisy");
const K = Number(process.env.K ?? 5); const CONC = 3;
const FIELDS = ["invalidation_condition", "resolution_engagement", "probability_basis", "edge_claim"] as const;
type Run = { verdict: string; risk: number; codes: string[]; in_scope: boolean; states: Record<string, string>; disagreements: string[]; failsafe: boolean };

const model: ModelFn = STUB ? stubModelFn(args.has("--stub-noisy")) : (() => { const k = readDevVar("ANTHROPIC_API_KEY"); if (!k) { console.error("ANTHROPIC_API_KEY not found in djzs-trust-mcp/.dev.vars or env"); process.exit(2); } return anthropicModelFn(k); })();

async function oneRun(text: string): Promise<Run> {
  const r = await extractAuditInputConsensus(text, model, 3);
  const states: Record<string, string> = { audit_context: r.input.audit_context ?? "(unset)" };
  for (const f of FIELDS) states[f] = (r.input as any)[f]?.state ?? "(missing)";
  if (r.input.audit_context !== "prediction_market") return { verdict: "OUT_OF_SCOPE", risk: 0, codes: [], in_scope: false, states, disagreements: r.disagreements, failsafe: r.failsafe };
  const e = runDeterministicAudit(r.input);
  return { verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(f => f.code).sort(), in_scope: true, states, disagreements: r.disagreements, failsafe: r.failsafe };
}
const mode = (xs: string[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]; };

(async () => {
  console.log(`Q2 extraction reliability · ${STUB ? (args.has("--stub-noisy") ? "STUB-NOISY (self-test: must read UNSTABLE)" : "STUB (self-test: must read RELIABLE)") : `LIVE · ${CLAUDE_MODEL}`} · K=${K} · ${CORPUS.length} theses · ${CORPUS.length * K * 3} model calls\n`);
  const results: { id: string; cls: string; designed: string; runs: Run[] }[] = [];
  const queue = [...CORPUS];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) { const t = queue.shift()!; const text = renderIntentText(t.intent); const runs: Run[] = [];
      for (let k = 0; k < K; k++) runs.push(await oneRun(text));
      results.push({ id: t.id, cls: t.cls, designed: t.designed, runs }); process.stdout.write(`  ${t.id} done\n`); }
  }));
  results.sort((a, b) => CORPUS.findIndex(c => c.id === a.id) - CORPUS.findIndex(c => c.id === b.id));

  // ── metrics ──
  let stabSum = 0, fullyStable = 0, failsafes = 0, totalRuns = 0, disagreeSum = 0, designedMatch = 0;
  const fieldFlip: Record<string, number> = {}; for (const f of [...FIELDS, "audit_context"]) fieldFlip[f] = 0;
  console.log("\nid  class            designed      modal verdict   stability  codes(modal)            flips: inv res prob edge ctx   disagr/run  failsafe");
  for (const r of results) {
    const [mv, mc] = mode(r.runs.map(x => x.verdict)); const stab = mc / K; stabSum += stab; if (mc === K) fullyStable++;
    const fl: Record<string, number> = {}; for (const f of [...FIELDS, "audit_context"]) { const [, c] = mode(r.runs.map(x => x.states[f])); fl[f] = K - c; fieldFlip[f] += K - c; }
    const fs = r.runs.filter(x => x.failsafe).length; failsafes += fs; totalRuns += K;
    const dis = r.runs.reduce((s, x) => s + x.disagreements.length, 0) / K; disagreeSum += dis;
    const match = mv === r.designed; if (match) designedMatch++;
    const [codes] = mode(r.runs.map(x => x.codes.join("+") || "—"));
    console.log(`${r.id.padEnd(3)} ${r.cls.padEnd(16)} ${r.designed.padEnd(13)} ${mv.padEnd(15)} ${String(mc).padStart(1)}/${K}        ${codes.padEnd(23)} ${String(fl.invalidation_condition).padStart(5)} ${String(fl.resolution_engagement).padStart(3)} ${String(fl.probability_basis).padStart(4)} ${String(fl.edge_claim).padStart(4)} ${String(fl.audit_context).padStart(3)}   ${dis.toFixed(2).padStart(8)}   ${fs}/${K}${match ? "" : "   ≠designed"}`);
  }
  const n = results.length, meanStab = stabSum / n, pctFull = fullyStable / n, fsRate = failsafes / totalRuns;
  const grade = meanStab >= 0.95 && pctFull >= 0.8 ? "RELIABLE" : meanStab >= 0.85 ? "MARGINAL" : "UNRELIABLE";
  console.log(`\nverdict stability   mean ${meanStab.toFixed(3)} · ${fullyStable}/${n} theses at ${K}/${K}   → ${grade}${fsRate > 0.02 ? "  (FAILSAFE RATE EXCEEDED)" : ""}`);
  console.log(`field flips (total across ${n * K} runs)  ` + Object.entries(fieldFlip).map(([f, c]) => `${f.replace("_condition", "").replace("_engagement", "").replace("_basis", "").replace("_claim", "")}=${c}`).join("  "));
  console.log(`disagreements       ${(disagreeSum / n).toFixed(2)} fields demoted per run (mean)`);
  console.log(`failsafe            ${failsafes}/${totalRuns} runs (${(fsRate * 100).toFixed(1)}%)`);
  console.log(`designed-class match ${designedMatch}/${n} (reported, not scored)`);
  mkdirSync("tests/out", { recursive: true });
  const out = `tests/out/q2-${STUB ? "stub" : "live"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ mode: STUB ? "stub" : "live", model: STUB ? null : CLAUDE_MODEL, K, thresholds: { reliable: "mean>=0.95 && full>=0.8", marginal: "mean>=0.85", failsafe_max: 0.02 }, grade, meanStab, pctFull, fsRate, fieldFlip, designedMatch, results }, null, 2));
  console.log(`\nraw runs → ${out}`);
  if (STUB) { const expect = args.has("--stub-noisy") ? grade !== "RELIABLE" : grade === "RELIABLE"; console.log(expect ? "\nSELF-TEST PASS — harness measures what it claims" : "\nSELF-TEST FAIL — harness metrics wrong"); process.exit(expect ? 0 : 1); }
})();
