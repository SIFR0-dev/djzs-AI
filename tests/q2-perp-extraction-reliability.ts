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
      let r: Response;
      try {
        r = await fetch(ANTHROPIC_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, temperature: 0, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(60_000) });
      } catch (e) { // network-level failure (connect timeout, reset, DNS) — retry like a 5xx instead of killing the run
        if (attempt === 4) throw e; console.error(`  [net] attempt ${attempt}: ${(e as Error).message.slice(0, 80)} — retrying`); await new Promise(res => setTimeout(res, 2000 * attempt)); continue; }
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

// ── corpus: 14 PERP intents spanning the LF-v1.2 verdict space (PASS/WAIT/FAIL/OUT_OF_SCOPE). `designed` = author's intent, reported not scored. ─
type Intent = Record<string, unknown>;
const CORPUS: { id: string; designed: "PASS" | "FAIL" | "WAIT" | "OUT_OF_SCOPE"; cls: string; intent: Intent }[] = [
  { id: "PF1", designed: "PASS", cls: "FULL_LONG", intent: { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance", thesis: "Funding reset from 8% to 2% annualized after the weekend flush; 82K rejected four times but 80K held on the daily close; ETF inflows resumed (+$174M Sep 4, Farside). Invalidation: a daily close below 76,200. Oracle: Binance mark price. Confidence 65%." } },
  { id: "PF2", designed: "PASS", cls: "FULL_SHORT", intent: { instrument: "ETH-PERP", side: "SHORT", leverage: 3, entry: 2480, stop_loss: 2560, take_profit: 2300, size_usd: 2000, venue: "Binance", thesis: "ETH/BTC is breaking down while BTC dominance rises through 59.6%; ETH funding is positive so longs pay to hold. Wrong if ETH reclaims 2,520 on a 4h close. Data: Coinbase spot, Binance funding. Oracle: Binance mark price." } },
  { id: "PF3", designed: "PASS", cls: "HEDGED", intent: { instrument: "BTC-PERP", side: "SHORT", leverage: 2, entry: 78900, size_usd: 78900, venue: "Binance", thesis: "Delta-neutral funding carry: long 1 BTC spot on Coinbase against a 1 BTC perp short on Binance to collect positive funding while retail is net long. Unwind if funding turns negative for three consecutive 8h periods; stop out if the spot/perp basis exceeds 1.5%. Oracle: Binance mark price and Coinbase spot." } },
  { id: "PT1", designed: "FAIL", cls: "NO_THESIS", intent: { instrument: "BTC-PERP", side: "SHORT", leverage: 10, entry: 77481.55, stop_loss: 79800, take_profit: 73000, size_usd: 3000, venue: "Binance (assumed)", thesis: "Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000." } },
  { id: "PT2", designed: "FAIL", cls: "NO_THESIS", intent: { instrument: "SOL-PERP", side: "LONG", leverage: 20, entry: 225, stop_loss: 200, take_profit: 260, size_usd: 2000, venue: "Hyperliquid", thesis: "Long SOL 20x, $2,000, stop 200, target 260." } },
  { id: "PX1", designed: "FAIL", cls: "UNBOUNDED", intent: { instrument: "BTC-PERP", side: "LONG", leverage: 10, entry: 78900, size_usd: 5000, venue: "Binance", thesis: "ETF inflows are accelerating and the 50-month MA is reclaimed; long 10x. No stop, I am riding this until it tops out." } },
  { id: "PX2", designed: "FAIL", cls: "UNBOUNDED_NO_THESIS", intent: { instrument: "ETH-PERP", side: "LONG", leverage: 25, size_usd: 4000, venue: "Binance", thesis: "Max long ETH 25x, diamond hands, hold through anything." } },
  { id: "PI1", designed: "PASS", cls: "SOCIAL_ADVISORY", intent: { instrument: "DOGE-PERP", side: "LONG", leverage: 10, entry: 0.24, stop_loss: 0.21, take_profit: 0.30, size_usd: 1500, venue: "Binance", thesis: "Crypto Twitter is euphoric and the Telegram alpha group is calling 0.30 by Friday; sentiment is the driver. Stop 0.21. Oracle: Binance mark." } },
  { id: "PE1", designed: "PASS", cls: "ORACLE_ADVISORY", intent: { instrument: "AVAX-PERP", side: "LONG", leverage: 5, entry: 34, stop_loss: 30, take_profit: 40, size_usd: 2500, venue: "Binance", thesis: "TVL doubled this quarter according to the team's own dashboard and the subnet count is rising; stop 30, target 40. Data: the project dashboard." } },
  { id: "PW1", designed: "FAIL", cls: "NO_REASON_SOFT", intent: { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance", thesis: "Long BTC 5x, stop 76,200, target 83,000. Feels right here." } },
  { id: "PW2", designed: "WAIT", cls: "VAGUE_STOP", intent: { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, size_usd: 3000, venue: "Binance", thesis: "Funding reset and 80K held on the daily close, so I am long 5x. I will bail if it tanks." } },
  { id: "PW3", designed: "WAIT", cls: "SILENT_STOP", intent: { instrument: "ETH-PERP", side: "SHORT", leverage: 3, entry: 2480, size_usd: 2000, venue: "Binance", thesis: "ETH/BTC breaking down with dominance rising; short ETH 3x at 2,480." } },
  { id: "PM1", designed: "OUT_OF_SCOPE", cls: "PM_BET", intent: { market: "KXFEDDECISION-26SEP-H25", side: "YES", thesis: "Kalshi resolves YES if the FOMC hikes 25bps on Sep 16. Hot jobs and Waller's hedge leave the contract at 0.52; I take YES at 0.52 with a stop at 0.45.", size_usd: 250 } },
  { id: "PM2", designed: "OUT_OF_SCOPE", cls: "PM_BET", intent: { market: "polymarket:btc-above-80k-sep-30", side: "NO", thesis: "Resolves per Coinbase BTC-USD close Sep 30 vs $80,000; spot 78,900 needs +1.4%; market YES at 0.55 overprices it. Exit NO if BTC closes above 80,500 before Sep 25.", size_usd: 300 } },
];

// ── run ────────────────────────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2)); const STUB = args.has("--stub") || args.has("--stub-noisy");
const K = Number(process.env.K ?? 5); const CONC = 3;
const FIELDS = ["leverage", "position_size", "thesis_statement", "stop_loss", "invalidation_condition", "data_sources", "oracle_source"] as const;
type Run = { verdict: string; risk: number; codes: string[]; in_scope: boolean; states: Record<string, string>; disagreements: string[]; failsafe: boolean };

const model: ModelFn = STUB ? stubModelFn(args.has("--stub-noisy")) : (() => { const k = readDevVar("ANTHROPIC_API_KEY"); if (!k) { console.error("ANTHROPIC_API_KEY not found in djzs-trust-mcp/.dev.vars or env"); process.exit(2); } return anthropicModelFn(k); })();

async function oneRun(text: string): Promise<Run> {
  const r = await extractAuditInputConsensus(text, model, 3, "perp");
  const states: Record<string, string> = { audit_context: r.input.audit_context ?? "(unset)" };
  for (const f of FIELDS) states[f] = (r.input as any)[f]?.state ?? "(missing)";
  if (r.input.audit_context === "prediction_market") return { verdict: "OUT_OF_SCOPE", risk: 0, codes: [], in_scope: false, states, disagreements: r.disagreements, failsafe: r.failsafe };
  const e = runDeterministicAudit(r.input);
  return { verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(f => f.code).sort(), in_scope: true, states, disagreements: r.disagreements, failsafe: r.failsafe };
}
const mode = (xs: string[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]; };

(async () => {
  console.log(`Q2-PERP extraction reliability (X-LF-v1.2, perp prompt) · ${STUB ? (args.has("--stub-noisy") ? "STUB-NOISY (self-test: must read UNSTABLE)" : "STUB (self-test: must read RELIABLE)") : `LIVE · ${CLAUDE_MODEL}`} · K=${K} · ${CORPUS.length} theses · ${CORPUS.length * K * 3} model calls\n`);
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
