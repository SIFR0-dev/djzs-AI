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
// ── Break-even floor (Gate 2 mechanics, non-scoring). The bracket must never touch the verdict or its hash.
const BRACKET = { side: "long" as const, entry: 100_000, stop: 99_000, target: 102_000, taker_fee_bps: 5, hit_rate_pct: 45 };
for (const [label, extraction] of cases) {
  const model = async () => JSON.stringify(extraction);
  const plain = await runVerifyPerpTrade(INTENT, model);
  const withB = await runVerifyPerpTrade(INTENT, model, BRACKET);
  const { mechanics: m1, ...a } = plain as Record<string, unknown>;
  const { mechanics: m2, ...b } = withB as Record<string, unknown>;
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok &&= same;
  console.log(`${same ? "ok " : "BAD"} bracket parity: ${label.padEnd(36)} verdict ${String(withB.verdict)} hash ${String(withB.verdict_hash ?? "-").slice(0, 12)} unchanged`);
  if (plain.in_scope !== false && ((m1 as any)?.breakeven !== null || (m2 as any)?.breakeven?.status !== "computed")) { console.log("BAD mechanics.breakeven presence"); ok = false; }
}
const thesis = base({ thesis_statement: { state: "present", value: "funding extreme, 82K rejected 4x" } });
const be = async (bracket: Record<string, unknown>) =>
  ((await runVerifyPerpTrade(INTENT, async () => JSON.stringify(thesis), bracket as any)).mechanics as any).breakeven;
const check = (label: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${label.padEnd(56)} → ${JSON.stringify(got)}${pass ? "" : ` (want ${JSON.stringify(want)})`}`);
};
// long 100,000 / stop 99,000 / target 102,000, 5 bps in and out: loss 1,099.50, gain 1,899 -> p* = 1,099.50 / 2,998.50 = 36.67% (up)
const b1 = await be(BRACKET);
check("2R long at 5 bps: R, c, p*, p0", [b1.r, b1.c, b1.pstar_pct, b1.p0_pct], [2, 0.1001, 36.67, 33.33]);
check("claim 45% clears the floor (p* + 1 pt)", [b1.clears_floor, b1.funding_included, b1.scored], [true, false, false]);
check("claim 37% does not", (await be({ ...BRACKET, hit_rate_pct: 37 })).clears_floor, false);
check("no stated hit rate: floor reported, verdict on the claim withheld", (await be({ ...BRACKET, hit_rate_pct: undefined })).clears_floor, null);
// funding counted only with volatility: 0.03%/8h long, sigma 50% -> hold 7.0 h, funding 262.80 per BTC -> p* 37.55%
const b2 = await be({ ...BRACKET, funding_rate_8h: 0.0003, sigma_annual: 0.5 });
check("funding paid by a long raises p*", [b2.pstar_pct, b2.expected_hold_hours, b2.funding_included], [37.55, 7, true]);
check("a backwards bracket is reported, not computed", (await be({ ...BRACKET, stop: 101_000 })).status, "invalid");
// the same arithmetic at an XRP-sized price (short 1.4706, stop 1.4888, target 1.4342) keeps its precision
const b3 = await be({ side: "short", entry: 1.4706, stop: 1.4888, target: 1.4342, taker_fee_bps: 5 });
check("short at a $1.47 price: R 2, p0 1/(1+R)", [b3.r, b3.p0_pct], [2, 33.33]);

console.log(ok ? "VERIFY_PERP_TRADE PIPELINE TEST PASS" : "FAIL");
if (!ok) process.exit(1);
