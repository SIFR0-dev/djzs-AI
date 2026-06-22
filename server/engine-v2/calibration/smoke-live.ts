import { extractAuditInput } from "../extraction-layer";
import { runDeterministicAudit } from "../deterministic-engine";

const CASES = [
  { id: "block-x01-1", expect: "FAIL",
    intent: "Open a 10x long on SOL here at $150. Target is $180, let's just hold it until we hit target." },
  { id: "exec-001", expect: "PASS",
    intent: "Long ETH 2x, sized at 3% of book, stop at the prior swing low, thesis is the on-chain accumulation I've tracked for two weeks." },
  { id: "exec-x01-1", expect: "PASS",
    intent: "Open a 10x long on SOL at $150. Target $180, but kill the trade instantly if the 1H candle closes below $142." },
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("NO ANTHROPIC_API_KEY in env");
    process.exit(2);
  }
  console.log("LIVE extraction smoke test\n" + "=".repeat(60));
  for (const c of CASES) {
    console.log(`\n[${c.id}]  expect: ${c.expect}`);
    console.log(`  intent: ${c.intent}`);
    try {
      const { input, failsafe } = await extractAuditInput(c.intent);
      const r = runDeterministicAudit(input);
      const f = (k: string, v: { state?: string; value?: unknown } | null | undefined) => `${k}=${v?.state === "present" ? JSON.stringify(v.value) : v?.state ?? "?"}`;
      console.log(`  extracted: ${f("lev", input.leverage)} ${f("stop", input.stop_loss)} ${f("inval", input.invalidation_condition)} ${f("oracle", input.oracle_source)} ${f("sources", input.data_sources)}`);
      console.log(`  failsafe: ${failsafe}  -> VERDICT: ${r.verdict}  flags: [${r.flags.map(x => x.code).join(", ") || "none"}]`);
      console.log(`  ${r.verdict === c.expect ? "OK" : `MISMATCH expected ${c.expect} got ${r.verdict}`}`);
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main();
