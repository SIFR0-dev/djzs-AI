/**
 * LF-v1.3 parity proof (CLAUDE.md §5): every engine input on both sides of the change, compared hash by hash.
 *
 *   dump     run it with a checkout as the working directory; it loads THAT checkout's engine
 *              (cd <base checkout> && npx tsx <path to this file> dump base.json)
 *              (cd <head checkout> && npx tsx <path to this file> dump head.json)
 *   compare  npx tsx tests/lf-v1.3-parity.ts compare base.json head.json
 *
 * Space: the PM enumeration of tests/pm-engine-integrity.ts (108 inputs, including legacy inputs with no
 * edge_claim key) and the LF enumeration of tests/lf-engine-integrity.ts (3^9 states x 4 variants: clean,
 * social, social alias, unverified oracle). compare exits 1 unless every PM verdict_hash is byte-identical,
 * every unknown-field list is unchanged, and every LF difference is one of the two intended changes:
 *   RUNG   base WAIT -> head PASS with the same codes: all non-critical, under 50, on a bounded input with a
 *          present thesis and at least one unknown field (an advisory flag now rides the PASS).
 *   ALIAS  social-alias variant only: head adds DJZS-I01 (a whole-word social source such as "CT") and the
 *          score rises by its weight, 16; the verdict is unchanged unless RUNG explains the change.
 * No network, no model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type S = "present" | "absent" | "unknown";
type Row = { verdict: string; risk: number; codes: string[]; unknown: string[]; hash: string };
const STATES: S[] = ["present", "absent", "unknown"];
const VALUES: Record<string, unknown> = { leverage: 10, position_size: 3000, stop_loss: 79800, take_profit: 73000, invalidation_condition: "hike delivered and BTC > 82K", data_sources: ["Binance funding"], oracle_source: "Binance mark price", confidence: 60, thesis_statement: "funding is extreme and 82K rejected four times" };
const VARIANTS: { name: string; over: Record<string, unknown> }[] = [
  { name: "clean", over: {} },
  { name: "social", over: { data_sources: ["twitter"] } },
  { name: "social-alias", over: { data_sources: ["CT", "Reddit threads"] } },
  { name: "unverified-oracle", over: { oracle_source: "the team's dashboard" } },
];
const CRITICAL = new Set(["DJZS-X01", "DJZS-S01"]); // the live LF codes of CRITICAL severity
const I01_WEIGHT = 16;

const f = (s: S, v: unknown) => (s === "present" ? { state: "present", value: v } : { state: s });
function lfStates(fields: readonly string[], k: number): Record<string, S> {
  const st: Record<string, S> = {}; let x = k;
  for (const field of fields) { st[field] = STATES[x % 3]; x = Math.floor(x / 3); }
  return st;
}

async function dump(out: string) {
  const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
  const { runDeterministicAudit } = await load("server/engine-v2/deterministic-engine.ts");
  const { AUDIT_FIELDS } = await load("server/engine-v2/audit-input-schema.ts");
  const rows: Record<string, Row> = {};
  const keep = (id: string, r: any) => { rows[id] = { verdict: r.verdict, risk: r.risk_score, codes: r.flags.map((x: any) => x.code).sort(), unknown: [...r.unknown_fields], hash: r.verdict_hash }; };
  for (const inv of STATES) for (const res of STATES) for (const prob of STATES) for (const edge of [...STATES, "omitted"] as const) {
    const b: any = { agent_type: "t", intended_action: "bet", audit_context: "prediction_market",
      leverage: { state: "absent" }, position_size: { state: "present", value: 250 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
      invalidation_condition: f(inv, "x"), resolution_engagement: f(res, "y"), probability_basis: f(prob, "z"),
      data_sources: { state: "present", value: ["c"] }, oracle_source: { state: "present", value: "k" }, confidence: { state: "absent" } };
    if (edge !== "omitted") b.edge_claim = f(edge as S, "e");
    keep(`pm ${inv}/${res}/${prob}/${edge}`, runDeterministicAudit(b));
  }
  for (const v of VARIANTS) for (let k = 0; k < 3 ** AUDIT_FIELDS.length; k++) {
    const st = lfStates(AUDIT_FIELDS, k);
    const input: any = { agent_type: "t", intended_action: "open", audit_context: "perp", market_type: "perp", resolution_engagement: { state: "unknown" }, probability_basis: { state: "unknown" }, edge_claim: { state: "unknown" } };
    for (const field of AUDIT_FIELDS) input[field] = f(st[field], (v.over as any)[field] ?? VALUES[field]);
    keep(`lf ${v.name}#${k}`, runDeterministicAudit(input));
  }
  writeFileSync(out, JSON.stringify({ cwd: process.cwd(), fields: AUDIT_FIELDS, rows }));
  console.log(`dumped ${Object.keys(rows).length} inputs from ${process.cwd()} -> ${out}`);
}

function compare(aPath: string, bPath: string) {
  const A = JSON.parse(readFileSync(aPath, "utf8")), B = JSON.parse(readFileSync(bPath, "utf8"));
  const fields: string[] = B.fields;
  if (JSON.stringify(A.fields) !== JSON.stringify(fields)) { console.error("FAIL: the two checkouts enumerate different AUDIT_FIELDS"); process.exit(1); }
  const keys = Object.keys(B.rows);
  if (keys.length !== Object.keys(A.rows).length || keys.some((k) => !(k in A.rows))) { console.error("FAIL: the two dumps cover different inputs"); process.exit(1); }
  const n = { pm: 0, pmSame: 0, lf: 0, lfSame: 0, rung: 0, alias: 0 }; const bad: string[] = [];
  const nonCriticalUnder50 = (r: Row) => r.codes.every((c) => !CRITICAL.has(c)) && r.risk < 50;
  for (const key of keys) {
    const a: Row = A.rows[key], b: Row = B.rows[key];
    const pm = key.startsWith("pm ");
    if (pm) n.pm++; else n.lf++;
    if (a.hash === b.hash) { if (pm) n.pmSame++; else n.lfSame++; continue; }
    if (pm) { bad.push(`${key}: PM hash moved ${a.verdict} ${a.hash.slice(0, 12)} -> ${b.verdict} ${b.hash.slice(0, 12)}`); continue; }
    if (JSON.stringify(a.unknown) !== JSON.stringify(b.unknown)) { bad.push(`${key}: unknown fields changed`); continue; }
    const [variant, kStr] = key.slice(3).split("#");
    const st = lfStates(fields, Number(kStr));
    const boundedWithThesis = (st.stop_loss === "present" || st.invalidation_condition === "present") && st.thesis_statement === "present";
    const rung = a.verdict === "WAIT" && b.verdict === "PASS" && boundedWithThesis && b.codes.length > 0 && nonCriticalUnder50(b) && a.unknown.length > 0;
    const sameCodes = JSON.stringify(a.codes) === JSON.stringify(b.codes);
    const addedI01 = variant === "social-alias" && !a.codes.includes("DJZS-I01") && JSON.stringify([...a.codes, "DJZS-I01"].sort()) === JSON.stringify(b.codes) && b.risk === a.risk + I01_WEIGHT;
    if (sameCodes && rung) n.rung++;
    else if (addedI01 && (a.verdict === b.verdict || rung)) n.alias++;
    else bad.push(`${key} [${fields.map((x) => x + "=" + st[x][0]).join(" ")}]: ${a.verdict} ${a.risk} [${a.codes}] -> ${b.verdict} ${b.risk} [${b.codes}]`);
  }
  console.log(`PM  ${n.pm} inputs · ${n.pmSame} verdict_hash byte-identical`);
  console.log(`LF  ${n.lf} inputs · ${n.lfSame} byte-identical · ${n.rung} RUNG (WAIT -> PASS, same codes) · ${n.alias} ALIAS (I01 added on a whole-word social source)`);
  if (bad.length) { console.error(`FAIL — ${bad.length} unexplained difference(s):\n  ` + bad.slice(0, 25).join("\n  ")); process.exit(1); }
  console.log("PASS — every difference is one of the two intended LF-v1.3 changes; PM hashes unchanged");
}

const [mode, x, y] = process.argv.slice(2);
if (mode === "dump" && x) await dump(x);
else if (mode === "compare" && x && y) compare(x, y);
else { console.error("usage: dump <out.json>  |  compare <base.json> <head.json>"); process.exit(2); }
