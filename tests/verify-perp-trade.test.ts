/** Offline test of the verify_perp_trade pipeline with a fake model. No network. */
import { runVerifyPerpTrade } from "../djzs-trust-mcp/src/verify-perp-trade";
const F = (state: string, value?: unknown, quote?: string) => state === "present" ? { state, value } : state === "absent" && quote ? { state, quote } : { state };
const base = (over: Record<string, unknown>) => ({ agent_type: "trader", intended_action: "open", market_type: "perp",
  leverage: F("present", 10), position_size: F("present", 3000), stop_loss: F("present", 79800), take_profit: F("present", 73000), invalidation_condition: F("absent", undefined, "TP $73,000"),
  resolution_engagement: F("unknown"), probability_basis: F("unknown"), edge_claim: F("unknown"), data_sources: F("present", ["Binance"]), oracle_source: F("present", "Binance mark price"), confidence: F("absent", undefined, "x"), ...over });
const INTENT = "Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000.";
const cases: [string, Record<string, unknown>, string][] = [
  ["thesis absent (quote-gated)", base({ thesis_statement: { state: "absent", quote: "Short BTC, entry $77,481.55" } }), "FAIL"],
  ["thesis absent but quote NOT in text (gate → unknown)", base({ thesis_statement: { state: "absent", quote: "this text is not in the intent" } }), "WAIT"],
  ["thesis unknown (silent)", base({ thesis_statement: { state: "unknown" } }), "WAIT"],
  ["thesis present", base({ thesis_statement: { state: "present", value: "funding extreme, 82K rejected 4x" } }), "PASS"],
  ["PM bet submitted to perp tool", base({ audit_context: "prediction_market", thesis_statement: { state: "unknown" } }), "OUT_OF_SCOPE"],
];
let ok = true;
for (const [label, extraction, expect] of cases) {
  const model = async () => JSON.stringify(extraction);
  const r = await runVerifyPerpTrade(INTENT, model);
  const got = r.in_scope === false ? "OUT_OF_SCOPE" : String(r.verdict); const pass = got === expect; ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${label.padEnd(48)} → ${got.padEnd(12)} ${r.in_scope === false ? "(free refusal)" : `risk ${r.risk_score} codes [${(r.flags as any[]).map(f => f.code).join(",")}]`} ${r.fail_reason ? "· fail_reason set" : ""}${r.halt_reason ? "· halt_reason: " + String(r.halt_reason).slice(0, 60) : ""}`);
  if (r.in_scope && (r as any).taxonomy?.extraction !== "DJZS-X-LF-v1.2") { console.log("BAD taxonomy.extraction =", (r as any).taxonomy?.extraction); ok = false; }
}
console.log(ok ? "VERIFY_PERP_TRADE PIPELINE TEST PASS" : "FAIL");
if (!ok) process.exit(1);
