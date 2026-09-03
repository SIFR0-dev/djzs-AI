/**
 * Q3 grader. Writes `outcome` on sealed records whose grade_due has passed. Never before. Never on unsealed records.
 *   npx tsx tests/q3/q3-grade.ts                       # auto: kalshi (finalized→result), polymarket (best-effort); series → left for manual
 *   npx tsx tests/q3/q3-grade.ts --dry                 # show what would be graded, write nothing
 *   npx tsx tests/q3/q3-grade.ts --manual <id> CORRECT|INCORRECT|VOID --evidence <url> [--note "..."]
 * Grading is against `criterion` as written: CORRECT iff the venue settled the audited side. Anything unresolvable → skipped, not guessed.
 * outcome is outside record_hash by design (PHASE_B_EXCLUDE), so grading never disturbs the pre-registration hashes.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
const REC_DIR = "tests/q3/records"; const args = process.argv.slice(2); const DRY = args.includes("--dry");
const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
type Rec = Record<string, any>;
const days = () => existsSync(REC_DIR) ? readdirSync(REC_DIR).filter(f => f.endsWith(".json")).sort() : [];
const load = (f: string) => JSON.parse(readFileSync(`${REC_DIR}/${f}`, "utf8")) as Rec[];
const save = (f: string, recs: Rec[]) => writeFileSync(`${REC_DIR}/${f}`, JSON.stringify(recs, null, 2) + "\n");
const now = new Date().toISOString();
const outcome = (result: string, settled_value: string | null, evidence_url: string, grader: string, note: string | null = null) => ({ result, settled_value, evidence_url, graded_at: now, grader, note });

async function gradeKalshi(r: Rec) {
  const t = r.market.ticker; const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t)}`);
  if (res.status === 404) return { skip: `kalshi ticker ${t} not found — grade manually with evidence` };
  if (!res.ok) return { skip: `kalshi HTTP ${res.status}` };
  const m = (await res.json() as any).market; const url = `https://kalshi.com/markets/${t.toLowerCase()}`;
  if (m.status === "finalized" || m.status === "settled") {
    const won = String(m.result).toLowerCase(); if (won !== "yes" && won !== "no") return { skip: `kalshi result '${m.result}' unrecognized` };
    const side = String(r.market.side).toLowerCase(); return { out: outcome(won === side ? "CORRECT" : "INCORRECT", won.toUpperCase(), url, "auto:kalshi") };
  }
  if (["cancelled", "canceled", "voided"].includes(String(m.status))) return { out: outcome("VOID", null, url, "auto:kalshi", `market ${m.status}`) };
  return { skip: `kalshi status ${m.status} — not yet settled` };
}
async function gradePolymarket(r: Rec) {
  const slug = String(r.market.ticker).replace(/^polymarket:/, ""); const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return { skip: `polymarket HTTP ${res.status}` }; const arr = await res.json() as any[]; const m = arr?.[0]; if (!m) return { skip: `polymarket slug ${slug} not found` };
  if (!m.closed) return { skip: "polymarket market not closed" };
  let outcomes: string[] = [], prices: number[] = []; try { outcomes = JSON.parse(m.outcomes); prices = JSON.parse(m.outcomePrices).map(Number); } catch { return { skip: "polymarket outcome fields unparsable" }; }
  const winners = prices.map((p, i) => p >= 0.99 ? i : -1).filter(i => i >= 0); if (winners.length !== 1) return { skip: `polymarket resolution ambiguous (prices ${JSON.stringify(prices)}) — grade manually` };
  const won = String(outcomes[winners[0]]).toUpperCase(); const side = String(r.market.side).toUpperCase(); const url = `https://polymarket.com/event/${slug}`;
  return { out: outcome(won === side ? "CORRECT" : "INCORRECT", won, url, "auto:polymarket") };
}

(async () => {
  if (flag("--manual")) {
    const id = flag("--manual")!, result = args[args.indexOf("--manual") + 2], evidence = flag("--evidence"), note = flag("--note") ?? null;
    if (!["CORRECT", "INCORRECT", "VOID"].includes(result)) { console.error("result must be CORRECT|INCORRECT|VOID"); process.exit(1); }
    if (!evidence || !/^https?:\/\//.test(evidence)) { console.error("--evidence <url> is required for manual grades"); process.exit(1); }
    for (const f of days()) { const recs = load(f); const r = recs.find(x => x.id === id); if (!r) continue;
      if (!r.record_hash) { console.error("refused: record not sealed"); process.exit(1); } if (r.outcome) { console.error("refused: already graded"); process.exit(1); }
      if (now < r.criterion.grade_due) { console.error(`refused: grade_due ${r.criterion.grade_due} not reached`); process.exit(1); }
      r.outcome = outcome(result, null, evidence, "dj", note); if (!DRY) save(f, recs); console.log(`${DRY ? "[dry] " : ""}graded ${id} → ${result} (manual, evidence recorded)   COMMIT.`); process.exit(0); }
    console.error(`no record ${id}`); process.exit(1);
  }
  let graded = 0, skipped = 0, pending = 0;
  for (const f of days()) { const recs = load(f); let dirty = false;
    for (const r of recs) {
      if (!r.record_hash || r.outcome) continue; if (now < r.criterion.grade_due) { pending++; continue; }
      const venue = r.market.venue; let res: { out?: any; skip?: string };
      if (r.binding?.type === "series") res = { skip: "series binding — manual grade with evidence" };
      else if (venue === "kalshi") res = await gradeKalshi(r); else if (venue === "polymarket") res = await gradePolymarket(r); else res = { skip: `venue ${venue} — manual` };
      if (res.out) { console.log(`${DRY ? "[dry] " : ""}${r.id} → ${res.out.result} (${res.out.grader}, settled ${res.out.settled_value})`); if (!DRY) { r.outcome = res.out; dirty = true; } graded++; }
      else { console.log(`${r.id}: skip — ${res.skip}`); skipped++; }
    }
    if (dirty) save(f, recs);
  }
  console.log(`\ngraded ${graded} · skipped ${skipped} (manual or unresolved) · pending ${pending} (grade_due not reached)${graded && !DRY ? "   COMMIT." : ""}`);
})();
