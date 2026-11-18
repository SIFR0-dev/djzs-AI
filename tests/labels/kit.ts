/**
 * BLIND LABELS: the kit. The protocol is tests/labels/README.md and is the authority; this file implements it.
 *
 * Two people read the text the gate reads and answer the gate's questions, blind. This file hands them the sheets,
 * takes their answers back, and scores the gate's reading against the answers they agree on. It measures whether the
 * reading step is RIGHT. It reads no outcome, changes no prompt and no engine code, and never touches the bench in
 * server/engine-v2/calibration or any Q3 record.
 *
 *   npx tsx tests/labels/kit.ts --self-test            offline, no key. Proves the counting on made-up labels.
 *   npx tsx tests/labels/kit.ts check                  every item resolves to a text that matches its hash
 *   npx tsx tests/labels/kit.ts sheets reader-01 reader-02
 *   npx tsx tests/labels/kit.ts ingest                 returned/*.csv into labels.json
 *   npx tsx tests/labels/kit.ts predict                operator shell only (ANTHROPIC_API_KEY): the gate, once per item
 *   npx tsx tests/labels/kit.ts score <predictions.json>
 *
 * THE READING IS PRE-DECLARED in README section 7 and held here as constants. The operator may amend it before the
 * first sheet comes back, not after.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extractAuditInputConsensus, EXTRACTION_CONTRACT_VERSION, STRICT_EXTRACTION_PROMPT, type ModelFn } from "../../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../../server/engine-v2/deterministic-engine";
import type { AuditInput } from "../../server/engine-v2/audit-input-schema";
import { renderIntentText, sha256hex, devVar } from "../q3/lib";

const DIR = "tests/labels";
const ITEMS = `${DIR}/items.json`, TEXTS = `${DIR}/texts.local.json`, LABELS = `${DIR}/labels.json`;
const SHEETS = `${DIR}/sheets`, RETURNED = `${DIR}/returned`, PREDICTIONS = `${DIR}/predictions`, SCORES = `${DIR}/scores`;
const REC_DIR = "tests/q3/records";
const CLAUDE_MODEL = "claude-sonnet-4-6"; // the model the Q2 harness and q3-log.ts use

// ── the pre-declared reading (README section 7) ──────────────────────────────────────────────────────────────────
export const MIN_DECIDED = 50;          // fewer agreed present/absent items than this: INSUFFICIENT
export const AGREEMENT_FLOOR = 0.6;     // Gwet's AC1 between the readers below this: NOT READABLE BY PEOPLE
export const MIN_PER_SIDE = 10;         // fewer agreed presents, or fewer agreed absents, than this: ONE-SIDED
export const UNRELIABLE_ABOVE = 0.15;   // wrong-call rate
export const SILENT_ABOVE = 0.5;        // abstain rate
export const SOUND_WRONG_MAX = 0.05;
export const SOUND_ABSTAIN_MAX = 0.25;

// ── the four questions ───────────────────────────────────────────────────────────────────────────────────────────
export const QUESTIONS = ["falsifier", "resolution", "probability", "edge"] as const;
export type Question = (typeof QUESTIONS)[number];
export const DECIDING: readonly Question[] = ["falsifier", "resolution", "probability"]; // edge is advisory: it never changes a verdict
export type Tri = "present" | "absent" | "cannot-tell";
export type GateState = "present" | "absent" | "unknown";
/** A reader's word for each question, and the three-way value it counts as. `none-asserted` counts as present because
 *  the extraction contract counts a thesis that asserts no probability as having nothing unsourced. */
export const ANSWERS: Record<Question, Record<string, Tri>> = {
  falsifier: { present: "present", absent: "absent", "cannot-tell": "cannot-tell" },
  resolution: { present: "present", absent: "absent", "cannot-tell": "cannot-tell" },
  probability: { sourced: "present", "none-asserted": "present", unsourced: "absent", "cannot-tell": "cannot-tell" },
  edge: { "own-reason": "present", "consensus-only": "absent", "cannot-tell": "cannot-tell" },
};
const ENGINE_FIELD: Record<Question, "invalidation_condition" | "resolution_engagement" | "probability_basis" | "edge_claim"> = {
  falsifier: "invalidation_condition", resolution: "resolution_engagement", probability: "probability_basis", edge: "edge_claim" };
export const READER_ID = /^reader-\d{2,}$/;
const TRIS: Tri[] = ["present", "absent", "cannot-tell"];

// ── CSV, as a spreadsheet writes it: quoted cells, doubled quotes, CRLF or LF, an optional byte-order mark ───────
export function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(c => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n") + "\r\n";
}
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, ""); const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; continue; }
    if (ch === '"') { quoted = true; any = true; }
    else if (ch === ",") { row.push(cell); cell = ""; any = true; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; if (any || cell !== "") { row.push(cell); rows.push(row); } row = []; cell = ""; any = false; }
    else cell += ch;
  }
  if (quoted) throw new Error("a quoted cell is never closed");
  if (any || cell !== "") { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

/** A shuffle that depends only on the seed, so a reader's sheet can be regenerated exactly. */
export function shuffled<T>(xs: readonly T[], seed: string): T[] {
  let a = parseInt(sha256hex(seed).slice(2, 10), 16) >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const o = [...xs]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

// ── items ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Item = { id: string; origin: string; also?: string[]; source_url: string | null; captured_at: string | null; text_sha256: string; chars: number };
export type ItemsFile = { version: string; note: string; items: Item[]; retired: { id: string; date: string; reason: string }[] };
export const loadItems = (path = ITEMS): ItemsFile => JSON.parse(readFileSync(path, "utf8")) as ItemsFile;
export const activeItems = (f: ItemsFile): Item[] => { const out = new Set(f.retired.map(r => r.id)); return f.items.filter(i => !out.has(i.id)); };

/** Every thesis-bearing sealed Q3 record's rendered intent, by record id: the text the gate was given when it was sealed. */
export function q3Texts(dir = REC_DIR): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of readdirSync(dir).filter(x => x.endsWith(".json")).sort())
    for (const r of JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Record<string, any>[])
      if (typeof r.intent?.thesis === "string" && r.intent.thesis.trim()) m.set(String(r.id), renderIntentText(r.intent));
  return m;
}
export function loadLocalTexts(path = TEXTS): Record<string, unknown> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
/** The exact text of an item, or why it cannot be produced. A collected item's text is its {market, side, thesis},
 *  rendered the way the gate's callers render an intent; nothing else may be in it. */
export function resolveText(item: Item, q3: Map<string, string>, local: Record<string, unknown>): { text: string } | { missing: string } | { error: string } {
  let text: string;
  if (item.origin.startsWith("q3-record:")) {
    const t = q3.get(item.origin.slice("q3-record:".length)); if (t === undefined) return { error: `${item.id}: ${item.origin} is not a thesis-bearing sealed record` }; text = t;
  } else if (item.origin.startsWith("collected:")) {
    const v = local[item.id]; if (v === undefined) return { missing: `${item.id}: its text is not on this machine (${TEXTS} is not tracked)` };
    const o = v as Record<string, unknown>;
    if (!o || typeof o !== "object" || Object.keys(o).sort().join(",") !== "market,side,thesis" || !isStr(o.market) || !isStr(o.side) || !isStr(o.thesis)) return { error: `${item.id}: a collected text is exactly {market, side, thesis}, each a non-empty string` };
    text = renderIntentText(o);
  } else return { error: `${item.id}: origin must start with q3-record: or collected:` };
  if (sha256hex(text) !== item.text_sha256) return { error: `${item.id}: the text does not match text_sha256` };
  if (text.length !== item.chars) return { error: `${item.id}: the text is ${text.length} characters and the item says ${item.chars}` };
  return { text };
}
export function checkItems(f: ItemsFile, q3: Map<string, string>, local: Record<string, unknown>): { problems: string[]; missing: string[]; texts: Map<string, string> } {
  const problems: string[] = [], missing: string[] = [], texts = new Map<string, string>(), ids = new Set<string>(), hashes = new Map<string, string>();
  for (const i of f.items) {
    if (!/^L\d{3}$/.test(i.id)) problems.push(`${i.id}: an item id is L followed by three digits`);
    if (ids.has(i.id)) problems.push(`${i.id}: listed twice`); ids.add(i.id);
    if (!/^0x[0-9a-f]{64}$/.test(i.text_sha256)) problems.push(`${i.id}: text_sha256 is not a 0x-prefixed sha256`);
    else if (hashes.has(i.text_sha256)) problems.push(`${i.id}: the same text as ${hashes.get(i.text_sha256)}`); else hashes.set(i.text_sha256, i.id);
    if (i.origin.startsWith("collected:")) {
      if (!isStr(i.source_url) || !/^https:\/\/\S+$/.test(i.source_url)) problems.push(`${i.id}: a collected item needs an https source_url`);
      if (!isStr(i.captured_at) || Number.isNaN(Date.parse(i.captured_at))) problems.push(`${i.id}: a collected item needs a captured_at time`);
    }
    const r = resolveText(i, q3, local);
    if ("error" in r) problems.push(r.error); else if ("missing" in r) missing.push(r.missing); else texts.set(i.id, r.text);
  }
  for (const r of f.retired) { if (!ids.has(r.id)) problems.push(`${r.id}: retired but not an item`); if (!isStr(r.reason) || !isStr(r.date)) problems.push(`${r.id}: a retirement needs a date and a reason`); }
  return { problems, missing, texts };
}

