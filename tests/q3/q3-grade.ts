/**
 * Q3 grader. Writes `outcome` on sealed records whose grade_due has passed. Never before. Never on unsealed records.
 *   npx tsx tests/q3/q3-grade.ts [--recheck <file.json>]    # auto: kalshi (finalized→result), polymarket (resolved→payout); series → left for manual
 *   npx tsx tests/q3/q3-grade.ts --dry [--recheck <file>]   # show what would be graded, write nothing
 *   npx tsx tests/q3/q3-grade.ts --manual <id> CORRECT|INCORRECT|VOID --evidence <url> [--note "..."] [--recheck <file>]
 * Grading is against `criterion` as written: CORRECT iff the venue settled the audited side. Anything unresolvable → skipped, not guessed.
 * outcome is outside record_hash by design (PHASE_B_EXCLUDE), so grading never disturbs the pre-registration hashes.
 * v1.12: a no_public_case record is graded only with an absence re-check — `--recheck` is a JSON object keyed by record id,
 * each value validated by absence-recheck.ts and attached at outcome.absence_recheck (SCAN_SPEC §8H). Without a valid one
 * the record is skipped, not graded, so the owed re-check can never be silently missed.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { needsAbsenceRecheck, validateAbsenceRecheck, recheckNote, type AbsenceRecheck } from "./absence-recheck";
const REC_DIR = "tests/q3/records";
type Rec = Record<string, any>;
type Fetch = typeof fetch;
export type GradeResult = { out?: Rec; skip?: string };
const outcome = (result: string, settled_value: string | null, evidence_url: string, grader: string, graded_at: string, note: string | null = null): Rec => ({ result, settled_value, evidence_url, graded_at, grader, note });

export async function gradeKalshi(r: Rec, gradedAt: string, fetchImpl: Fetch = fetch): Promise<GradeResult> {
  const t = r.market.ticker; const res = await fetchImpl(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t)}`);
  if (res.status === 404) return { skip: `kalshi ticker ${t} not found — grade manually with evidence` };
  if (!res.ok) return { skip: `kalshi HTTP ${res.status}` };
  const m = (await res.json() as any).market; const url = `https://kalshi.com/markets/${t.toLowerCase()}`;
  if (m.status === "finalized" || m.status === "settled") {
    const won = String(m.result).toLowerCase(); if (won !== "yes" && won !== "no") return { skip: `kalshi result '${m.result}' unrecognized` };
    const side = String(r.market.side).toLowerCase(); return { out: outcome(won === side ? "CORRECT" : "INCORRECT", won.toUpperCase(), url, "auto:kalshi", gradedAt) };
  }
  if (["cancelled", "canceled", "voided"].includes(String(m.status))) return { out: outcome("VOID", null, url, "auto:kalshi", gradedAt, `market ${m.status}`) };
  return { skip: `kalshi status ${m.status} — not yet settled` };
}

/** Gamma's /markets PARTITIONS on `closed`: with no parameter it returns open markets only, and closed=true returns
 *  closed markets only (both observed live 2026-09-17 on a resolved 2024 market and an open 2026 one). The grader
 *  previously asked only the default, so every market it exists to grade — a closed one — came back as [] and was
 *  skipped as "not found". Ask closed first (the grading case), then open, so "not yet closed" and "no such slug" stay
 *  distinguishable. SCAN_SPEC §8G. */
