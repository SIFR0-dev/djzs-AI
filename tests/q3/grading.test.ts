/** Q3 grading readiness — SCAN_SPEC §8G (closed Polymarket markets), §8H (v1.12 absence re-check), §8I (volume_total
 *  drift rule and the sealed Kalshi fill list). Offline fixtures for every branch; ONE live assertion against a
 *  long-resolved Polymarket market, which proves the grader reads a closed market from the real venue. A network
 *  failure on the live check is reported as not exercised and never counted as passing. No key, no writes. */
import { readFileSync } from "node:fs";
import { canonical, sha256hex, strip, classifyVolumeTotalDrift, PHASE_A_EXCLUDE, PHASE_B_EXCLUDE } from "./lib";
import { gradeKalshi, gradePolymarket, gradeRecord, applyAbsenceRecheck } from "./q3-grade";
import { validateAbsenceRecheck } from "./absence-recheck";
import { kalshiVolumes, encodeFills, decodeFills, fillsDigest, sumFillsBefore, diffFills, type KalshiFill } from "./kalshi-client";

let fails = 0, ran = 0, unexercised = 0;
function eq(got: unknown, want: unknown, what: string) {
  ran++; const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL ${what}\n       got ${g} want ${w}`); }
}
const ok = (cond: boolean, what: string, detail: unknown = "") => eq(cond, true, `${what}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const NOW = "2026-09-17T18:30:00.000Z";
const book = JSON.parse(readFileSync("tests/q3/records/2026-09-14.json", "utf8")) as Record<string, any>[];
const rec = (id: string) => clone(book.find(r => r.id === id)!);

console.log("GRADING · Polymarket — Gamma partitions /markets on `closed` (§8G)");
{
  const resolvedYes = { slug: "done-yes", closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes", "No"]', outcomePrices: '["1", "0"]' };
  const proposed = { slug: "done-proposed", closed: true, umaResolutionStatus: "proposed", outcomePrices: '["1", "0"]', outcomes: '["Yes", "No"]' };
  const open = { slug: "still-open", closed: false, outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]' };
  const urls: string[] = [];
  // Behaves as live Gamma was observed to: closed=true → closed markets only; no parameter → open markets only.
  const gamma = (async (u: string) => { urls.push(u); const q = new URL(u); const slug = q.searchParams.get("slug"); const wantClosed = q.searchParams.get("closed") === "true";
    if (slug === "boom") return json({ error: "x" }, 500);
    return json([resolvedYes, proposed, open].filter(m => m.slug === slug && m.closed === wantClosed)); }) as typeof fetch;
  const pm = (slug: string, side = "YES") => ({ market: { venue: "polymarket", ticker: slug, side } });
  urls.length = 0; let r = await gradePolymarket(pm("done-yes"), NOW, gamma);
  eq(r.out && [r.out.result, r.out.settled_value, r.out.grader, r.out.graded_at], ["CORRECT", "YES", "auto:polymarket", NOW], "resolved closed market, side YES → CORRECT");
  ok(urls[0]?.includes("&closed=true"), "first lookup asks closed=true — the default-only query is the §8G defect", urls[0]);
  eq((await gradePolymarket(pm("done-yes", "NO"), NOW, gamma)).out?.result, "INCORRECT", "side NO on a YES resolution → INCORRECT");
  eq((await gradePolymarket(pm("still-open"), NOW, gamma)).skip, "polymarket market not closed", "open market → skip, not 'not found'");
  eq((await gradePolymarket(pm("nope"), NOW, gamma)).skip, "polymarket slug nope not found (open or closed)", "unknown slug → not found after asking both partitions");
  const p = await gradePolymarket(pm("done-proposed"), NOW, gamma);
  ok(!p.out && /not resolved/.test(p.skip ?? "") && /not graded from price/.test(p.skip ?? ""), "closed but unresolved, prices [1,0] → skip, never graded from price", p.skip);
  eq((await gradePolymarket(pm("boom"), NOW, gamma)).skip, "polymarket HTTP 500", "HTTP error → skip");
}

console.log("GRADING · Kalshi — unchanged behaviour");
{
  const k = (status: string, result: string) => (async () => json({ market: { status, result } })) as typeof fetch;
  const km = { market: { venue: "kalshi", ticker: "KX-TEST", side: "YES" } };
  eq((await gradeKalshi(km, NOW, k("finalized", "yes"))).out?.result, "CORRECT", "finalized yes, side YES → CORRECT");
  eq((await gradeKalshi(km, NOW, k("finalized", "no"))).out?.result, "INCORRECT", "finalized no, side YES → INCORRECT");
  eq((await gradeKalshi(km, NOW, k("active", ""))).skip, "kalshi status active — not yet settled", "active → skip");
  eq((await gradeKalshi(km, NOW, (async () => json({}, 404)) as typeof fetch)).skip, "kalshi ticker KX-TEST not found — grade manually with evidence", "404 → manual");
}

console.log("GRADING · v1.12 absence re-check validator (§8H)");
{
  const r = rec("q3-2026-09-14-002");
  const valid = () => ({ sources_consulted: ["a source"], queries: [...r.search_record.queries], window: { from: r.posted_at, to: "2026-09-16T18:00:00Z" }, searched_at: "2026-09-17T18:10:00Z", finding: "absence_holds", judgement: "No forecast of a move larger than 25bp located." });
  eq(validateAbsenceRecheck(r, valid(), NOW), [], "valid re-check passes");
  eq(validateAbsenceRecheck(r, { ...valid(), queries: [...r.search_record.queries, "an extra query"] }, NOW), [], "extra queries are allowed");
  const bad = (what: string, c: unknown, re: RegExp) => { const e = validateAbsenceRecheck(r, c, NOW); ok(e.some(x => re.test(x)), what, e); };
  bad("missing re-check", undefined, /missing/);
  bad("empty sources", { ...valid(), sources_consulted: [] }, /sources_consulted/);
  bad("a sealed query dropped", { ...valid(), queries: r.search_record.queries.slice(1) }, /re-run every sealed/);
  bad("window starts after posted_at", { ...valid(), window: { from: "2026-09-15T00:00:00Z", to: "2026-09-16T18:00:00Z" } }, /after posted_at/);
  bad("window ends before resolution_due", { ...valid(), window: { from: r.posted_at, to: "2026-09-16T12:00:00Z" } }, /before market.resolution_due/);
  bad("searched before resolution_due", { ...valid(), searched_at: "2026-09-16T10:00:00Z" }, /window had not elapsed/);
  bad("searched after graded_at", { ...valid(), searched_at: "2026-09-18T00:00:00Z" }, /must precede the grade/);
  bad("unparseable searched_at", { ...valid(), searched_at: "tomorrow" }, /parseable/);
  bad("finding outside the enum", { ...valid(), finding: "maybe" }, /finding must be/);
  bad("judgement missing", { ...valid(), judgement: " " }, /judgement/);
  const thesis = rec("q3-2026-09-14-001");
  ok(validateAbsenceRecheck(thesis, valid(), NOW).some(x => /does not apply/.test(x)), "a record WITH a thesis refuses a re-check (mislabel guard)");
}

console.log("GRADING · gradeRecord — v1.12 gate, grade_due gate, never retrofitted");
{
  const kalshiFinal = (result: string) => (async () => json({ market: { status: "finalized", result } })) as typeof fetch;
  const r = rec("q3-2026-09-14-002");
  const c = { sources_consulted: ["a source"], queries: [...r.search_record.queries], window: { from: r.posted_at, to: "2026-09-16T18:00:00Z" }, searched_at: "2026-09-17T18:10:00Z", finding: "absence_holds", judgement: "none located" };
  eq(await gradeRecord(r, { now: "2026-09-17T17:59:59.000Z", fetchImpl: kalshiFinal("no") }), null, "before grade_due → not graded at all");
  const noCheck = await gradeRecord(r, { now: NOW, fetchImpl: kalshiFinal("no") });
  ok(!noCheck?.out && /v1\.12 absence re-check required/.test(noCheck?.skip ?? ""), "no_public_case without --recheck → skipped, not graded", noCheck?.skip);
  const g = await gradeRecord(r, { now: NOW, fetchImpl: kalshiFinal("no"), rechecks: { [r.id]: c } });
  eq(g?.out && [g.out.result, g.out.absence_recheck?.finding, g.out.note], ["INCORRECT", "absence_holds", "v1.12 absence re-check: absence holds through market.resolution_due"], "with a valid re-check → graded, re-check attached under outcome");
  const emerged = applyAbsenceRecheck(r, { out: { result: "INCORRECT" } }, { [r.id]: { ...c, finding: "case_emerged" } }, NOW);
  ok(/graded as sealed, noted here, never retrofitted/.test(emerged.out?.note ?? ""), "case_emerged is noted, the grade stands as sealed", emerged.out?.note);
  // Never retrofitted, proven: attach the outcome and recompute both sealed hashes from the record as it would be saved.
  const before = clone(r); const after = clone(r); after.outcome = g!.out; const saved = JSON.parse(JSON.stringify(after));
  eq(sha256hex(canonical(strip(saved, PHASE_A_EXCLUDE))), before.phase_a_hash, "phase_a_hash recomputes unchanged after grading");
  eq(sha256hex(canonical(strip(saved, PHASE_B_EXCLUDE))), before.record_hash, "record_hash recomputes unchanged after grading");
  const { outcome: _a, ...restAfter } = saved; const { outcome: _b, ...restBefore } = before;
  eq(canonical(restAfter), canonical(restBefore), "every non-outcome field byte-identical after grading");
  const t = await gradeRecord(rec("q3-2026-09-14-001"), { now: NOW, fetchImpl: kalshiFinal("no") });
  ok(!!t?.out && t.out.absence_recheck === undefined, "a thesis record grades without a re-check and carries none");
}

console.log("GRADING · volume_total drift rule (§8I)");
{
  eq(classifyVolumeTotalDrift(100, 100, true).level, "match", "identical → match");
  // The four observations that prompted the ruling, 2026-09-17 (sealed → re-fetch).
  for (const [id, sealed, refetch] of [["001", 33554697.46999983, 33552721.15], ["003", 13750350.550000012, 13748931.07], ["004", 9183936.130000008, 9181389.68], ["005", 2701354.6799999904, 2696703.539999991]] as const) {
    eq(classifyVolumeTotalDrift(sealed, refetch, true).level, "warn", `observed ${id}: others reproduce, under 1% → warn`);
    eq(classifyVolumeTotalDrift(sealed, refetch, false).level, "fail", `observed ${id}: another field failed → fail`);
  }
  eq(classifyVolumeTotalDrift(1_000_000, 990_100, true).level, "warn", "0.99% → warn");
  eq(classifyVolumeTotalDrift(1_000_000, 990_000, true).level, "fail", "exactly 1% → fail (the rule is strictly under)");
  eq(classifyVolumeTotalDrift(1_000_000, 1_015_000, true).level, "fail", "1.5% upward → fail");
  eq(classifyVolumeTotalDrift(0, 5, true).level, "fail", "sealed 0 has no relative delta → fail");
}

console.log("GRADING · sealed Kalshi fill list (§8I)");
{
  const f = (id: string, t: string, n: number): KalshiFill => ({ trade_id: id, ticker: "KX-T", created_time: t, count_fp: String(n), yes_price_dollars: "0.5000", no_price_dollars: "0.5000", taker_side: "yes" });
  const end = "2026-09-14T19:40:00Z", endTs = Date.parse(end) / 1000;
  const fills = [f("c", "2026-09-14T19:40:00Z", 7), f("b", "2026-09-14T10:00:00Z", 3), f("a", "2026-09-12T10:00:00Z", 2)];
  const { fills: back, sha256 } = decodeFills(encodeFills(fills));
  eq(back, JSON.parse(canonical(fills)), "gzip round-trip preserves the list in feed order");
  eq(sha256, fillsDigest(fills), "digest is over the decompressed canonical bytes");
  eq(sumFillsBefore(fills, endTs), 5, "a fill AT posted_at is excluded, as kalshiVolumes excludes it");
  const pages = [{ trades: fills.slice(0, 2), cursor: "p2" }, { trades: fills.slice(2) }]; let i = 0;
  const kv = await kalshiVolumes("KX-T", end, (async () => json(pages[i++])) as typeof fetch, 400, true, true);
  eq([kv.volume_total, kv.fill_list?.length], [sumFillsBefore(fills, endTs), 3], "kalshiVolumes returns the walked list and it sums to volume_total");
  const refetch = [f("b", "2026-09-14T10:00:00Z", 4), f("d", "2026-09-13T10:00:00Z", 1)];
  eq(diffFills(fills, refetch, endTs), { missing: 1, missingQty: 2, added: 1, addedQty: 1, resized: 1, resizedQty: 1 }, "diff names missing, added and resized fills");
}

async function live() {
  console.log("GRADING · live — a known-closed Polymarket market is graded from the venue (§8G)");
  const known = { market: { venue: "polymarket", ticker: "will-donald-trump-win-the-2024-us-presidential-election", side: "YES" } };
  let r;
  try { r = await gradePolymarket(known, NOW); } catch (e) { unexercised++; console.log(`  NOT EXERCISED  gamma unreachable: ${(e as Error).message} — network, not a grading failure`); return; }
  if (r.skip && /HTTP (429|5\d\d)/.test(r.skip)) { unexercised++; console.log(`  NOT EXERCISED  ${r.skip} — venue unavailable, not a grading failure`); return; }
  eq(r.out && [r.out.result, r.out.settled_value, r.out.grader], ["CORRECT", "YES", "auto:polymarket"], `known-closed market resolved Yes → CORRECT${r.skip ? ` (skip: ${r.skip})` : ""}`);
}

live().then(() => {
  const tail = unexercised ? ` · ${unexercised} NOT EXERCISED (see above — not counted as passing)` : "";
  console.log(fails ? `GRADING · ${fails}/${ran} FAILED${tail}` : `GRADING · ${ran}/${ran} assertions pass${tail}`);
  process.exit(fails ? 1 : 0);
});