// ── sheets out, answers back ─────────────────────────────────────────────────────────────────────────────────────
export const SHEET_HEADER = ["item_id", "text", ...QUESTIONS, "note"];
export function sheetRows(items: { id: string; text: string }[], reader: string): string[][] {
  return [SHEET_HEADER, ...shuffled(items, reader).map(i => [i.id, i.text, "", "", "", "", ""])];
}
export type Label = { item_id: string; reader: string } & Record<Question, string>;
/** A returned sheet, read strictly: an answer is one of the listed words or the sheet is refused. Nothing is guessed. */
export function readSheet(csv: string, reader: string, knownIds: ReadonlySet<string>): { labels: Label[]; problems: string[] } {
  const problems: string[] = [], labels: Label[] = [];
  if (!READER_ID.test(reader)) return { labels, problems: [`"${reader}" is not a reader id (reader-01, reader-02, ...); this repository is public, so no name or handle`] };
  let rows: string[][]; try { rows = parseCsv(csv); } catch (e) { return { labels, problems: [`${reader}: ${(e as Error).message}`] }; }
  if (!rows.length) return { labels, problems: [`${reader}: the sheet is empty`] };
  const head = rows[0].map(h => h.trim().toLowerCase()); const col = (name: string) => head.indexOf(name);
  for (const need of ["item_id", ...QUESTIONS]) if (col(need) < 0) problems.push(`${reader}: no "${need}" column`);
  if (problems.length) return { labels, problems };
  const seen = new Set<string>();
  rows.slice(1).forEach((r, n) => {
    const id = (r[col("item_id")] ?? "").trim(); const where = `${reader} row ${n + 2}`;
    if (!id) { problems.push(`${where}: no item_id`); return; }
    if (!knownIds.has(id)) { problems.push(`${where}: ${id} is not an item`); return; }
    if (seen.has(id)) { problems.push(`${where}: ${id} appears twice`); return; } seen.add(id);
    const label = { item_id: id, reader } as Label; let bad = false;
    for (const q of QUESTIONS) {
      const a = (r[col(q)] ?? "").trim().toLowerCase();
      if (!a) { problems.push(`${where} (${id}): "${q}" is empty; cannot-tell is an answer, a blank is not`); bad = true; }
      else if (!(a in ANSWERS[q])) { problems.push(`${where} (${id}): "${q}" is "${a}"; it must be one of ${Object.keys(ANSWERS[q]).join(", ")}`); bad = true; }
      else label[q] = a;
    }
    if (!bad) labels.push(label);
  });
  return { labels, problems };
}
/** Answers already recorded are never changed by a later sheet: a different answer for the same item and reader is a conflict. */
export function mergeLabels(existing: Label[], incoming: Label[]): { labels: Label[]; conflicts: string[]; added: number; unchanged: number } {
  const key = (l: Label) => `${l.item_id}|${l.reader}`; const by = new Map(existing.map(l => [key(l), l])); const conflicts: string[] = []; let added = 0, unchanged = 0;
  for (const l of incoming) {
    const old = by.get(key(l));
    if (!old) { by.set(key(l), l); added++; }
    else if (QUESTIONS.every(q => old[q] === l[q])) unchanged++;
    else conflicts.push(`${l.item_id} by ${l.reader}: recorded ${QUESTIONS.map(q => old[q]).join("/")}, sheet says ${QUESTIONS.map(q => l[q]).join("/")}`);
  }
  const labels = [...by.values()].sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : a.reader < b.reader ? -1 : a.reader > b.reader ? 1 : 0));
  return { labels, conflicts, added, unchanged };
}

// ── the reference: what both readers said ────────────────────────────────────────────────────────────────────────
export type Ref = { tri: Tri | null; raw: string[] }; // tri is null where the readers differ
export function reference(labels: Label[], q: Question, active: ReadonlySet<string>): { refs: Map<string, Ref>; single: number } {
  const by = new Map<string, Label[]>(); for (const l of labels) if (active.has(l.item_id)) by.set(l.item_id, [...(by.get(l.item_id) ?? []), l]);
  const refs = new Map<string, Ref>(); let single = 0;
  for (const [id, ls] of by) {
    if (ls.length < 2) { single++; continue; } // one reader is an opinion, not a reference
    const tris = ls.map(l => ANSWERS[q][l[q]]);
    refs.set(id, { tri: tris.every(t => t === tris[0]) ? tris[0] : null, raw: ls.map(l => l[q]) });
  }
  return { refs, single };
}
/** How far the two readers agree beyond chance, over the items that have exactly two readers. Two statistics:
 *    ac1    Gwet's AC1, which the reading uses. Chance agreement is (1/(k-1)) * sum p(1-p) over the k = 3 answers.
 *    kappa  Fleiss' kappa, reported beside it. Chance agreement is sum p^2. Null when every answer is the same.
 *  They agree when the answers are balanced. They part when nearly every text gets the same answer, which is the
 *  expected case for the falsifier question (most public texts name none): kappa falls to zero or below at 90% raw
 *  agreement, because it reads the lopsidedness itself as chance. AC1 does not, so AC1 decides. */
export function agreement(labels: Label[], q: Question, active: ReadonlySet<string>): { ac1: number | null; kappa: number | null; items: number; agree: number } {
  const by = new Map<string, Tri[]>(); for (const l of labels) if (active.has(l.item_id)) by.set(l.item_id, [...(by.get(l.item_id) ?? []), ANSWERS[q][l[q]]]);
  const pairs = [...by.values()].filter(t => t.length === 2); const N = pairs.length;
  if (!N) return { ac1: null, kappa: null, items: 0, agree: 0 };
  const agree = pairs.filter(([a, b]) => a === b).length; const count: Record<string, number> = {};
  for (const p of pairs) for (const t of p) count[t] = (count[t] ?? 0) + 1;
  const share = TRIS.map(t => (count[t] ?? 0) / (2 * N)), po = agree / N;
  const peKappa = share.reduce((s, x) => s + x * x, 0), peAc1 = share.reduce((s, x) => s + x * (1 - x), 0) / (TRIS.length - 1);
  return { ac1: (po - peAc1) / (1 - peAc1), kappa: peKappa >= 1 ? null : (po - peKappa) / (1 - peKappa), items: N, agree };
}

