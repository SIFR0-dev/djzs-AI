/** Q3 grading readiness — SCAN_SPEC §8G (closed Polymarket markets), §8H (v1.12 absence re-check), §8I (volume_total
 *  drift rule and the sealed Kalshi fill list). Offline fixtures for every branch; ONE live assertion against a
 *  long-resolved Polymarket market, which proves the grader reads a closed market from the real venue. A network
 *  failure on the live check is reported as not exercised and never counted as passing. No key, no writes. */
import { readFileSync } from "node:fs";
import { canonical, sha256hex, strip, classifyVolumeTotalDrift, PHASE_A_EXCLUDE, PHASE_B_EXCLUDE } from "./lib";
import { gradeKalshi, gradePolymarket, gradeRecord, applyAbsenceRecheck } from "./q3-grade";
import { validateAbsenceRecheck } from "./absence-recheck";
import { kalshiVolumes, kalshiVwap, kalshiRetryDelayMs, KALSHI_429_TRIES, encodeFills, decodeFills, fillsDigest, sumFillsBefore, diffFills, type KalshiFill } from "./kalshi-client";

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
  // The record as sealed, outcome removed: once a record is graded in the file, gradeRecord returns null for it.
  const { outcome: _graded, ...ungradedThesis } = rec("q3-2026-09-14-001");
  const t = await gradeRecord(ungradedThesis as any, { now: NOW, fetchImpl: kalshiFinal("no") });
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
  // Two-tier client (2026-11-09): this fixture's whole history sits in the live tier; the historical tier is empty.
  const kv = await kalshiVolumes("KX-T", end, (async (u: string) => new URL(u).pathname.includes("/historical/") ? json({ cursor: "", trades: [] }) : json(pages[i++])) as typeof fetch, 400, true, true);
  eq([kv.volume_total, kv.fill_list?.length], [sumFillsBefore(fills, endTs), 3], "kalshiVolumes returns the walked list and it sums to volume_total");
  const refetch = [f("b", "2026-09-14T10:00:00Z", 4), f("d", "2026-09-13T10:00:00Z", 1)];
  eq(diffFills(fills, refetch, endTs), { missing: 1, missingQty: 2, added: 1, addedQty: 1, resized: 1, resizedQty: 1 }, "diff names missing, added and resized fills");
}

