/**
 * Surf tape client (v1.4 rules): shells out to the `surf` CLI (auth lives in the OS keychain — never in code), stdout-only JSON,
 * per-call credit ledger with a hard daily ceiling (rule 5). TAPE ONLY — never record-bearing.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
export const CFG = JSON.parse(readFileSync("tests/q3/tape/config.json", "utf8"));
export interface SurfResult<T = any> { data: T; meta: { credits_used?: number; cached?: boolean; [k: string]: unknown }; op: string }
const today = () => new Date().toISOString().slice(0, 10);
const ledgerPath = () => `${CFG.ledger_dir}/${today()}.json`;
export function creditsToday(): number { const p = ledgerPath(); if (!existsSync(p)) return 0; return (JSON.parse(readFileSync(p, "utf8")) as any[]).reduce((a, r) => a + (r.credits ?? 0), 0); }
function ledger(op: string, args: string[], credits: number | undefined, cached: boolean | undefined) {
  mkdirSync(CFG.ledger_dir, { recursive: true }); const p = ledgerPath(); const rows = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  rows.push({ at: new Date().toISOString(), op, args: args.filter(a => !a.startsWith("-o")), credits: credits ?? null, cached: cached ?? null }); writeFileSync(p, JSON.stringify(rows, null, 2) + "\n");
}
export function surfAvailable(): boolean { return spawnSync("surf", ["--version"], { encoding: "utf8" }).status === 0; }
/** Run one surf operation. Refuses if today's ledger is at/over the ceiling. Throws on API error. */
export function surf<T = any>(op: string, args: string[] = []): SurfResult<T> {
  const used = creditsToday(); if (used >= CFG.credit_ceiling_per_day) throw new Error(`credit ceiling: ${used}/${CFG.credit_ceiling_per_day} used today — stop and flag (v1.4 rule 5)`);
  const r = spawnSync("surf", [op, ...args, "-o", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout.trim()) throw new Error(`surf ${op} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}`);
  const s = r.stdout; const i = s.indexOf("{"); if (i < 0) throw new Error(`surf ${op}: no JSON on stdout: ${s.slice(0, 200)}`);
  const j = JSON.parse(s.slice(i)); if (j.error) throw new Error(`surf ${op}: ${j.error.code} ${j.error.message}`);
  const meta = j.meta ?? {}; ledger(op, args, meta.credits_used, meta.cached); return { data: j.data, meta, op };
}
/** Append a one-line credit summary for the day to the tape journal (rule 5). */
export function journalCredits(tool: string, note = "") {
  const used = creditsToday(); const line = `- ${new Date().toISOString().slice(0, 16)}Z · ${tool} · credits today so far: ${used}/${CFG.credit_ceiling_per_day}${note ? " · " + note : ""}\n`;
  if (existsSync(CFG.journal)) appendFileSync(CFG.journal, line); return used;
}
/** Rows or a clear error — Surf sometimes returns an empty data array (with empty_reason) on transient upstream gaps; callers should print "tape unavailable", not crash. */
export function rows<T = any>(r: SurfResult<T[]>, what: string): T[] { const d = Array.isArray(r.data) ? r.data : r.data ? [r.data as any] : []; if (!d.length) throw new Error(`tape unavailable: ${r.op} returned no rows for ${what}${r.meta.empty_reason ? " (" + r.meta.empty_reason + ")" : ""}`); return d; }
export const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