// ── the gate's reading of an item ────────────────────────────────────────────────────────────────────────────────
export type Prediction = { item_id: string; in_scope: boolean; verdict: string; risk: number; codes: string[]; states: Record<Question, GateState>; unknown_fields: string[]; disagreements: string[]; failsafe: boolean };
export type PredictionsFile = { mode: string; model: string | null; extraction_contract: string; repo_head: string | null; prompt_sha256: string; items_sha256: string; started_at: string; complete: boolean; predictions: Prediction[] };
export async function predictOne(item_id: string, text: string, model: ModelFn): Promise<Prediction> {
  const x = await extractAuditInputConsensus(text, model, 3); // one production call, as a caller of the gate gets
  const state = (q: Question): GateState => { const s = (x.input as unknown as Record<string, { state?: string } | undefined>)[ENGINE_FIELD[q]]?.state; return s === "present" || s === "absent" ? s : "unknown"; };
  const states = Object.fromEntries(QUESTIONS.map(q => [q, state(q)])) as Record<Question, GateState>;
  const common = { item_id, states, disagreements: x.disagreements, failsafe: x.failsafe };
  if (x.input.audit_context !== "prediction_market") return { ...common, in_scope: false, verdict: "OUT_OF_SCOPE", risk: 0, codes: [], unknown_fields: [] };
  const e = runDeterministicAudit(x.input);
  return { ...common, in_scope: true, verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(f => f.code).sort(), unknown_fields: [...e.unknown_fields] };
}
/** The frozen engine on a set of three-way answers, the readers' or anyone's. No model. */
export function engineOn(states: Partial<Record<Question, Tri | GateState>>): { verdict: string; risk: number; codes: string[] } {
  const f = (q: Question) => { const s = states[q]; return s === "present" ? { state: "present", value: "label" } : s === "absent" ? { state: "absent" } : { state: "unknown" }; };
  const input = { agent_type: "labels", intended_action: "bet", audit_context: "prediction_market",
    leverage: { state: "absent" }, position_size: { state: "present", value: 100 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
    invalidation_condition: f("falsifier"), resolution_engagement: f("resolution"), probability_basis: f("probability"), edge_claim: f("edge"),
    data_sources: { state: "absent" }, oracle_source: { state: "absent" }, confidence: { state: "absent" } };
  const e = runDeterministicAudit(input as unknown as AuditInput);
  return { verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(x => x.code).sort() };
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────────────────────────
const GATES: GateState[] = ["present", "absent", "unknown"];
const rate = (n: number, d: number): number | null => (d ? n / d : null);
export function readingFor(decided: number, ac1: number | null, wrong: number | null, abstain: number | null, agreedPresent: number, agreedAbsent: number): string {
  if (decided < MIN_DECIDED) return "INSUFFICIENT";
  if (ac1 === null || ac1 < AGREEMENT_FLOOR) return "NOT READABLE BY PEOPLE";
  if (wrong === null || abstain === null) return "INSUFFICIENT";
  if (wrong > UNRELIABLE_ABOVE) return "UNRELIABLE";
  if (abstain > SILENT_ABOVE) return "SILENT";
  if (Math.min(agreedPresent, agreedAbsent) < MIN_PER_SIDE) return "ONE-SIDED";
  if (wrong <= SOUND_WRONG_MAX && abstain <= SOUND_ABSTAIN_MAX) return "SOUND";
  return "MIXED";
}
export function scoreQuestion(q: Question, labels: Label[], preds: Map<string, Prediction>, active: ReadonlySet<string>) {
  const { refs, single } = reference(labels, q, active); const k = agreement(labels, q, active);
  const table = Object.fromEntries(TRIS.map(t => [t, Object.fromEntries(GATES.map(g => [g, 0]))])) as Record<Tri, Record<GateState, number>>;
  let disagreed = 0, unpredicted = 0, out_of_scope = 0, referenced = 0;
  for (const [id, r] of refs) {
    if (r.tri === null) { disagreed++; continue; }
    const p = preds.get(id); if (!p) { unpredicted++; continue; }
    if (!p.in_scope) { out_of_scope++; continue; } // the gate declined the item: counted on its own line, in no table
    table[r.tri][p.states[q]]++; referenced++;
  }
  const decided = table.present.present + table.present.absent + table.present.unknown + table.absent.present + table.absent.absent + table.absent.unknown;
  const same = table.present.present + table.absent.absent, abstained = table.present.unknown + table.absent.unknown, opposite = table.present.absent + table.absent.present;
  const gateAbsent = table.present.absent + table.absent.absent + table["cannot-tell"].absent, readersAbsent = table.absent.present + table.absent.absent + table.absent.unknown;
  const wrong_call_rate = rate(opposite, decided), abstain_rate = rate(abstained, decided);
  const raw: Record<string, number> = {}; for (const r of refs.values()) if (r.tri !== null) { const key = r.raw.every(a => a === r.raw[0]) ? r.raw[0] : r.raw.slice().sort().join("+"); raw[key] = (raw[key] ?? 0) + 1; }
  return {
    question: q, deciding: DECIDING.includes(q), items_with_two_readers: refs.size, one_reader_only: single, readers_differ: disagreed, no_prediction: unpredicted, gate_out_of_scope: out_of_scope,
    scored: referenced, ac1: k.ac1, kappa: k.kappa, agreement_items: k.items, reader_agreement: rate(k.agree, k.items), table, reference_answers: raw,
    agreed_present: table.present.present + table.present.absent + table.present.unknown, agreed_absent: readersAbsent,
    decided, same, abstained, opposite, match_rate: rate(same, decided), wrong_call_rate, abstain_rate,
    gate_absent: { calls: gateAbsent, readers_agree: table.absent.absent, precision: rate(table.absent.absent, gateAbsent) },
    readers_absent: { items: readersAbsent, gate_found: table.absent.absent, recall: rate(table.absent.absent, readersAbsent) },
    missed_defect: table.absent.present, false_block: table.present.absent,
    reading: DECIDING.includes(q) ? readingFor(decided, k.ac1, wrong_call_rate, abstain_rate, table.present.present + table.present.absent + table.present.unknown, readersAbsent) : "ADVISORY (no reading: this answer never changes a verdict)",
  };
}
export function scoreVerdicts(labels: Label[], preds: Map<string, Prediction>, active: ReadonlySet<string>) {
  const refs = Object.fromEntries(QUESTIONS.map(q => [q, reference(labels, q, active).refs])) as Record<Question, Map<string, Ref>>;
  const VS = ["PASS", "WAIT", "FAIL"], GS = ["PASS", "WAIT", "FAIL", "OUT_OF_SCOPE"];
  const table = Object.fromEntries(VS.map(v => [v, Object.fromEntries(GS.map(g => [g, 0]))])) as Record<string, Record<string, number>>;
  const gate_pass_readers_fail: string[] = [], gate_fail_readers_pass: string[] = [], gate_wait_readers_decided: string[] = []; let compared = 0, same = 0;
  for (const id of [...active].sort()) {
    const tri = (q: Question) => refs[q].get(id)?.tri ?? null;
    if (DECIDING.some(q => tri(q) === null)) continue; // a verdict needs all three deciding answers agreed
    const p = preds.get(id); if (!p) continue;
    const r = engineOn({ falsifier: tri("falsifier")!, resolution: tri("resolution")!, probability: tri("probability")!, edge: tri("edge") ?? "unknown" });
    table[r.verdict][p.verdict] = (table[r.verdict][p.verdict] ?? 0) + 1; compared++; if (r.verdict === p.verdict) same++;
    if (p.verdict === "PASS" && r.verdict === "FAIL") gate_pass_readers_fail.push(id);
    if (p.verdict === "FAIL" && r.verdict === "PASS") gate_fail_readers_pass.push(id);
    if (p.verdict === "WAIT" && r.verdict !== "WAIT") gate_wait_readers_decided.push(id);
  }
  return { compared, same, agreement: rate(same, compared), table, gate_pass_readers_fail, gate_fail_readers_pass, gate_wait_readers_decided };
}
export function score(f: ItemsFile, labels: Label[], predictions: Prediction[]) {
  const active = new Set(activeItems(f).map(i => i.id)); const preds = new Map(predictions.map(p => [p.item_id, p]));
  const readers = [...new Set(labels.filter(l => active.has(l.item_id)).map(l => l.reader))].sort();
  return { items: active.size, retired: f.retired.length, labels: labels.filter(l => active.has(l.item_id)).length, readers, predictions: predictions.filter(p => active.has(p.item_id)).length,
    questions: QUESTIONS.map(q => scoreQuestion(q, labels, preds, active)), verdicts: scoreVerdicts(labels, preds, active) };
}
export type Score = ReturnType<typeof score>;

const pct = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
export function report(s: Score, log = (line: string) => console.log(line)): void {
  log(`\n${s.items} item(s) in the set (${s.retired} retired) · ${s.labels} label row(s) from ${s.readers.length} reader(s) · ${s.predictions} gate reading(s)`);
  for (const q of s.questions) {
    log(`\n${q.question.toUpperCase()}${q.deciding ? "" : "  (advisory)"}`);
    log(`  two readers on ${q.items_with_two_readers} item(s); they differ on ${q.readers_differ}; same answer ${pct(q.reader_agreement)}, AC1 ${q.ac1 === null ? "n/a" : q.ac1.toFixed(2)}, kappa ${q.kappa === null ? "n/a" : q.kappa.toFixed(2)}, over ${q.agreement_items}`);
    log(`  readers' answers where they agree: ${Object.entries(q.reference_answers).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}`);
    log(`  gate against the agreed answer   readers present: gate present ${q.table.present.present}, absent ${q.table.present.absent}, unknown ${q.table.present.unknown}`);
    log(`                                   readers absent:  gate present ${q.table.absent.present}, absent ${q.table.absent.absent}, unknown ${q.table.absent.unknown}`);
    log(`                                   readers cannot tell: gate present ${q.table["cannot-tell"].present}, absent ${q.table["cannot-tell"].absent}, unknown ${q.table["cannot-tell"].unknown}`);
    log(`  where readers agree on present or absent (${q.decided}): same ${pct(q.match_rate)} · gate says the opposite ${pct(q.wrong_call_rate)} (${q.opposite}) · gate says unknown ${pct(q.abstain_rate)} (${q.abstained})`);
    log(`  gate's absent calls: ${q.gate_absent.calls}, readers agree on ${q.gate_absent.readers_agree} (${pct(q.gate_absent.precision)}) · readers' absents: ${q.readers_absent.items}, gate found ${q.readers_absent.gate_found} (${pct(q.readers_absent.recall)})`);
    if (q.one_reader_only || q.no_prediction || q.gate_out_of_scope) log(`  left out: ${q.one_reader_only} with one reader only · ${q.no_prediction} with no gate reading · ${q.gate_out_of_scope} the gate declined as out of scope`);
    log(`  PRE-DECLARED READING   ${q.reading}`);
  }
  const v = s.verdicts;
  log(`\nVERDICTS  the engine on the readers' agreed answers, against the gate's own verdict, on ${v.compared} item(s) where all three deciding answers are agreed`);
  for (const r of ["PASS", "WAIT", "FAIL"]) log(`  readers' answers give ${r.padEnd(4)}: gate ${["PASS", "WAIT", "FAIL", "OUT_OF_SCOPE"].map(g => `${g} ${v.table[r][g]}`).join(" · ")}`);
  log(`  same verdict ${pct(v.agreement)} (${v.same}/${v.compared})`);
  log(`  gate PASS where the readers' answers FAIL: ${v.gate_pass_readers_fail.join(", ") || "none"}`);
  log(`  gate FAIL where the readers' answers PASS: ${v.gate_fail_readers_pass.join(", ") || "none"}`);
  log(`  gate WAIT where the readers' answers decide: ${v.gate_wait_readers_decided.join(", ") || "none"}`);
}

// ── model: the same request body q3-log.ts and the Q2 harness send ───────────────────────────────────────────────
function anthropicModel(key: string): ModelFn {
  return async (prompt) => {
    for (let a = 1; a <= 6; a++) {
      let r: Response;
      try {
        r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, temperature: 0, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(90_000) });
      } catch (e) { if (a === 6) throw e; await new Promise(z => setTimeout(z, 2500 * a)); continue; }
      if (r.status === 429 || r.status === 529 || r.status >= 500) { await new Promise(z => setTimeout(z, 2000 * 2 ** (a - 1))); continue; }
      if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json() as { content?: { text?: string }[] }; return d.content?.[0]?.text ?? "";
    }
    throw new Error("Claude API: retries exhausted");
  };
}
const gitHead = (): string | null => { try { return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
export async function predictAll(items: { id: string; text: string }[], model: ModelFn, outPath: string, meta: Omit<PredictionsFile, "complete" | "predictions">, log = (s: string) => console.log(s)): Promise<Prediction[]> {
  const predictions: Prediction[] = [];
  const save = () => writeFileSync(outPath, JSON.stringify({ ...meta, complete: predictions.length === items.length, predictions }, null, 2) + "\n");
  save();
  for (const i of items) { const p = await predictOne(i.id, i.text, model); predictions.push(p); save(); log(`  ${i.id}  ${p.verdict.padEnd(12)} ${QUESTIONS.map(q => `${q} ${p.states[q]}`).join(" · ")}`); }
  return predictions;
}

// ── self-test: made-up items, labels and gate readings; the real CSV code, the real counting, the real engine ────
type Want = Partial<Record<Question, GateState>> & { scope?: boolean };
const sample = (w: Want) => JSON.stringify({
  agent_type: "self-test", intended_action: "bet", market_type: w.scope === false ? "perp" : "prediction_market", ...(w.scope === false ? {} : { audit_context: "prediction_market" }),
  leverage: { state: "absent" }, position_size: { state: "present", value: 100 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
  invalidation_condition: w.falsifier === "absent" ? { state: "absent" } : w.falsifier === "unknown" ? { state: "unknown" } : { state: "present", value: "stub exit" },
  // The two quote-gated fields are scripted as present or unknown only: an absent there needs a verbatim quote of the text.
  resolution_engagement: w.resolution === "unknown" ? { state: "unknown" } : { state: "present", value: "stub" },
  probability_basis: w.probability === "unknown" ? { state: "unknown" } : { state: "present", value: "stub" },
  edge_claim: w.edge === "unknown" ? { state: "unknown" } : { state: "present", value: "stub" },
  data_sources: { state: "absent" }, oracle_source: { state: "absent" }, confidence: { state: "absent" } });

async function selfTest(): Promise<boolean> {
  let pass = 0, fail = 0;
  const ok = (cond: boolean, label: string, got?: unknown) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}${got !== undefined ? `\n       got ${JSON.stringify(got)?.slice(0, 700)}` : ""}`); } };

  console.log("SELF-TEST · CSV as a spreadsheet returns it");
  const cells = [["item_id", "text", "note"], ["L001", "market: A, B\nside: YES\nthesis: he said \"buy\"", ""], ["L002", "plain", "x,y"]];
  ok(JSON.stringify(parseCsv(toCsv(cells))) === JSON.stringify(cells), "a sheet survives being written and read: commas, quotes and line breaks inside a cell", parseCsv(toCsv(cells)));
  ok(JSON.stringify(parseCsv("﻿a,b\nc,d\n\n,\n")) === JSON.stringify([["a", "b"], ["c", "d"]]), "a byte-order mark, bare line feeds and blank trailing rows are tolerated", parseCsv("﻿a,b\nc,d\n\n,\n"));
  ok(JSON.stringify(parseCsv("a,b,\r\n1,,3\r\n")) === JSON.stringify([["a", "b", ""], ["1", "", "3"]]), "empty cells keep their place", parseCsv("a,b,\r\n1,,3\r\n"));
  { let threw = ""; try { parseCsv('a,"b\n'); } catch (e) { threw = (e as Error).message; } ok(threw.includes("never closed"), "an unclosed quote is an error, not a guess", threw); }
  const order = (seed: string) => shuffled(["a", "b", "c", "d", "e", "f", "g", "h"], seed).join("");
  ok(order("reader-01") === order("reader-01") && order("reader-01") !== order("reader-02") && order("reader-01").split("").sort().join("") === "abcdefgh", "a reader's order is fixed by the reader id, differs between readers, and loses nothing", [order("reader-01"), order("reader-02")]);

  console.log("SELF-TEST · sheets and answers");
  const ids = new Set(["L001", "L002", "L003"]);
  const sheet = (rows: string[][]) => toCsv([SHEET_HEADER, ...rows]);
  const good = readSheet(sheet([["L002", "t", "Present", " absent ", "none-asserted", "consensus-only", "ok"], ["L001", "t", "cannot-tell", "present", "unsourced", "own-reason", ""]]), "reader-01", ids);
  ok(good.problems.length === 0 && good.labels.length === 2 && good.labels[0].falsifier === "present" && good.labels[0].resolution === "absent" && good.labels[0].probability === "none-asserted", "answers are read case- and space-insensitively and stored as the listed words", good);
  const bad = (rows: string[][], reader = "reader-01") => readSheet(sheet(rows), reader, ids).problems.join(" | ");
  ok(bad([["L001", "t", "", "present", "sourced", "own-reason", ""]]).includes("is empty"), "a blank answer is refused: cannot-tell is an answer, a blank is not");
  ok(bad([["L001", "t", "yes", "present", "sourced", "own-reason", ""]]).includes('"falsifier" is "yes"'), "a word that is not on the list is refused, never mapped");
  ok(bad([["L001", "t", "present", "present", "present", "own-reason", ""]]).includes('"probability" is "present"'), "each question takes its own words: present is not an answer to the probability question");
  ok(bad([["L009", "t", "present", "present", "sourced", "own-reason", ""]]).includes("is not an item"), "an unknown item id is refused");
  ok(bad([["L001", "t", "present", "present", "sourced", "own-reason", ""], ["L001", "t", "absent", "present", "sourced", "own-reason", ""]]).includes("appears twice"), "an item answered twice on one sheet is refused");
  ok(bad([["L001", "t", "present", "present", "sourced", "own-reason", ""]], "damon").includes("not a reader id") && bad([["L001", "t", "present", "present", "sourced", "own-reason", ""]], "@someone").includes("not a reader id"), "a sheet under a name or a handle is refused");
  ok(readSheet("item_id,falsifier\nL001,present\n", "reader-01", ids).problems.some(p => p.includes('no "resolution" column')), "a sheet missing a question column is refused");
  ok(readSheet(sheet([["L001", "t", "present", "", "sourced", "own-reason", ""]]), "reader-01", ids).labels.length === 0, "a row with one bad answer contributes no label at all");
  const rows1 = sheetRows([{ id: "L001", text: "one" }, { id: "L002", text: "two" }, { id: "L003", text: "three" }], "reader-01");
  ok(rows1.length === 4 && rows1[0].join() === SHEET_HEADER.join() && rows1.slice(1).every(r => r.slice(2).every(c => c === "")) && rows1.slice(1).map(r => r[0]).sort().join() === "L001,L002,L003", "a generated sheet has every item once, the text, and empty answer cells", rows1);
  const L = (item_id: string, reader: string, falsifier: string, resolution: string, probability: string, edge: string): Label => ({ item_id, reader, falsifier, resolution, probability, edge });
  const m1 = mergeLabels([L("L001", "reader-01", "present", "present", "sourced", "own-reason")], [L("L001", "reader-01", "present", "present", "sourced", "own-reason"), L("L001", "reader-02", "absent", "present", "sourced", "own-reason")]);
  ok(m1.added === 1 && m1.unchanged === 1 && m1.conflicts.length === 0 && m1.labels.length === 2, "ingesting the same sheet twice changes nothing; a new reader is added", m1);
  const m2 = mergeLabels([L("L001", "reader-01", "present", "present", "sourced", "own-reason")], [L("L001", "reader-01", "absent", "present", "sourced", "own-reason")]);
  ok(m2.conflicts.length === 1 && m2.labels[0].falsifier === "present", "a different answer for an item and reader already recorded is a conflict, and the recorded answer stands", m2);

  console.log("SELF-TEST · the reference and agreement between readers");
  const act = new Set(["L001", "L002", "L003", "L004"]);
  const lab = [L("L001", "reader-01", "present", "present", "sourced", "own-reason"), L("L001", "reader-02", "present", "absent", "none-asserted", "own-reason"),
    L("L002", "reader-01", "absent", "absent", "unsourced", "consensus-only"), L("L002", "reader-02", "absent", "absent", "unsourced", "cannot-tell"),
    L("L003", "reader-01", "cannot-tell", "present", "sourced", "own-reason"), L("L004", "reader-01", "present", "present", "sourced", "own-reason"), L("L004", "reader-02", "present", "present", "sourced", "own-reason")];
  const rf = reference(lab, "falsifier", act), rr = reference(lab, "resolution", act), rp = reference(lab, "probability", act);
  ok(rf.refs.get("L001")!.tri === "present" && rf.refs.get("L002")!.tri === "absent" && !rf.refs.has("L003") && rf.single === 1, "two readers who agree make a reference; one reader alone does not", [...rf.refs]);
  ok(rr.refs.get("L001")!.tri === null && rr.refs.get("L002")!.tri === "absent", "two readers who differ make no reference for that question on that item");
  ok(rp.refs.get("L001")!.tri === "present" && rp.refs.get("L001")!.raw.slice().sort().join() === "none-asserted,sourced", "sourced and none-asserted are the same reference (present), and the raw words are kept");
  ok(reference(lab, "falsifier", new Set(["L002"])).refs.size === 1, "a retired item leaves the reference");
  const two = (a: Tri[], b: Tri[]) => a.flatMap((x, n) => { const w = (t: Tri) => t; return [L(`L${String(n + 1).padStart(3, "0")}`, "reader-01", w(x), "present", "sourced", "own-reason"), L(`L${String(n + 1).padStart(3, "0")}`, "reader-02", w(b[n]), "present", "sourced", "own-reason")]; });
  const idsOf = (n: number) => new Set(Array.from({ length: n }, (_, k) => `L${String(k + 1).padStart(3, "0")}`));
  const P: Tri = "present", A: Tri = "absent";
  const C: Tri = "cannot-tell";
  const kPerfect = agreement(two([P, P, A, A], [P, P, A, A]), "falsifier", idsOf(4)), kChance = agreement(two([P, P, A, A], [P, A, P, A]), "falsifier", idsOf(4)), kAllSame = agreement(two([P, P, P], [P, P, P]), "falsifier", idsOf(3)), kNone = agreement([], "falsifier", idsOf(2));
  ok(kPerfect.kappa === 1 && kPerfect.ac1 === 1 && kPerfect.agree === 4 && kChance.kappa === 0 && kNone.kappa === null && kNone.ac1 === null, "full agreement is 1 on both statistics; kappa is 0 at chance; nothing read twice is undefined", [kPerfect, kChance, kNone]);
  ok(kAllSame.kappa === null && kAllSame.ac1 === 1, "every answer the same: kappa is undefined, AC1 is 1 (the readers do agree)", kAllSame);
  // 10 items: agree on 8 (5 present, 3 absent), differ on 2. po = 0.8; shares 0.6, 0.4, 0.
  //   kappa: pe = 0.36 + 0.16 = 0.52, so 0.28/0.48.   AC1: pe = (0.24 + 0.24 + 0)/2 = 0.24, so 0.56/0.76.
  const kHand = agreement(two([P, P, P, P, P, A, A, A, P, A], [P, P, P, P, P, A, A, A, A, P]), "falsifier", idsOf(10));
  ok(kHand.items === 10 && kHand.agree === 8 && Math.abs(kHand.kappa! - 0.28 / 0.48) < 1e-12 && Math.abs(kHand.ac1! - 0.56 / 0.76) < 1e-12, "both statistics match a hand-worked table", kHand);
  // The lopsided case the reading is built for. 20 items: 18 both absent, 2 where one reader cannot tell. po = 0.9; shares 0, 0.95, 0.05.
  //   kappa: pe = 0.9025 + 0.0025 = 0.905, so -0.005/0.095 (below zero).   AC1: pe = (0.0475 + 0.0475)/2 = 0.0475, so 0.8525/0.9525.
  const kSkew = agreement(two([...Array(18).fill(A), A, A], [...Array(18).fill(A), C, C]), "falsifier", idsOf(20));
  ok(kSkew.agree === 18 && Math.abs(kSkew.kappa! - (-0.005 / 0.095)) < 1e-9 && Math.abs(kSkew.ac1! - 0.8525 / 0.9525) < 1e-12 && kSkew.kappa! < 0 && kSkew.ac1! > AGREEMENT_FLOOR, "when nearly every text gets the same answer, kappa goes below zero at 90% raw agreement and AC1 stays at 0.90: AC1 decides", kSkew);

  console.log("SELF-TEST · the gate's reading through the real merge and the real engine");
  const scripted = (w: Want): ModelFn => async () => sample(w);
  const g1 = await predictOne("L001", "market: T\nside: YES\nthesis: self-test", scripted({}));
  ok(g1.verdict === "PASS" && g1.in_scope && QUESTIONS.every(q => g1.states[q] === "present") && g1.risk === 0, "three present facts read back as present and PASS", g1);
  const g2 = await predictOne("L002", "x", scripted({ falsifier: "absent", probability: "unknown", edge: "unknown" }));
  ok(g2.verdict === "FAIL" && g2.states.falsifier === "absent" && g2.states.probability === "unknown" && g2.states.edge === "unknown" && g2.codes.join() === "DJZS-M02", "an absent falsifier reads back absent and FAILs; unknowns read back unknown", g2);
  const g3 = await predictOne("L003", "x", scripted({ scope: false }));
  ok(g3.verdict === "OUT_OF_SCOPE" && !g3.in_scope, "a text the gate declines is recorded as out of scope", g3);
  ok(engineOn({ falsifier: "present", resolution: "present", probability: "present", edge: "absent" }).verdict === "PASS" && engineOn({ falsifier: "present", resolution: "present", probability: "present", edge: "absent" }).risk === 15, "the engine on labels: all three present is PASS, and a consensus-only edge adds 15 and changes nothing");
  ok(engineOn({ falsifier: "absent", resolution: "present", probability: "present" }).verdict === "FAIL" && engineOn({ falsifier: "present", resolution: "absent", probability: "present" }).codes.join() === "DJZS-M01" && engineOn({ falsifier: "present", resolution: "present", probability: "absent" }).risk === 25, "…any one absent is FAIL, each by its own rule");
  ok(engineOn({ falsifier: "cannot-tell", resolution: "present", probability: "present" }).verdict === "WAIT" && engineOn({}).verdict === "WAIT", "…and cannot-tell is unknown, which is WAIT");

  console.log("SELF-TEST · scoring against a table worked by hand");
  // 60 items, two readers each, all agreeing. Falsifier: 40 present, 20 absent. Gate: of the 40 present, 30 present, 2 absent, 8 unknown;
  // of the 20 absent, 14 absent, 1 present, 5 unknown. So decided 60, same 44, opposite 3, abstained 13.
  const id3 = (n: number) => `L${String(n).padStart(3, "0")}`; const items60: Item[] = Array.from({ length: 60 }, (_, k) => ({ id: id3(k + 1), origin: "collected:test", source_url: "https://example.org/x", captured_at: "2026-11-17T00:00:00Z", text_sha256: "0x" + "0".repeat(64), chars: 1 }));
  const file60: ItemsFile = { version: "t", note: "", items: items60, retired: [] };
  const truth = (n: number): Tri => (n <= 40 ? "present" : "absent");
  const gateF = (n: number): GateState => (n <= 30 ? "present" : n <= 32 ? "absent" : n <= 40 ? "unknown" : n <= 54 ? "absent" : n === 55 ? "present" : "unknown");
  const labels60 = items60.flatMap((i, k) => ["reader-01", "reader-02"].map(r => L(i.id, r, truth(k + 1), "present", "sourced", "own-reason")));
  const mkPred = (id: string, f: GateState, over: Partial<Prediction> = {}): Prediction => { const states = { falsifier: f, resolution: "present", probability: "present", edge: "present" } as Record<Question, GateState>; const e = engineOn(states); return { item_id: id, in_scope: true, verdict: e.verdict, risk: e.risk, codes: e.codes, states, unknown_fields: [], disagreements: [], failsafe: false, ...over }; };
  const preds60 = items60.map((i, k) => mkPred(i.id, gateF(k + 1)));
  const s60 = score(file60, labels60, preds60); const qf = s60.questions[0];
  ok(qf.question === "falsifier" && qf.decided === 60 && qf.same === 44 && qf.opposite === 3 && qf.abstained === 13 && qf.table.present.present === 30 && qf.table.present.absent === 2 && qf.table.present.unknown === 8 && qf.table.absent.absent === 14 && qf.table.absent.present === 1 && qf.table.absent.unknown === 5, "the three-by-three table is the hand-worked one", qf.table);
  ok(Math.abs(qf.wrong_call_rate! - 3 / 60) < 1e-12 && Math.abs(qf.abstain_rate! - 13 / 60) < 1e-12 && Math.abs(qf.match_rate! - 44 / 60) < 1e-12, "wrong-call, abstain and match rates", [qf.wrong_call_rate, qf.abstain_rate, qf.match_rate]);
  ok(qf.gate_absent.calls === 16 && qf.gate_absent.readers_agree === 14 && qf.readers_absent.items === 20 && qf.readers_absent.gate_found === 14 && qf.false_block === 2 && qf.missed_defect === 1, "the gate's absent calls: 16 made, 14 the readers agree with; of the readers' 20 absents the gate found 14", [qf.gate_absent, qf.readers_absent]);
  ok(Math.abs(qf.gate_absent.precision! - 14 / 16) < 1e-12 && Math.abs(qf.readers_absent.recall! - 14 / 20) < 1e-12, "…so the gate's absent calls are right 87.5% of the time and find 70.0% of the readers' absents", [qf.gate_absent.precision, qf.readers_absent.recall]);
  const overcall = score(file60, labels60.map(l => (l.item_id === "L054" ? { ...l, falsifier: "cannot-tell" } : l)), preds60).questions[0];
  ok(overcall.table["cannot-tell"].absent === 1 && overcall.gate_absent.calls === 16 && overcall.gate_absent.readers_agree === 13 && Math.abs(overcall.gate_absent.precision! - 13 / 16) < 1e-12 && overcall.readers_absent.items === 19 && overcall.decided === 59, "an absent call on a text the readers cannot tell from counts against the gate's absent calls, and is in neither rate", [overcall.gate_absent, overcall.decided]);
  ok(qf.ac1 === 1 && qf.kappa === 1 && qf.agreed_present === 40 && qf.agreed_absent === 20 && qf.reading === "SOUND", "wrong 5.0%, abstain 21.7%, readers in full agreement, both answers well represented: SOUND", [qf.ac1, qf.reading]);
  ok(s60.questions[3].reading.startsWith("ADVISORY") && s60.questions[1].reading === "ONE-SIDED" && s60.questions[1].agreed_absent === 0 && s60.questions[1].wrong_call_rate === 0, "the advisory question gets no reading; a question where every agreed answer is present is ONE-SIDED however clean the gate looks on it", s60.questions.map(q => q.reading));
  const v60 = s60.verdicts;
  ok(v60.compared === 60 && v60.table.PASS.PASS === 30 && v60.table.PASS.FAIL === 2 && v60.table.PASS.WAIT === 8 && v60.table.FAIL.FAIL === 14 && v60.table.FAIL.PASS === 1 && v60.table.FAIL.WAIT === 5 && v60.same === 44, "verdicts: the engine on the readers' answers against the gate's verdict", v60.table);
  ok(v60.gate_pass_readers_fail.join() === "L055" && v60.gate_fail_readers_pass.join() === "L031,L032" && v60.gate_wait_readers_decided.length === 13, "the item the gate passed and the readers' answers fail is named", v60);

  console.log("SELF-TEST · the reading, at its edges");
  ok(readingFor(49, 1, 0, 0, 30, 19) === "INSUFFICIENT" && readingFor(50, 1, 0, 0, 30, 20) === "SOUND", "49 agreed items is INSUFFICIENT; 50 can be read");
  ok(readingFor(60, 0.59, 0, 0, 30, 30) === "NOT READABLE BY PEOPLE" && readingFor(60, null, 0, 0, 30, 30) === "NOT READABLE BY PEOPLE" && readingFor(60, 0.6, 0, 0, 30, 30) === "SOUND", "AC1 under 0.60 or undefined: NOT READABLE BY PEOPLE; 0.60 can be read");
  ok(readingFor(60, 1, 0.151, 0, 30, 30) === "UNRELIABLE" && readingFor(60, 1, 0.15, 0.6, 30, 30) === "SILENT" && readingFor(60, 1, 0.15, 0.5, 30, 30) === "MIXED", "wrong over 15% is UNRELIABLE; at 15% with abstain over 50% it is SILENT; at exactly 50% it is MIXED");
  ok(readingFor(60, 1, 0.05, 0.25, 30, 30) === "SOUND" && readingFor(60, 1, 0.051, 0.25, 30, 30) === "MIXED" && readingFor(60, 1, 0.05, 0.251, 30, 30) === "MIXED" && readingFor(60, 1, 0.2, 0.9, 30, 30) === "UNRELIABLE", "SOUND needs both wrong at or under 5% and abstain at or under 25%; UNRELIABLE outranks SILENT");
  ok(readingFor(60, 1, 0, 0, 51, 9) === "ONE-SIDED" && readingFor(60, 1, 0, 0, 9, 51) === "ONE-SIDED" && readingFor(60, 1, 0, 0, 50, 10) === "SOUND" && readingFor(60, 1, 0.2, 0, 60, 0) === "UNRELIABLE" && readingFor(60, 1, 0, 0.6, 60, 0) === "SILENT", "fewer than 10 agreed presents or absents is ONE-SIDED, never SOUND; UNRELIABLE and SILENT are still called on a one-sided set");
  ok(MIN_DECIDED === 50 && AGREEMENT_FLOOR === 0.6 && MIN_PER_SIDE === 10 && UNRELIABLE_ABOVE === 0.15 && SILENT_ABOVE === 0.5 && SOUND_WRONG_MAX === 0.05 && SOUND_ABSTAIN_MAX === 0.25, "the thresholds are the ones README section 7 declares");
  // Five agreed presents and fifty-five agreed absents, the gate right on every one: clean, and still not called sound.
  const lop = score(file60, items60.flatMap((i, k) => ["reader-01", "reader-02"].map(r => L(i.id, r, k < 5 ? "present" : "absent", "present", "sourced", "own-reason"))), items60.map((i, k) => mkPred(i.id, k < 5 ? "present" : "absent"))).questions[0];
  ok(lop.agreed_present === 5 && lop.agreed_absent === 55 && lop.wrong_call_rate === 0 && lop.abstain_rate === 0 && lop.reading === "ONE-SIDED", "scored end to end: five agreed presents among sixty is ONE-SIDED even with the gate right every time", [lop.agreed_present, lop.agreed_absent, lop.reading]);
  const few = score({ ...file60, items: items60.slice(0, 10) }, labels60, preds60);
  ok(few.questions[0].reading === "INSUFFICIENT" && few.items === 10 && few.questions[0].decided === 10, "ten items: counted, and INSUFFICIENT", few.questions[0].reading);

  console.log("SELF-TEST · what is left out, and why");
  const retired = score({ ...file60, retired: [{ id: "L055", date: "2026-11-17", reason: "read while editing a contract" }] }, labels60, preds60);
  ok(retired.items === 59 && retired.questions[0].table.absent.present === 0 && retired.verdicts.gate_pass_readers_fail.length === 0, "a retired item is in no table and no list", [retired.items, retired.verdicts.gate_pass_readers_fail]);
  const oos = score(file60, labels60, preds60.map(p => (p.item_id === "L001" ? { ...p, in_scope: false, verdict: "OUT_OF_SCOPE" } : p)));
  ok(oos.questions[0].gate_out_of_scope === 1 && oos.questions[0].decided === 59 && oos.verdicts.table.PASS.OUT_OF_SCOPE === 1, "an item the gate declined is counted on its own line and in no field table", [oos.questions[0].gate_out_of_scope, oos.verdicts.table.PASS]);
  const unpred = score(file60, labels60, preds60.slice(1));
  ok(unpred.questions[0].no_prediction === 1 && unpred.questions[0].decided === 59 && unpred.verdicts.compared === 59, "an item with no gate reading is counted as such", unpred.questions[0].no_prediction);
  const split = score(file60, labels60.map(l => (l.item_id === "L002" && l.reader === "reader-02" ? { ...l, falsifier: "absent" } : l)), preds60);
  ok(split.questions[0].readers_differ === 1 && split.questions[0].decided === 59 && split.verdicts.compared === 59 && split.questions[0].kappa! < 1 && split.questions[0].ac1! < 1, "an item the readers differ on has no reference: out of that question's table and out of the verdict comparison", [split.questions[0].readers_differ, split.verdicts.compared]);
  const vac = score(file60, labels60.map(l => (l.item_id === "L003" ? { ...l, probability: "none-asserted" } : l.item_id === "L004" && l.reader === "reader-02" ? { ...l, probability: "none-asserted" } : l)), preds60).questions[2];
  ok(vac.reference_answers["none-asserted"] === 1 && vac.reference_answers["none-asserted+sourced"] === 1 && vac.reference_answers.sourced === 58 && vac.table.present.present === 60, "the probability question reports how many agreed presents were sourced, none-asserted, or one of each", vac.reference_answers);

  console.log("SELF-TEST · the committed set, and the printed report");
  const f = loadItems(), q3 = q3Texts(), c = checkItems(f, q3, loadLocalTexts());
  ok(c.problems.length === 0, "every committed item passes the checks", c.problems);
  const q3items = f.items.filter(i => i.origin.startsWith("q3-record:"));
  ok(q3items.length >= 6 && q3items.every(i => c.texts.has(i.id)) && q3items.every(i => sha256hex(c.texts.get(i.id)!) === i.text_sha256), "the Q3-origin items resolve from the sealed records and reproduce their hashes", q3items.map(i => i.id));
  ok(new Set(f.items.map(i => i.text_sha256)).size === f.items.length, "no text is in the set twice");
  const tampered = checkItems({ ...f, items: f.items.map((i, n) => (n === 0 ? { ...i, chars: i.chars + 1 } : i)) }, q3, {}), wrongHash = checkItems({ ...f, items: f.items.map((i, n) => (n === 0 ? { ...i, text_sha256: "0x" + "1".repeat(64) } : i)) }, q3, {});
  ok(tampered.problems.some(p => p.includes("characters")) && wrongHash.problems.some(p => p.includes("does not match text_sha256")), "an item whose hash or length does not match its text is refused");
  const col = { id: "L900", origin: "collected:2026-11-17", source_url: "https://example.org/a", captured_at: "2026-11-17T12:00:00Z", text_sha256: sha256hex(renderIntentText({ market: "M", side: "YES", thesis: "T" })), chars: renderIntentText({ market: "M", side: "YES", thesis: "T" }).length };
  ok(checkItems({ ...f, items: [col] }, q3, { L900: { market: "M", side: "YES", thesis: "T" } }).texts.get("L900") === "market: M\nside: YES\nthesis: T", "a collected item is its market, side and text, rendered as the gate's callers render an intent");
  ok(checkItems({ ...f, items: [col] }, q3, {}).missing.length === 1 && checkItems({ ...f, items: [col] }, q3, {}).problems.length === 0, "a collected item whose text is not on this machine is reported as missing, not as wrong");
  ok(checkItems({ ...f, items: [col] }, q3, { L900: { market: "M", side: "YES", thesis: "T", probability_basis: "added" } }).problems.some(p => p.includes("exactly {market, side, thesis}")), "a collected text with a helper key is refused");
  ok(checkItems({ ...f, items: [{ ...col, source_url: null }] }, q3, {}).problems.some(p => p.includes("https source_url")) && checkItems({ ...f, items: [{ ...col, id: "X1" }] }, q3, {}).problems.some(p => p.includes("three digits")), "a collected item with no source, or a malformed id, is refused");
  const printed: string[] = []; let threw = "";
  try { report(s60, l => printed.push(l)); report(score(f, [], []), l => printed.push(l)); report(few, l => printed.push(l)); } catch (e) { threw = String(e); }
  ok(threw === "" && printed.filter(l => l.includes("PRE-DECLARED READING")).length === 12 && !printed.join("\n").includes("undefined") && !printed.join("\n").includes("NaN"), "the report prints on a full score, an empty one and a small one, with no undefined or NaN in it", threw || printed.slice(0, 3));
  ok(printed.some(l => l.includes("gate PASS where the readers' answers FAIL: L055")), "the dangerous cell is printed by item id");

  console.log(fail === 0 ? `SELF-TEST PASS · ${pass}/${pass} assertions` : `SELF-TEST FAIL · ${fail} of ${pass + fail} assertions failed`);
  return fail === 0;
}

// ── main. Runs only when this file is the script ─────────────────────────────────────────────────────────────────
if (/tests[\\/]labels[\\/]kit(\.[cm]?ts)?$/.test(process.argv[1] ?? "")) (async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const usage = "usage: npx tsx tests/labels/kit.ts --self-test | check | sheets <reader-id...> | ingest | predict | score <predictions.json>";
  if (!cmd || !["--self-test", "check", "sheets", "ingest", "predict", "score"].includes(cmd)) { console.error(usage); process.exit(2); }
  if (cmd === "--self-test") process.exit((await selfTest().catch(e => { console.log(`SELF-TEST FAIL · it threw: ${e instanceof Error ? e.message : String(e)}`); return false; })) ? 0 : 1);

  const file = loadItems(), q3 = q3Texts(), checked = checkItems(file, q3, loadLocalTexts()), active = activeItems(file);
  if (checked.problems.length) { console.error(`items.json has ${checked.problems.length} problem(s):\n  ${checked.problems.join("\n  ")}`); process.exit(1); }
  const withText = () => { const lack = active.filter(i => !checked.texts.has(i.id)); if (lack.length) { console.error(`${lack.length} item(s) have no text on this machine (${TEXTS} is not tracked): ${lack.map(i => i.id).join(", ")}`); process.exit(1); } return active.map(i => ({ id: i.id, text: checked.texts.get(i.id)! })); };

  if (cmd === "check") {
    console.log(`${file.items.length} item(s), ${file.retired.length} retired, ${active.length} active · ${checked.texts.size} resolve to a text that matches its hash · ${checked.missing.length} have no text on this machine`);
    for (const m of checked.missing) console.log(`  ${m}`);
    process.exit(0);
  }
  if (cmd === "sheets") {
    if (!rest.length || rest.some(r => !READER_ID.test(r))) { console.error(`give reader ids such as reader-01 reader-02 (this repository is public: no names or handles)\n${usage}`); process.exit(2); }
    const items = withText(); mkdirSync(SHEETS, { recursive: true });
    for (const r of rest) { writeFileSync(`${SHEETS}/${r}.csv`, "﻿" + toCsv(sheetRows(items, r))); console.log(`${SHEETS}/${r}.csv · ${items.length} item(s), in ${r}'s own order`); }
    console.log(`Each reader fills falsifier, resolution, probability and edge with the words in README section 2 and sends the file back. Put returned files in ${RETURNED}/ under the same name.`);
    process.exit(0);
  }
  if (cmd === "ingest") {
    if (!existsSync(RETURNED)) { console.error(`${RETURNED}/ does not exist: nothing has been returned`); process.exit(1); }
    const known = new Set(file.items.map(i => i.id)); let incoming: Label[] = []; const problems: string[] = [];
    for (const name of readdirSync(RETURNED).filter(x => x.toLowerCase().endsWith(".csv")).sort()) { const r = readSheet(readFileSync(`${RETURNED}/${name}`, "utf8"), name.slice(0, -4), known); incoming = incoming.concat(r.labels); problems.push(...r.problems); }
    if (problems.length) { console.error(`Refused. ${problems.length} problem(s) in the returned sheets; nothing was written:\n  ${problems.join("\n  ")}`); process.exit(1); }
    const existing = existsSync(LABELS) ? (JSON.parse(readFileSync(LABELS, "utf8")) as { labels: Label[] }).labels : [];
    const m = mergeLabels(existing, incoming);
    if (m.conflicts.length) { console.error(`Refused. ${m.conflicts.length} answer(s) differ from what is already recorded; a recorded answer is never changed:\n  ${m.conflicts.join("\n  ")}`); process.exit(1); }
    writeFileSync(LABELS, JSON.stringify({ version: "labels-v1", note: "Answers only: no text, no names. Written by tests/labels/kit.ts ingest; a recorded answer is never changed.", labels: m.labels }, null, 1) + "\n");
    console.log(`${LABELS}: ${m.labels.length} label row(s) · ${m.added} added, ${m.unchanged} already recorded`);
    process.exit(0);
  }
  if (cmd === "score") {
    if (rest.length !== 1 || !existsSync(rest[0])) { console.error(`give one predictions file\n${usage}`); process.exit(2); }
    if (!existsSync(LABELS)) { console.error(`${LABELS} does not exist: no sheet has been ingested`); process.exit(1); }
    const preds = JSON.parse(readFileSync(rest[0], "utf8")) as PredictionsFile, labels = (JSON.parse(readFileSync(LABELS, "utf8")) as { labels: Label[] }).labels;
    if (!preds.complete) { console.error(`${rest[0]} is marked incomplete: the gate did not read every item, so it is not scored`); process.exit(1); }
    if (preds.items_sha256 !== sha256hex(readFileSync(ITEMS))) console.log(`NOTE  ${ITEMS} has changed since these readings were taken; items added since then have no gate reading and are counted as such.`);
    const s = score(file, labels, preds.predictions);
    console.log(`BLIND LABELS · ${preds.extraction_contract} · ${preds.model ?? "no model"} · readings from commit ${preds.repo_head?.slice(0, 7) ?? "unknown"}, taken ${preds.started_at}`);
    report(s);
    mkdirSync(SCORES, { recursive: true }); const out = `${SCORES}/score-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    writeFileSync(out, JSON.stringify({ predictions_file: rest[0], extraction_contract: preds.extraction_contract, prompt_sha256: preds.prompt_sha256, scored_at: new Date().toISOString(), thresholds: { MIN_DECIDED, AGREEMENT_FLOOR, MIN_PER_SIDE, UNRELIABLE_ABOVE, SILENT_ABOVE, SOUND_WRONG_MAX, SOUND_ABSTAIN_MAX }, ...s }, null, 2) + "\n");
    console.log(`\n${out}`);
    process.exit(0);
  }
  // predict. CLAUDE.md section 5: the offline harness runs before ANY live run. Enforced here, not remembered.
  if (!(await selfTest().catch(() => false))) { console.error("\nRefusing the live run: the self-test failed."); process.exit(1); }
  const items = withText(); const key = devVar("ANTHROPIC_API_KEY");
  if (!key) { console.error("\nANTHROPIC_API_KEY not found (environment, or djzs-trust-mcp/.dev.vars). The live run is the operator's: a session without the key reports and stops."); process.exit(2); }
  mkdirSync(PREDICTIONS, { recursive: true }); const started_at = new Date().toISOString();
  const out = `${PREDICTIONS}/${EXTRACTION_CONTRACT_VERSION}-${started_at.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  console.log(`\nBLIND LABELS · the gate's reading · LIVE · ${CLAUDE_MODEL} · ${EXTRACTION_CONTRACT_VERSION} · ${items.length} item(s) · ${items.length * 3} model calls\n`);
  try { await predictAll(items, anthropicModel(key), out, { mode: "live", model: CLAUDE_MODEL, extraction_contract: EXTRACTION_CONTRACT_VERSION, repo_head: gitHead(), prompt_sha256: sha256hex(STRICT_EXTRACTION_PROMPT), items_sha256: sha256hex(readFileSync(ITEMS)), started_at }); }
  catch (e) { console.error(`\nThe run stopped: ${e instanceof Error ? e.message : String(e)}\nWhat finished is in ${out}, marked incomplete, and an incomplete file is not scored.`); process.exit(1); }
  console.log(`\n${out}\nCommit that file. It holds the gate's answers and no text. Score it with: npx tsx tests/labels/kit.ts score ${out}`);
})();