console.log("GRADING · Kalshi trades span a live and a historical tier — read both, one fill per trade_id (2026-11-09)");
{
  // Instrument: run #233 FAILed q3-2026-09-14-004 at -62% because the client read only the live tier, which no longer
  // served fills before the venue's archive cutoff. The union of both tiers reproduced the sealed total to +0.45%.
  const f = (id: string, t: string, n: number, yes = "0.5000"): KalshiFill => ({ trade_id: id, ticker: "KX-T", created_time: t, count_fp: String(n), yes_price_dollars: yes, no_price_dollars: (1 - Number(yes)).toFixed(4), taker_side: "yes" });
  const end = "2026-09-14T19:40:00Z";
  const newer = f("n1", "2026-09-14T19:00:00Z", 5), mid = f("m1", "2026-09-09T12:00:00Z", 3), old1 = f("o1", "2026-08-01T00:00:00Z", 11), old2 = f("o2", "2026-02-01T00:00:00Z", 7);
  type Served = Partial<Record<"live" | "historical", KalshiFill[][]>>;
  // Pages by tier; the cursor is the next page index. A tier absent from `srv` answers 404, as /historical/trades does
  // for a ticker it does not know.
  const tierFetch = (srv: Served, log: string[] = []) => (async (u: string) => {
    const url = new URL(u); const tier = url.pathname.includes("/historical/") ? "historical" : "live"; log.push(tier);
    const pgs = srv[tier]; if (!pgs) return json({ error: { code: "not_found", message: "not found" } }, 404);
    const p = Number(url.searchParams.get("cursor") ?? 0); return json({ trades: pgs[p] ?? [], cursor: p + 1 < pgs.length ? String(p + 1) : "" });
  }) as typeof fetch;
  // The buffered hand-off: `mid` is served by BOTH tiers, byte-identical; the old fills only by the historical tier.
  const served: Served = { live: [[newer, mid]], historical: [[mid, old1], [old2]] };
  const log: string[] = [];
  const kv = await kalshiVolumes("KX-T", end, tierFetch(served, log), 400, true, true);
  eq(kv.volume_total, 5 + 3 + 11 + 7, "volume_total is the union of both tiers, the overlapping fill counted once");
  eq([kv.fills, kv.tiers?.live.fills, kv.tiers?.historical.fills, kv.tiers?.overlap], [4, 2, 3, 1], "tier stats: 2 live + 3 historical, 1 in both, 4 unique");
  const liveOnly = await kalshiVolumes("KX-T", end, tierFetch({ live: served.live, historical: [[]] }), 400, true);
  eq(liveOnly.volume_total, 8, "the live tier alone undercounts (the pre-fix read, run #233's shape)");
  ok(log[0] === "live" && log.lastIndexOf("live") < log.indexOf("historical"), "live is walked to the end before historical starts", log);
  eq(kv.fill_list?.map(x => x.trade_id), ["n1", "m1", "o1", "o2"], "fill_list is newest-first across tiers");
  const resplit = await kalshiVolumes("KX-T", end, tierFetch({ live: [[newer]], historical: [[mid, old1, old2]] }), 400, true, true);
  eq(fillsDigest(resplit.fill_list!), fillsDigest(kv.fill_list!), "the same fills split differently across tiers serialise identically (same digest)");
  const dupe = await kalshiVolumes("KX-T", end, tierFetch({ live: [[newer, newer]], historical: [[]] }), 400, true);
  eq([dupe.fills, dupe.volume_total], [1, 5], "an identical repeated trade_id is one fill");

  const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => { try { await p; ok(false, what, "resolved"); } catch (e) { ok(re.test((e as Error).message), what, (e as Error).message); } };
  await rejects(kalshiVolumes("KX-T", end, tierFetch({ live: served.live, historical: [[{ ...mid, count_fp: "4" }, old1]] }), 400, true), /different content/, "a trade_id served with different sizes by the two tiers throws, never picks one");
  await rejects(kalshiVolumes("KX-T", end, tierFetch({ live: served.live }), 400, true), /HTTP 404 \(historical tier\)/, "a failing historical tier throws: a live-only sum is never returned as the total");
  await rejects(kalshiVolumes("KX-T", end, tierFetch({ historical: served.historical }), 400, true), /HTTP 404 \(live tier\)/, "a failing live tier throws");
  const cut = await kalshiVolumes("KX-T", end, tierFetch(served), 1, true);
  eq([cut.truncated, cut.volume_total], [true, null], "the page budget is per tier, and a truncated historical walk refuses the total");

  // VWAP: a 60-min window whose fills are split across the tiers, one of them in both.
  const w1 = f("w1", "2026-09-14T19:10:00Z", 5, "0.2000"), w2 = f("w2", "2026-09-14T19:00:00Z", 5, "0.3000"), w3 = f("w3", "2026-09-14T18:50:00Z", 10, "0.5000");
  const k = await kalshiVwap("KX-T", "yes", end, 60, tierFetch({ live: [[w1, w2]], historical: [[w2, w3]] }));
  eq([k.trade_count, k.contracts, k.vwap?.toFixed(6)], [3, 20, "0.375000"], "VWAP and trade_count read both tiers, the shared fill once");

  // HTTP 429: bounded retry, 429 only. `Retry-After: 0` keeps the offline suite from sleeping.
  eq(KALSHI_429_TRIES, 3, "at most 3 requests per page");
  const now = Date.parse("2026-11-09T12:00:00Z");
  eq([kalshiRetryDelayMs(1, null), kalshiRetryDelayMs(2, null), kalshiRetryDelayMs(5, null)], [1000, 2000, 10000], "no Retry-After: 1s, 2s, then capped at 10s");
  eq([kalshiRetryDelayMs(1, "3"), kalshiRetryDelayMs(1, "0"), kalshiRetryDelayMs(1, "120")], [3000, 0, 10000], "Retry-After seconds win, capped at 10s");
  eq([kalshiRetryDelayMs(1, new Date(now + 5000).toUTCString(), now), kalshiRetryDelayMs(1, new Date(now - 5000).toUTCString(), now)], [5000, 0], "Retry-After HTTP-date: time until it, never negative");
  eq(kalshiRetryDelayMs(2, "soon"), 2000, "an unparseable Retry-After falls back to the exponential wait");
  // Wraps tierFetch: the first `n` requests to `tier` answer `status` (Retry-After: 0); `calls` counts every request.
  const flaky = (inner: typeof fetch, tier: "live" | "historical", n: number, status = 429, calls: string[] = []) => (async (u: string) => {
    const t = new URL(u).pathname.includes("/historical/") ? "historical" : "live"; calls.push(t);
    if (t === tier && n > 0) { n--; return new Response(JSON.stringify({ error: { code: "too_many_requests" } }), { status, headers: { "retry-after": "0" } }); }
    return inner(u);
  }) as typeof fetch;
  const c1: string[] = [];
  const healed = await kalshiVolumes("KX-T", end, flaky(tierFetch(served), "historical", 2, 429, c1), 400, true);
  eq([healed.volume_total, healed.tiers?.historical.pages, c1.filter(x => x === "historical").length], [26, 2, 4], "two 429s then 200: same total, retries not counted as pages (2 pages, 4 requests)");
  const c2: string[] = [];
  await rejects(kalshiVolumes("KX-T", end, flaky(tierFetch(served), "live", 99, 429, c2), 400, true), /HTTP 429 \(live tier\) after 3 tries/, "still 429 on the 3rd try: throws, never a partial total");
  eq(c2.length, 3, "exactly 3 requests before giving up, and the historical tier is never reached");
  const c3: string[] = [];
  await rejects(kalshiVolumes("KX-T", end, flaky(tierFetch(served), "live", 1, 503, c3), 400, true), /HTTP 503 \(live tier\)$/, "any other non-2xx is not retried");
  eq(c3.length, 1, "a 503 costs exactly one request");
  const c4: string[] = [];
  await rejects(kalshiVwap("KX-T", "yes", end, 60, flaky(tierFetch({ live: [[w1, w2]], historical: [[w2, w3]] }), "historical", 3, 429, c4)), /HTTP 429 \(historical tier\) after 3 tries/, "the price path (kalshiVwap) gets the same bounded retry");
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
