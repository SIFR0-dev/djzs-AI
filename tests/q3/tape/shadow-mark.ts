/** Use 2 — daily marks for every open shadow position and stub. Separate ledger; never a Q3 record. Prices from the declared venue via Surf (1 credit per pair). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { surf, CFG, pct, journalCredits } from "./surf";
const book = JSON.parse(readFileSync("tests/q3/shadow-book.json", "utf8")); const today = new Date().toISOString().slice(0, 10);
const pairs = new Set<string>([...book.positions.map((p: any) => p.pair), ...book.stubs.filter((s: any) => s.watch?.pair).map((s: any) => s.watch.pair)]);
const px: Record<string, any> = {};
for (const pair of pairs) { const r = surf("exchange-price", ["--exchange", CFG.declared_venue.exchange, "--pair", pair]); px[pair] = Array.isArray(r.data) ? r.data[0] : r.data; }
const marks: any[] = []; const lines: string[] = [];
lines.push(`SHADOW BOOK · ${today} · venue ${CFG.declared_venue.exchange}`);
for (const p of book.positions) { const last = px[p.pair].last; const ret = (p.side === "long" ? 1 : -1) * (last / p.entry - 1); const days = Math.round((Date.now() - Date.parse(p.opened)) / 86400e3);
  marks.push({ id: p.id, type: "position", pair: p.pair, side: p.side, entry: p.entry, last, ret, days, horizon: p.horizon });
  lines.push(`  ${p.id.padEnd(14)} ${p.side.padEnd(5)} ${p.pair} @${p.entry} → ${last}  ${pct(ret).padStart(8)}  ${ret >= 0 ? "running FOR" : "running AGAINST"}  d${days}${p.horizon ? " · h " + p.horizon : ""}`); }
lines.push(`STUBS`);
for (const s of book.stubs) { if (!s.watch?.pair) { marks.push({ id: s.id, type: "stub", manual: true, note: s.note }); lines.push(`  ${s.id.padEnd(14)} ${s.label} — MANUAL (${s.note ?? "metric not on tape client"})`); continue; }
  const last = px[s.watch.pair].last; const dist = (s.watch.level - last) / last; const hit = s.watch.op === "<" ? last < s.watch.level : last > s.watch.level;
  marks.push({ id: s.id, type: "stub", pair: s.watch.pair, level: s.watch.level, op: s.watch.op, last, distance: dist, hit, horizon: s.horizon });
  lines.push(`  ${s.id.padEnd(14)} ${s.watch.pair} ${s.watch.op} ${s.watch.level}  last ${last}  distance ${pct(dist)}  ${hit ? "*** CONDITION MET ***" : "not met"} · h ${s.horizon}${s.watch.level_note ? "  [" + s.watch.level_note + "]" : ""}`); }
mkdirSync("tests/q3/marks", { recursive: true }); writeFileSync(`tests/q3/marks/${today}.json`, JSON.stringify({ date: today, venue: CFG.declared_venue, prices: px, marks }, null, 2) + "\n");
const used = journalCredits("shadow-mark"); lines.push(`→ tests/q3/marks/${today}.json · credits today ${used}/${CFG.credit_ceiling_per_day}`); console.log(lines.join("\n"));
