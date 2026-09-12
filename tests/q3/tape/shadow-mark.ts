/** Use 2 — daily marks for every open shadow position and stub. Separate ledger; never a Q3 record. Prices from the declared venue via Surf (1 credit per pair). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { surf, CFG, pct, journalCredits } from "./surf";
const book = JSON.parse(readFileSync("tests/q3/shadow-book.json", "utf8")); const today = new Date().toISOString().slice(0, 10);
/** Terminal entries are graded already: printed once from the book, never re-priced, and never a credit. */
const isClosed = (p: any) => !!p.closed; const isResolved = (s: any) => !!s.resolved;
/** Passed = strictly after the horizon date, so a horizon of D is still live when marking on D. A null horizon never passes. */
const horizonPassed = (h: unknown) => typeof h === "string" && today > h;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
const need = (cond: boolean, msg: string) => { if (!cond) throw new Error(`shadow-book: ${msg}`); };
/** Only live entries are priced — a closed position or resolved stub must not reach the tape. */
const pairs = new Set<string>([
  ...book.positions.filter((p: any) => !isClosed(p)).map((p: any) => p.pair),
  ...book.stubs.filter((s: any) => !isResolved(s) && s.watch?.pair).map((s: any) => s.watch.pair),
]);
const px: Record<string, any> = {};
for (const pair of pairs) { const r = surf("exchange-price", ["--exchange", CFG.declared_venue.exchange, "--pair", pair]); px[pair] = Array.isArray(r.data) ? r.data[0] : r.data; }
const marks: any[] = []; const lines: string[] = []; const gradeRequired: string[] = [];
lines.push(`SHADOW BOOK · ${today} · venue ${CFG.declared_venue.exchange}`);
for (const p of book.positions) {
  if (isClosed(p)) { // graded: read the close out of the book, never off today's tape
    need(typeof p.close_price === "number", `${p.id} is closed but has no numeric close_price`); need(!!p.grade, `${p.id} is closed but has no grade`);
    const ret = (p.side === "long" ? 1 : -1) * (p.close_price / p.entry - 1); const days = daysBetween(p.opened, p.closed);
    // The book may also state ret. It is derived, so close_price wins — but a real disagreement means one of the two is wrong; 1bp tolerates a rounded book value.
    need(typeof p.ret !== "number" || Math.abs(p.ret - ret) < 1e-4, `${p.id} states ret ${p.ret} but entry ${p.entry} → close_price ${p.close_price} gives ${ret.toFixed(6)}`);
    marks.push({ id: p.id, type: "position", state: "closed", pair: p.pair, side: p.side, entry: p.entry, closed: p.closed, close_price: p.close_price, ret, days, horizon: p.horizon ?? null, grade: p.grade });
    lines.push(`  ${p.id.padEnd(14)} ${p.side.padEnd(5)} ${p.pair} @${p.entry}  CLOSED ${p.closed} @ ${p.close_price}  ${pct(ret).padStart(8)}  — ${p.grade}  d${days}`); continue; }
  const last = px[p.pair].last; const ret = (p.side === "long" ? 1 : -1) * (last / p.entry - 1); const days = Math.round((Date.now() - Date.parse(p.opened)) / 86400e3);
  const overdue = horizonPassed(p.horizon); const state = overdue ? "horizon_passed" : "open";
  marks.push({ id: p.id, type: "position", state, pair: p.pair, side: p.side, entry: p.entry, last, ret, days, horizon: p.horizon ?? null, ...(overdue ? { grade_required: true, days_overdue: daysBetween(p.horizon, today) } : {}) });
  if (overdue) { gradeRequired.push(p.id); // never "running" once the horizon is behind us — that state hid N4-0903 for two days
    lines.push(`  ${p.id.padEnd(14)} ${p.side.padEnd(5)} ${p.pair} @${p.entry} → ${last}  ${pct(ret).padStart(8)}  *** HORIZON PASSED ${p.horizon} (${daysBetween(p.horizon, today)}d) — GRADE REQUIRED ***`); continue; }
  lines.push(`  ${p.id.padEnd(14)} ${p.side.padEnd(5)} ${p.pair} @${p.entry} → ${last}  ${pct(ret).padStart(8)}  ${ret >= 0 ? "running FOR" : "running AGAINST"}  d${days}${p.horizon ? " · h " + p.horizon : ""}`); }
lines.push(`STUBS`);
for (const s of book.stubs) {
  if (isResolved(s)) { // graded: the hit is the book's, not recomputed against today's price
    need(typeof s.hit === "boolean", `${s.id} is resolved but has no boolean hit`);
    marks.push({ id: s.id, type: "stub", state: "resolved", pair: s.watch?.pair ?? null, level: s.watch?.level ?? null, op: s.watch?.op ?? null, resolved: s.resolved, hit: s.hit, horizon: s.horizon ?? null });
    lines.push(`  ${s.id.padEnd(14)} ${s.label} — RESOLVED ${s.resolved} hit=${s.hit}`); continue; }
  const overdue = horizonPassed(s.horizon); if (overdue) gradeRequired.push(s.id);
  const loud = overdue ? `  *** HORIZON PASSED ${s.horizon} (${daysBetween(s.horizon, today)}d) — GRADE REQUIRED ***` : "";
  const overdueFields = overdue ? { grade_required: true, days_overdue: daysBetween(s.horizon, today) } : {};
  if (!s.watch?.pair) { marks.push({ id: s.id, type: "stub", state: overdue ? "horizon_passed" : "manual", manual: true, note: s.note, horizon: s.horizon ?? null, ...overdueFields });
    lines.push(`  ${s.id.padEnd(14)} ${s.label} — MANUAL (${s.note ?? "metric not on tape client"})${loud || " · h " + s.horizon}`); continue; }
  const last = px[s.watch.pair].last; const dist = (s.watch.level - last) / last; const hit = s.watch.op === "<" ? last < s.watch.level : last > s.watch.level;
  marks.push({ id: s.id, type: "stub", state: overdue ? "horizon_passed" : "open", pair: s.watch.pair, level: s.watch.level, op: s.watch.op, last, distance: dist, hit, horizon: s.horizon ?? null, ...overdueFields });
  lines.push(`  ${s.id.padEnd(14)} ${s.watch.pair} ${s.watch.op} ${s.watch.level}  last ${last}  distance ${pct(dist)}  ${hit ? "*** CONDITION MET ***" : "not met"}${loud || " · h " + s.horizon}${s.watch.level_note ? "  [" + s.watch.level_note + "]" : ""}`); }
mkdirSync("tests/q3/marks", { recursive: true }); writeFileSync(`tests/q3/marks/${today}.json`, JSON.stringify({ date: today, venue: CFG.declared_venue, prices: px, grade_required: gradeRequired, marks }, null, 2) + "\n");
if (gradeRequired.length) lines.push(`!!! ${gradeRequired.length} entr${gradeRequired.length === 1 ? "y" : "ies"} past horizon and ungraded: ${gradeRequired.join(", ")} — grade in tests/q3/shadow-book.json (closed/close_price/grade, or resolved/hit)`);
const used = journalCredits("shadow-mark"); lines.push(`→ tests/q3/marks/${today}.json · credits today ${used}/${CFG.credit_ceiling_per_day}`); console.log(lines.join("\n"));