export async function polymarketBySlug(slug: string, fetchImpl: Fetch = fetch): Promise<{ market?: Rec; error?: string }> {
  for (const closed of [true, false]) {
    const res = await fetchImpl(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}${closed ? "&closed=true" : ""}`);
    if (!res.ok) return { error: `polymarket HTTP ${res.status}` };
    const arr = await res.json() as any[]; if (Array.isArray(arr) && arr[0]) return { market: arr[0] };
  }
  return {};
}

export async function gradePolymarket(r: Rec, gradedAt: string, fetchImpl: Fetch = fetch): Promise<GradeResult> {
  const slug = String(r.market.ticker).replace(/^polymarket:/, "");
  const found = await polymarketBySlug(slug, fetchImpl); if (found.error) return { skip: found.error };
  const m = found.market; if (!m) return { skip: `polymarket slug ${slug} not found (open or closed)` };
  if (!m.closed) return { skip: "polymarket market not closed" };
  // Closed is not resolved: trading can stop before the oracle settles, and outcomePrices on such a market are the last
  // trades. Grade only on the venue's resolution, never on a price.
  if (m.umaResolutionStatus !== "resolved") return { skip: `polymarket market closed but not resolved (umaResolutionStatus ${JSON.stringify(m.umaResolutionStatus ?? null)}) — not graded from price` };
  let outcomes: string[] = [], prices: number[] = []; try { outcomes = JSON.parse(m.outcomes); prices = JSON.parse(m.outcomePrices).map(Number); } catch { return { skip: "polymarket outcome fields unparsable" }; }
  const winners = prices.map((p, i) => p >= 0.99 ? i : -1).filter(i => i >= 0); if (winners.length !== 1) return { skip: `polymarket resolution ambiguous (prices ${JSON.stringify(prices)}) — grade manually` };
  const won = String(outcomes[winners[0]]).toUpperCase(); const side = String(r.market.side).toUpperCase(); const url = `https://polymarket.com/event/${slug}`;
  return { out: outcome(won === side ? "CORRECT" : "INCORRECT", won, url, "auto:polymarket", gradedAt) };
}

/** v1.12 gate, applied to auto and manual grades alike. Attaches the re-check under the outcome (outside both hashes)
 *  or turns the grade into a skip naming what is missing. */
export function applyAbsenceRecheck(r: Rec, res: GradeResult, rechecks: Record<string, unknown>, gradedAt: string): GradeResult {
  if (!res.out || !needsAbsenceRecheck(r)) return res;
  const c = rechecks[r.id]; const errs = validateAbsenceRecheck(r, c, gradedAt);
  if (errs.length) return { skip: `v1.12 absence re-check required before grading a no_public_case record — ${errs.join("; ")}` };
  return { out: { ...res.out, note: recheckNote(c as AbsenceRecheck), absence_recheck: c } };
}

/** One record, auto path. Returns null when the record is not due or not gradable at all (unsealed, already graded). */
export async function gradeRecord(r: Rec, opts: { now: string; rechecks?: Record<string, unknown>; fetchImpl?: Fetch }): Promise<GradeResult | null> {
  if (!r.record_hash || r.outcome || opts.now < r.criterion.grade_due) return null;
  let res: GradeResult;
  if (r.binding?.type === "series") res = { skip: "series binding — manual grade with evidence" };
  else if (r.market.venue === "kalshi") res = await gradeKalshi(r, opts.now, opts.fetchImpl);
  else if (r.market.venue === "polymarket") res = await gradePolymarket(r, opts.now, opts.fetchImpl);
  else res = { skip: `venue ${r.market.venue} — manual` };
  return applyAbsenceRecheck(r, res, opts.rechecks ?? {}, opts.now);
}

async function main() {
  const args = process.argv.slice(2); const DRY = args.includes("--dry");
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const days = () => existsSync(REC_DIR) ? readdirSync(REC_DIR).filter(f => f.endsWith(".json")).sort() : [];
  const load = (f: string) => JSON.parse(readFileSync(`${REC_DIR}/${f}`, "utf8")) as Rec[];
  const save = (f: string, recs: Rec[]) => writeFileSync(`${REC_DIR}/${f}`, JSON.stringify(recs, null, 2) + "\n");
  const now = new Date().toISOString();
  const rechecks: Record<string, unknown> = flag("--recheck") ? JSON.parse(readFileSync(flag("--recheck")!, "utf8")) : {};
  if (flag("--manual")) {
    const id = flag("--manual")!, result = args[args.indexOf("--manual") + 2], evidence = flag("--evidence"), note = flag("--note") ?? null;
    if (!["CORRECT", "INCORRECT", "VOID"].includes(result)) { console.error("result must be CORRECT|INCORRECT|VOID"); process.exit(1); }
    if (!evidence || !/^https?:\/\//.test(evidence)) { console.error("--evidence <url> is required for manual grades"); process.exit(1); }
    for (const f of days()) { const recs = load(f); const r = recs.find(x => x.id === id); if (!r) continue;
      if (!r.record_hash) { console.error("refused: record not sealed"); process.exit(1); } if (r.outcome) { console.error("refused: already graded"); process.exit(1); }
      if (now < r.criterion.grade_due) { console.error(`refused: grade_due ${r.criterion.grade_due} not reached`); process.exit(1); }
      const res = applyAbsenceRecheck(r, { out: outcome(result, null, evidence, "dj", now, note) }, rechecks, now);
      if (!res.out) { console.error(`refused: ${res.skip}`); process.exit(1); }
      if (note && res.out.absence_recheck) res.out.note = `${note} · ${res.out.note}`;
      r.outcome = res.out; if (!DRY) save(f, recs); console.log(`${DRY ? "[dry] " : ""}graded ${id} → ${result} (manual, evidence recorded)   COMMIT.`); process.exit(0); }
    console.error(`no record ${id}`); process.exit(1);
  }
  let graded = 0, skipped = 0, pending = 0;
  for (const f of days()) { const recs = load(f); let dirty = false;
    for (const r of recs) {
      if (!r.record_hash || r.outcome) continue; if (now < r.criterion.grade_due) { pending++; continue; }
      const res = (await gradeRecord(r, { now, rechecks }))!;
      if (res.out) { console.log(`${DRY ? "[dry] " : ""}${r.id} → ${res.out.result} (${res.out.grader}, settled ${res.out.settled_value})${res.out.absence_recheck ? ` · v1.12 re-check ${res.out.absence_recheck.finding}` : ""}`); if (!DRY) { r.outcome = res.out; dirty = true; } graded++; }
      else { console.log(`${r.id}: skip — ${res.skip}`); skipped++; }
    }
    if (dirty) save(f, recs);
  }
  console.log(`\ngraded ${graded} · skipped ${skipped} (manual or unresolved) · pending ${pending} (grade_due not reached)${graded && !DRY ? "   COMMIT." : ""}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
