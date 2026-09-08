/**
 * LF engine (perp path) — exhaustive verdict-space test, LF-v1.2. Mirrors tests/pm-engine-integrity.ts.
 * Enumerates every tri-state assignment over AUDIT_FIELDS (3^9 = 19,683) × 3 value variants (clean / social / unverified oracle)
 * and asserts the invariants the taxonomy promises. Exit 1 on any violation. No network, no model.
 */
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
import { AUDIT_FIELDS } from "../server/engine-v2/audit-input-schema";
type S = "present" | "absent" | "unknown";
const VALUES: Record<string, unknown> = { leverage: 10, position_size: 3000, stop_loss: 79800, take_profit: 73000, invalidation_condition: "hike delivered and BTC > 82K", data_sources: ["Binance funding"], oracle_source: "Binance mark price", confidence: 60, thesis_statement: "funding is extreme and 82K rejected four times" };
const VARIANTS: { name: string; over: Record<string, unknown> }[] = [
  { name: "clean", over: {} },
  { name: "social", over: { data_sources: ["twitter"] } },
  { name: "unverified-oracle", over: { oracle_source: "the team's dashboard" } },
];
const STATES: S[] = ["present", "absent", "unknown"]; const n = AUDIT_FIELDS.length; let total = 0, fails: string[] = []; const verdictCounts: Record<string, number> = {};
for (const v of VARIANTS) for (let k = 0; k < 3 ** n; k++) {
  const input: any = { agent_type: "t", intended_action: "open", audit_context: "perp", market_type: "perp", resolution_engagement: { state: "unknown" }, probability_basis: { state: "unknown" }, edge_claim: { state: "unknown" } };
  let x = k; const st: Record<string, S> = {};
  for (const f of AUDIT_FIELDS) { const s = STATES[x % 3]; x = Math.floor(x / 3); st[f] = s; input[f] = s === "present" ? { state: "present", value: (v.over as any)[f] ?? VALUES[f] } : { state: s }; }
  const r1 = runDeterministicAudit(input), r2 = runDeterministicAudit(input); total++; verdictCounts[`${v.name}:${r1.verdict}`] = (verdictCounts[`${v.name}:${r1.verdict}`] ?? 0) + 1;
  const codes = new Set(r1.flags.map(f => f.code)); const id = `${v.name}#${k}`;
  const bad = (m: string) => fails.length < 25 && fails.push(`${id} [${AUDIT_FIELDS.map(f => f + "=" + st[f][0]).join(" ")}] → ${r1.verdict} ${[...codes].join(",")}: ${m}`);
  if (JSON.stringify(r1) !== JSON.stringify(r2)) bad("non-deterministic");
  if (!["PASS", "WAIT", "FAIL"].includes(r1.verdict)) bad("verdict outside ladder");
  const hasPos = st.leverage === "present" || st.position_size === "present"; // the engine's definition of a position (X01, S01)
  // I1 — thesis absent on a position ⇒ S01 fires ⇒ FAIL (CRITICAL)
  if (hasPos && st.thesis_statement === "absent") { if (!codes.has("DJZS-S01")) bad("thesis absent but S01 did not fire"); if (r1.verdict !== "FAIL") bad("thesis absent but not FAIL"); }
  if (!(hasPos && st.thesis_statement === "absent") && codes.has("DJZS-S01")) bad("S01 fired without an absent thesis on a position");
  // I2 — S01 never fires on unknown thesis (absent-vs-unknown discipline)
  if (st.thesis_statement === "unknown" && codes.has("DJZS-S01")) bad("S01 fired on unknown thesis");
  // I3 — X01 iff position ∧ stop absent ∧ invalidation absent
  const x01 = hasPos && st.stop_loss === "absent" && st.invalidation_condition === "absent";
  if (x01 !== codes.has("DJZS-X01")) bad("X01 firing does not match its rule");
  // I4 — a PASS on a POSITION requires a present thesis and a bound (the LF-v1.2 fix: a stop alone cannot buy a PASS). Sub-threshold non-critical flags may ride on a PASS — they are advisory by frozen weight.
  if (r1.verdict === "PASS" && hasPos) { if (st.thesis_statement !== "present") bad("PASS on a position without a present thesis"); if (!(st.stop_loss === "present" || st.invalidation_condition === "present")) bad("PASS on a position while unbounded"); }
  if (r1.verdict === "PASS" && r1.flags.some((f: any) => f.severity === "CRITICAL")) bad("PASS with a CRITICAL flag");
  // I5 — a position with an unknown thesis never PASSes (it WAITs or FAILs)
  if (hasPos && st.thesis_statement === "unknown" && r1.verdict === "PASS") bad("position with unknown thesis passed");
  // I6 — any CRITICAL ⇒ FAIL; risk ≥ 50 ⇒ FAIL
  if ((r1.flags.some((f: any) => f.severity === "CRITICAL") || r1.risk_score >= 50) && r1.verdict !== "FAIL") bad("critical/threshold without FAIL");
  // I7 — social data source ⇒ I01
  if (v.name === "social" && st.data_sources === "present" && !codes.has("DJZS-I01")) bad("social source without I01");
  if (v.name === "clean" && codes.has("DJZS-I01")) bad("I01 on clean sources");
}
console.log(`LF engine integrity · ${total.toLocaleString()} inputs (${3 ** n} states × ${VARIANTS.length} variants) · verdicts: ${JSON.stringify(verdictCounts)}`);
if (fails.length) { console.error(`FAIL — ${fails.length}${fails.length >= 25 ? "+" : ""} invariant violations:\n  ` + fails.join("\n  ")); process.exit(1); }
console.log("PASS — every invariant holds across the full perp verdict space (LF-v1.2)");
