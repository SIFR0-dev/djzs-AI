/**
 * Diagnostic for the attested lane's extraction failures (fill35). LIVE: 16 single extractions, cents.
 *
 * The first attested Q2 run (2026-10-23, tests/out/q2-live-phala-2026-10-23-23-24-21.json:
 * qwen/qwen3.8-27b, max_tokens 1024, no reasoning control) failsafed 60 of 80 consensus runs:
 * 11 of the 12 full PM theses 5/5 (R1 3/5), the one-line A2 2/5, A1 and both perp intents never.
 * Hypothesis under test: the model reasons by default, its reasoning counts against max_tokens, and
 * on a thesis that draws long reasoning the budget runs out before the JSON closes. This runs ONE
 * extraction per (configuration x intent) through the attested lane
 * and prints what came back - finish_reason, tokens, returned reasoning, whether the answer parsed,
 * the single-sample verdict - so the configuration the Q2 harnesses measure is chosen from
 * evidence and declared before they run. It rules nothing: the bar is the harness's.
 *
 *   npx tsx tests/phala-extraction-diag.ts        (PHALA_API_KEY / PHALA_MODEL from djzs-trust-mcp/.dev.vars or env)
 *
 * Writes tests/out/phala-diag-<utc>.json: every raw output and receipt, never the key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractAuditInput, type ModelFn } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
import {
  attestedChatCompletion,
  EMPTY_OUTPUT_SHA256,
  establishWorkload,
  PHALA_ACI_BASE,
  PHALA_DEFAULT_MODEL,
  type AttestedDetection,
  type ReasoningMode,
} from "../djzs-trust-mcp/src/attested-detector";

// -- production-identical rendering and .dev.vars reading (verbatim from tests/q2-extraction-reliability.ts) --
function renderIntentText(i: unknown): string {
  if (typeof i === "string") return i; if (!i || typeof i !== "object") return String(i);
  const o = i as Record<string, unknown>;
  return Object.keys(o).sort().map(k => { const v = o[k]; const s = typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v); return `${k}: ${s}`; }).join("\n");
}
function readDevVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const p = "djzs-trust-mcp/.dev.vars"; if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split("\n")) { const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`)); if (m) return m[1].trim(); }
}

// -- four intents from the two Q2 corpora, verbatim: long / medium / short PM, long perp --
const INTENTS: { ctx: "pm" | "perp"; id: string; designed: string; cls: string; intent: Record<string, unknown> }[] = [
  { ctx: "pm", id: "F1", designed: "PASS", cls: "FULL", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "BTC spot ~$77,263 (Coinbase 2026-09-01T20:08Z) sits ~0.34% above the $77,000 line; absent a close under $77,000 at the Sep 2 settlement, KXBTCD-26SEP0217-T76999.99 resolves YES.", probability_basis: "spot $77,263 vs $77,000 strike = +0.34% ITM; Kalshi book unquoted so implied N/A; model P(YES) approx 0.70; basis Coinbase spot 2026-09-01T20:08Z", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "BTC hourly close below $77,000 on Coinbase before the Sep 2 settlement" } } },
  { ctx: "pm", id: "P1", designed: "FAIL", cls: "NO_PROBABILITY", intent: { market: "KXBTCD-26SEP0217-T76999.99", side: "YES", thesis: "Resolves YES on a Sep 2 close above $77,000. BTC is at $77,263 and it feels like it holds.", probability_basis: "gut feel; it just looks strong", size_usd: 250, bounds: { max_loss_usd: 250, exit_condition: "exit on an hourly close below $77,000" } } },
  { ctx: "pm", id: "A1", designed: "WAIT", cls: "AMBIGUOUS", intent: { market: "KXBTCD", side: "YES", thesis: "btc yes", size_usd: 100 } },
  { ctx: "perp", id: "PF1", designed: "PASS", cls: "FULL_LONG", intent: { instrument: "BTC-PERP", side: "LONG", leverage: 5, entry: 78900, stop_loss: 76200, take_profit: 83000, size_usd: 3000, venue: "Binance", thesis: "Funding reset from 8% to 2% annualized after the weekend flush; 82K rejected four times but 80K held on the daily close; ETF inflows resumed (+$174M Sep 4, Farside). Invalidation: a daily close below 76,200. Oracle: Binance mark price. Confidence 65%." } },
];

// -- four request shapes. C0 reproduces the 2026-10-23 run; the others each change ONE thing. --
const CONFIGS: { id: string; reasoning?: ReasoningMode; maxTokens: number; note: string }[] = [
  { id: "C0", maxTokens: 1024, note: "as run 2026-10-23: no reasoning control, 1024" },
  { id: "C1", reasoning: "off", maxTokens: 1024, note: "reasoning off, same 1024 budget as the Anthropic path" },
  { id: "C2", maxTokens: 8192, note: "no reasoning control, 8x budget" },
  { id: "C3", reasoning: "low", maxTokens: 8192, note: "reasoning low, 8x budget" },
];

const apiKey = readDevVar("PHALA_API_KEY") ?? "";
if (!apiKey) { console.error("PHALA_API_KEY not found in djzs-trust-mcp/.dev.vars or env. Nothing was sent."); process.exit(2); }
const model = readDevVar("PHALA_MODEL") ?? PHALA_DEFAULT_MODEL;

type Row = {
  config: string; intent: string; ctx: string; designed: string;
  error: string | null; verified: boolean | null; finish_reason: string | null;
  prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null;
  reasoning_chars: number; content_chars: number; empty: boolean; parsed: boolean | null;
  audit_context: string | null; verdict: string | null; codes: string[]; content_head: string;
  raw: string; detection: AttestedDetection | null;
};

(async () => {
  const est = await establishWorkload({ base: PHALA_ACI_BASE, apiKey });
  if (!est.ok) { console.error(`attestation binding FAILED: ${JSON.stringify(est.checks.filter((c) => !c.ok))}`); process.exit(1); }
  console.log(`phala extraction diagnostic | ${model} | keyset ${est.digest.slice(0, 19)}... | ${CONFIGS.length} configs x ${INTENTS.length} intents = ${CONFIGS.length * INTENTS.length} calls\n`);
  const rows: Row[] = [];
  for (const c of CONFIGS) {
    const batch = await Promise.all(INTENTS.map(async (t): Promise<Row> => {
      const text = renderIntentText(t.intent);
      let det: AttestedDetection | null = null;
      const fn: ModelFn = async (prompt) => {
        const r = await attestedChatCompletion({ apiKey, prompt, model, maxTokens: c.maxTokens, ...(c.reasoning ? { reasoning: c.reasoning } : {}), temperature: 0, base: PHALA_ACI_BASE, established: est });
        det = r.detection;
        return r.text;
      };
      const base: Row = { config: c.id, intent: t.id, ctx: t.ctx, designed: t.designed, error: null, verified: null, finish_reason: null, prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, reasoning_chars: 0, content_chars: 0, empty: false, parsed: null, audit_context: null, verdict: null, codes: [], content_head: "", raw: "", detection: null };
      try {
        const ex = await extractAuditInput(text, fn, t.ctx === "perp" ? "perp" : undefined);
        const d = det as AttestedDetection | null;
        const ac = ex.input.audit_context ?? null;
        const outOfScope = t.ctx === "pm" ? ac !== "prediction_market" : ac === "prediction_market";
        const e = outOfScope ? null : runDeterministicAudit(ex.input);
        return { ...base, verified: d?.verified ?? null, finish_reason: d?.finish_reason ?? null, prompt_tokens: d?.usage?.prompt_tokens ?? null, completion_tokens: d?.usage?.completion_tokens ?? null, reasoning_tokens: d?.usage?.reasoning_tokens ?? null, reasoning_chars: d?.reasoning_chars ?? 0, content_chars: ex.raw.length, empty: d?.detector_output_sha256 === EMPTY_OUTPUT_SHA256, parsed: !ex.failsafe, audit_context: ac, verdict: outOfScope ? "OUT_OF_SCOPE" : e!.verdict, codes: e ? e.flags.map((f) => f.code).sort() : [], content_head: ex.raw.replace(/\s+/g, " ").slice(0, 90), raw: ex.raw, detection: d };
      } catch (err) {
        return { ...base, error: (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200) };
      }
    }));
    rows.push(...batch);
  }

  const pad = (s: unknown, n: number) => String(s ?? "-").padEnd(n);
  console.log("cfg intent ctx  designed  verified finish  prompt  compl  reason  r.chars  c.chars  parse     verdict       codes");
  for (const r of rows) {
    if (r.error) { console.log(`${pad(r.config, 3)} ${pad(r.intent, 6)} ${pad(r.ctx, 4)} ${pad(r.designed, 9)} ERROR ${r.error}`); continue; }
    console.log(`${pad(r.config, 3)} ${pad(r.intent, 6)} ${pad(r.ctx, 4)} ${pad(r.designed, 9)} ${pad(r.verified, 8)} ${pad(r.finish_reason, 7)} ${pad(r.prompt_tokens, 7)} ${pad(r.completion_tokens, 6)} ${pad(r.reasoning_tokens, 7)} ${pad(r.reasoning_chars, 8)} ${pad(r.content_chars, 8)} ${pad(r.parsed ? "ok" : r.empty ? "EMPTY" : "FAILSAFE", 9)} ${pad(r.verdict, 13)} ${r.codes.join("+") || "-"}`);
  }
  console.log("");
  for (const c of CONFIGS) {
    const rs = rows.filter((r) => r.config === c.id);
    const clean = rs.every((r) => !r.error && r.verified === true && r.parsed === true && r.finish_reason !== "length");
    const match = rs.filter((r) => r.verdict === r.designed).length;
    console.log(`${c.id}  ${clean ? "CLEAN " : "BROKEN"}  parsed ${rs.filter((r) => r.parsed).length}/${rs.length}  length-stops ${rs.filter((r) => r.finish_reason === "length").length}  empty ${rs.filter((r) => r.empty).length}  errors ${rs.filter((r) => r.error).length}  single-sample verdict = designed ${match}/${rs.length}  | ${c.note}`);
  }
  console.log("\ncontent heads (what the model actually returned):");
  for (const r of rows) if (!r.error) console.log(`  ${r.config} ${pad(r.intent, 4)} ${JSON.stringify(r.content_head)}`);

  mkdirSync("tests/out", { recursive: true });
  const out = `tests/out/phala-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ model, gateway: PHALA_ACI_BASE, workload_keyset_digest: est.digest, configs: CONFIGS, rows }, null, 2));
  console.log(`\nraw outputs + receipts -> ${out}`);
  console.log("PHALA EXTRACTION DIAGNOSTIC: DONE (it rules nothing; paste the two tables)");
})();
