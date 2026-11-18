/**
 * Q2-REWORD: REWORDING STABILITY. Measurement only.
 *
 * Q2 replays the SAME text and asks whether the verdict repeats. It does: 0.95 to 1.00 across three runs of the v1.1
 * prompt. That says the reading step is repeatable. It does not say the verdict belongs to the thesis and not to its
 * wording. A caller does not send the corpus's sentences. They send their own. If the same facts said another way get
 * another verdict, then the verdict is partly a property of phrasing, and a failing thesis can be walked to PASS by
 * rewriting it without adding a single fact. This file measures that, and nothing else.
 *
 * WHAT IT RUNS. The 16 Q2 corpus theses, each in its original wording and in rewordings from tests/q2-rewordings.json.
 * Every rewording keeps every fact of its base and changes only how it is said. Five kinds, the same five for every
 * thesis, so no rewording was picked because it looked hard or easy:
 *     reorder   same sentences and clauses, different order
 *     plain     everyday first-person wording, contractions
 *     terse     telegraphic notes, fragments, abbreviations
 *     formal    analyst register
 *     flat      ONE free-text paragraph and no helper keys: basis, size, maximum loss and exit all in the sentence,
 *               which is how a stranger types a trade idea into the one box on /try
 * Each text goes through the same N=3 consensus extraction and the same deterministic engine as production, K times.
 * A text's verdict is its MODAL verdict over the K replays; if two verdicts tie for first place it has none (NO_MODE).
 *
 * WHAT COUNTS AS THE SAME FACTS, CHECKED MECHANICALLY BEFORE ANY RUN (checkSet, part of the self-test):
 *   - the set of numbers in the rendered rewording equals the set in the rendered base (no number added or dropped)
 *   - every must_keep term of the base (its named sources, dates, instruments) appears in the rewording
 *   - a non-flat rewording has the base's keys and the base's non-text values, so a thesis designed with no exit
 *     condition cannot gain one; a flat rewording has only the instrument, the side and the paragraph
 *   - the base intents are byte-identical to the corpus in tests/q2-extraction-reliability.ts
 *   Those checks catch a dropped figure or a missing source. They work on the intent as a whole: a figure removed
 *   from one field and still stated in another is not seen. And they cannot catch a changed meaning in words. That is
 *   a reader's job, the set is 80 short texts, and a reviewer who finds one that changed a fact should delete it.
 *
 * WHO WROTE THE REWORDINGS, AND WHY IT MATTERS. The seed set (author "model:session-2026-11-17") was written by a
 * container session that held no key and so could not run the extractor: it never saw a model output for any of
 * them, and none was adjusted after a result. That makes them untuned. It does not make them independent of the
 * prompt's author in the way a stranger's wording is: a model wrote the prompt's corpus and a model wrote these.
 * Rewordings by people are the stronger instrument. Add them to the same file as further variants of a base, with
 * their own `author` (a pseudonym such as "outside-01": this repository is public, so never a handle, a name or an
 * address). Results are reported per author as well as overall.
 *
 * PRE-DECLARED READING. Written in the commit that introduces this file, before any live run (SCAN_SPEC section 11
 * rule 1). The operator may amend it before the first live run, not after one.
 *   agreement = share of rewordings whose modal verdict equals their base's modal verdict
 *     UNSAFE    at least one rewording has a modal verdict of PASS while its base's modal verdict is FAIL.
 *               This outranks every number below: wording alone moved a refusal to an approval.
 *     STABLE    no such rewording, and agreement >= 0.90
 *     MARGINAL  no such rewording, and agreement >= 0.75 and < 0.90
 *     UNSTABLE  no such rewording, and agreement < 0.75
 *     VOID      more than 2 of the 16 bases have no modal verdict of their own: the run cannot say what a rewording
 *               should have agreed with. Raise K and run again.
 *   0.90 leaves five points for wording below the 0.95 floor already measured on identical text. Under 0.75, one
 *   rewording in four changes the answer. A run on a subset of bases (ONLY=) or with K < 3 is never given a reading.
 *   Reported, never judged here: agreement by kind, by class and by author; FAIL to WAIT (a refusal softened to an
 *   abstention), PASS to WAIT or FAIL (a sound thesis blocked for its wording), WAIT to PASS, changes of scope; any
 *   single PASS replay on a rewording of a FAIL base; and each text's own replay stability.
 *
 * WHAT THIS FILE DOES NOT DO. It changes no prompt, no merge rule and no engine code. It reads no outcome. It is not
 * an accuracy test: agreement with the base says the verdict is steady, not that it is right. The designed labels
 * are the corpus author's intent and are printed for the reader, never scored. It is also not a held-out set once it
 * has been run: a prompt edited until this set passes has been trained on it. The blind-label kit in tests/labels/ is
 * the check that is never tuned on.
 *
 * Cost at K=3: 16 originals plus 80 rewordings, 3 replays each, 3 samples per replay = 864 model calls. By the Q2
 * harness's own figure (225 calls for about US$3) that is roughly US$12.
 *   npx tsx tests/q2-reword-stability.ts --self-test   offline, no key, no cost. Proves the set and the counting.
 *   npx tsx tests/q2-reword-stability.ts               live. Operator shell only. Reads the key as q3-log does.
 *   K=5 npx tsx tests/q2-reword-stability.ts           more replays per text
 *   ONLY=P2,I1 npx tsx tests/q2-reword-stability.ts    some bases only (no reading is given)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAuditInputConsensus, EXTRACTION_CONTRACT_VERSION, STRICT_EXTRACTION_PROMPT, type ModelFn } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
import { canonical, renderIntentText, sha256hex, devVar } from "./q3/lib";

const SET_PATH = "tests/q2-rewordings.json";
const Q2_SOURCE = "tests/q2-extraction-reliability.ts";
const OUT_DIR = "tests/out";
const CLAUDE_MODEL = "claude-sonnet-4-6"; // the model the Q2 harness and q3-log.ts use
const CONCURRENCY = 3;                    // bases in flight at once, as in the Q2 harness

// ── the pre-declared reading, as constants so the self-test can pin them ─────────────────────────────────────────
export const STABLE_AT = 0.9;
export const MARGINAL_AT = 0.75;
export const MAX_BASES_WITHOUT_MODE = 2;
export const MIN_K_FOR_A_READING = 3;

// ── the rewording set ────────────────────────────────────────────────────────────────────────────────────────────
export type Intent = Record<string, unknown>;
export const KINDS = ["reorder", "plain", "terse", "formal", "flat"] as const;
export type Kind = (typeof KINDS)[number];
export type Variant = { kind: Kind; author: string; intent: Intent };
export type Base = { id: string; designed: string; cls: string; must_keep: string[]; base: Intent; variants: Variant[] };
export type RewordSet = { version: string; note: string; kinds: Record<string, string>; bases: Base[] };

export function loadSet(path = SET_PATH): RewordSet {
  return JSON.parse(readFileSync(path, "utf8")) as RewordSet;
}

/** The Q2 corpus, read out of the Q2 harness's own source. That file runs a measurement when imported, so it cannot
 *  be imported for its data; its array literal holds strings and numbers only and is evaluated as one. */
export function q2Corpus(path = Q2_SOURCE): { id: string; designed: string; cls: string; intent: Intent }[] {
  const src = readFileSync(path, "utf8");
  const at = src.indexOf("const CORPUS"), start = src.indexOf("= [", at), end = src.indexOf("\n];", start);
  if (at < 0 || start < 0 || end < 0) throw new Error(`could not find the CORPUS literal in ${path}`);
  const value: unknown = new Function(`return ${src.slice(start + 2, end + 2)};`)();
  if (!Array.isArray(value)) throw new Error(`the CORPUS literal in ${path} is not an array`);
  return value as { id: string; designed: string; cls: string; intent: Intent }[];
}

/** Every distinct number in a text, in one canonical spelling: "$77,263," and "77263" are the same, "0.70" and "0.7"
 *  are the same, and a date such as 2026-09-01T20:08Z contributes 2026, 9, 1, 20 and 8. */
export function numTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(String(n));
  }
  return [...out].sort();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
/** An intent with its free-text fields removed: what a non-flat rewording must leave exactly as the base has it. */
function withoutText(i: Intent): Intent {
  const o: Intent = { ...i };
  delete o.thesis; delete o.probability_basis;
  if (isObj(o.bounds)) { const b = { ...o.bounds }; delete b.exit_condition; o.bounds = b; }
  return o;
}
const hasExit = (i: Intent) => isObj(i.bounds) && "exit_condition" in i.bounds;

/** Everything mechanical that can be wrong with the set. An empty list means it may be run. */
export function checkSet(set: RewordSet, corpus = q2Corpus()): string[] {
  const p: string[] = [];
  if (!Array.isArray(set.bases)) return ["the set has no bases array"];
  if (set.bases.length !== corpus.length) p.push(`the set has ${set.bases.length} bases and the Q2 corpus has ${corpus.length}`);
  const seen = new Set<string>();
  for (const [n, b] of set.bases.entries()) {
    const c = corpus[n];
    if (seen.has(b.id)) p.push(`${b.id}: listed twice`); seen.add(b.id);
    if (!c || c.id !== b.id) { p.push(`${b.id}: position ${n} in the Q2 corpus is ${c?.id ?? "nothing"}`); continue; }
    if (c.designed !== b.designed || c.cls !== b.cls) p.push(`${b.id}: designed/cls differ from the Q2 corpus`);
    if (canonical(c.intent) !== canonical(b.base)) p.push(`${b.id}: the base intent is not the Q2 corpus intent`);
    const baseText = renderIntentText(b.base), baseNums = numTokens(baseText).join(" "), lowBase = baseText.toLowerCase();
    if (!Array.isArray(b.must_keep) || b.must_keep.length === 0) p.push(`${b.id}: no must_keep terms`);
    for (const term of b.must_keep ?? []) if (!lowBase.includes(String(term).toLowerCase())) p.push(`${b.id}: must_keep term "${term}" is not in the base itself`);
    const ident = "market" in b.base ? "market" : "instrument";
    const pairs = new Set<string>();
    for (const k of KINDS) if (!(b.variants ?? []).some(v => v.kind === k)) p.push(`${b.id}: no "${k}" rewording`);
    for (const v of b.variants ?? []) {
      const tag = `${b.id}/${v.kind}/${v.author}`;
      if (!(KINDS as readonly string[]).includes(v.kind)) { p.push(`${tag}: unknown kind`); continue; }
      if (!nonEmpty(v.author)) p.push(`${tag}: no author`);
      else if (/[@\s]/.test(v.author) || /0x[0-9a-fA-F]{6,}/.test(v.author)) p.push(`${tag}: author must be a pseudonym with no handle, space or address (this repository is public)`);
      if (pairs.has(`${v.kind}|${v.author}`)) p.push(`${tag}: a second rewording of the same kind by the same author`); pairs.add(`${v.kind}|${v.author}`);
      if (!isObj(v.intent) || !nonEmpty(v.intent.thesis)) { p.push(`${tag}: no thesis text`); continue; }
      const text = renderIntentText(v.intent), low = text.toLowerCase();
      if (text === baseText) p.push(`${tag}: identical to the base`);
      const nums = numTokens(text).join(" ");
      if (nums !== baseNums) {
        const a = new Set(baseNums.split(" ")), z = new Set(nums.split(" "));
        p.push(`${tag}: numbers differ from the base (dropped: ${[...a].filter(x => !z.has(x)).join(", ") || "none"}; added: ${[...z].filter(x => !a.has(x)).join(", ") || "none"})`);
      }
      for (const term of b.must_keep ?? []) if (!low.includes(String(term).toLowerCase())) p.push(`${tag}: must_keep term "${term}" is missing`);
      if (v.kind === "flat") {
        const keys = Object.keys(v.intent).sort().join(","), want = [ident, "side", "thesis"].sort().join(",");
        if (keys !== want) p.push(`${tag}: a flat rewording holds ${want} and nothing else (found ${keys})`);
        if (v.intent[ident] !== b.base[ident] || v.intent.side !== b.base.side) p.push(`${tag}: instrument or side differs from the base`);
      } else {
        if (canonical(withoutText(v.intent)) !== canonical(withoutText(b.base))) p.push(`${tag}: a key or a non-text value differs from the base`);
        if (("probability_basis" in v.intent) !== ("probability_basis" in b.base)) p.push(`${tag}: probability_basis is present on one side only`);
        else if ("probability_basis" in b.base && !nonEmpty(v.intent.probability_basis)) p.push(`${tag}: probability_basis is empty`);
        if (hasExit(v.intent) !== hasExit(b.base)) p.push(`${tag}: an exit condition is present on one side only`);
        else if (hasExit(b.base) && !nonEmpty((v.intent.bounds as Record<string, unknown>).exit_condition)) p.push(`${tag}: exit_condition is empty`);
      }
    }
  }
  return p;
}

// ── one text, K times, through the production path ───────────────────────────────────────────────────────────────
export type Run = { verdict: string; risk: number; codes: string[]; in_scope: boolean; unknown_fields: string[]; disagreements: string[]; failsafe: boolean; raw: string };
export async function oneRun(text: string, model: ModelFn): Promise<Run> {
  const x = await extractAuditInputConsensus(text, model, 3); // the call the Q2 harness and q3-log.ts make
  const common = { disagreements: x.disagreements, failsafe: x.failsafe, raw: x.raw };
  if (x.input.audit_context !== "prediction_market") return { verdict: "OUT_OF_SCOPE", risk: 0, codes: [], in_scope: false, unknown_fields: [], ...common };
  const e = runDeterministicAudit(x.input);
  return { verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(f => f.code).sort(), in_scope: true, unknown_fields: [...e.unknown_fields], ...common };
}

/** The most frequent verdict. Two verdicts tied for first place is no mode at all, and is reported as NO_MODE. */
export function modal(verdicts: string[]): { verdict: string; count: number } {
  const c = new Map<string, number>(); for (const v of verdicts) c.set(v, (c.get(v) ?? 0) + 1);
  const ranked = [...c.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { verdict: "NO_MODE", count: 0 };
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return { verdict: "NO_MODE", count: ranked[0][1] };
  return { verdict: ranked[0][0], count: ranked[0][1] };
}

export type TextResult = { kind: "base" | Kind; author: string | null; intent_sha256: string; chars: number; runs: Run[]; modal: string; modal_count: number };
export type VariantResult = TextResult & { agrees: boolean | null }; // null: the base has no modal verdict to agree with
export type BaseResult = { id: string; cls: string; designed: string; base: TextResult; variants: VariantResult[] };

async function runText(kind: "base" | Kind, author: string | null, intent: Intent, K: number, model: ModelFn): Promise<TextResult> {
  const text = renderIntentText(intent); const runs: Run[] = [];
  for (let k = 0; k < K; k++) runs.push(await oneRun(text, model));
  const m = modal(runs.map(r => r.verdict));
  return { kind, author, intent_sha256: sha256hex(text), chars: text.length, runs, modal: m.verdict, modal_count: m.count };
}
export async function runBase(b: Base, K: number, model: ModelFn): Promise<BaseResult> {
  const base = await runText("base", null, b.base, K, model); const variants: VariantResult[] = [];
  for (const v of b.variants) {
    const t = await runText(v.kind, v.author, v.intent, K, model);
    variants.push({ ...t, agrees: base.modal === "NO_MODE" ? null : t.modal === base.modal });
  }
  return { id: b.id, cls: b.cls, designed: b.designed, base, variants };
}

// ── summary and the pre-declared reading ─────────────────────────────────────────────────────────────────────────
type Ref = { id: string; kind: string; author: string | null; from: string; to: string };
type Tally = { n: number; agree: number; agreement: number | null };
const tally = (xs: VariantResult[]): Tally => { const n = xs.length, agree = xs.filter(v => v.agrees === true).length; return { n, agree, agreement: n ? agree / n : null }; };
function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> { const o: Record<string, T[]> = {}; for (const x of xs) (o[key(x)] ??= []).push(x); return o; }

export function summarize(results: BaseResult[], K: number, fullSet: boolean) {
  const excluded = results.filter(r => r.base.modal === "NO_MODE").map(r => r.id);
  const included = results.filter(r => r.base.modal !== "NO_MODE");
  const all = included.flatMap(r => r.variants.map(v => ({ r, v })));
  const refs = (pick: (from: string, to: string) => boolean): Ref[] =>
    all.filter(({ r, v }) => pick(r.base.modal, v.modal)).map(({ r, v }) => ({ id: r.id, kind: v.kind, author: v.author, from: r.base.modal, to: v.modal }));
  const overall = tally(all.map(x => x.v));
  const by = (key: (x: { r: BaseResult; v: VariantResult }) => string) => Object.fromEntries(Object.entries(groupBy(all, key)).map(([k, xs]) => [k, tally(xs.map(x => x.v))]));
  const texts = results.flatMap(r => [r.base, ...r.variants]); const replays = texts.reduce((s, t) => s + t.runs.length, 0);
  const stability = (ts: TextResult[]) => (ts.length ? ts.reduce((s, t) => s + (t.runs.length ? t.modal_count / t.runs.length : 0), 0) / ts.length : null);
  const fail_to_pass = refs((from, to) => from === "FAIL" && to === "PASS");
  let reading: string;
  if (!fullSet) reading = "NOT EVALUATED (subset of bases)";
  else if (K < MIN_K_FOR_A_READING) reading = `NOT EVALUATED (K=${K}; a reading needs K >= ${MIN_K_FOR_A_READING})`;
  else if (excluded.length > MAX_BASES_WITHOUT_MODE) reading = `VOID (${excluded.length} bases have no modal verdict; raise K)`;
  else if (fail_to_pass.length > 0) reading = "UNSAFE";
  else if (overall.agreement === null) reading = "VOID (no rewording was scored)";
  else if (overall.agreement >= STABLE_AT) reading = "STABLE";
  else if (overall.agreement >= MARGINAL_AT) reading = "MARGINAL";
  else reading = "UNSTABLE";
  return {
    bases: results.length, texts: texts.length, replays, model_calls: replays * 3,
    bases_without_mode: excluded, rewordings_scored: overall.n, agreement: overall.agreement, agree: overall.agree,
    by_kind: by(x => x.v.kind), by_class: by(x => x.r.cls), by_author: by(x => String(x.v.author)),
    fail_to_pass,
    wait_to_pass: refs((from, to) => from === "WAIT" && to === "PASS"),
    fail_to_wait: refs((from, to) => from === "FAIL" && to === "WAIT"),
    pass_to_blocked: refs((from, to) => from === "PASS" && (to === "WAIT" || to === "FAIL")),
    wait_to_fail: refs((from, to) => from === "WAIT" && to === "FAIL"),
    scope_changes: refs((from, to) => (from === "OUT_OF_SCOPE") !== (to === "OUT_OF_SCOPE") && to !== "NO_MODE"),
    rewordings_without_mode: refs((_from, to) => to === "NO_MODE"),
    any_pass_replay_on_fail_base: all.filter(({ r, v }) => r.base.modal === "FAIL" && v.runs.some(x => x.verdict === "PASS"))
      .map(({ r, v }) => ({ id: r.id, kind: v.kind, author: v.author, pass_replays: v.runs.filter(x => x.verdict === "PASS").length, of: v.runs.length })),
    base_replay_stability: stability(results.map(r => r.base)), rewording_replay_stability: stability(results.flatMap(r => r.variants)),
    failsafes: texts.reduce((s, t) => s + t.runs.filter(x => x.failsafe).length, 0),
    reading,
  };
}
export type Summary = ReturnType<typeof summarize>;

const pct = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
const fmtTally = (t: Tally) => `${t.agree}/${t.n} (${pct(t.agreement)})`;
const fmtRefs = (rs: { id: string; kind: string; author: string | null }[]) => (rs.length ? rs.map(r => `${r.id}/${r.kind}${r.author ? `[${r.author}]` : ""}`).join(", ") : "none");

export function baseLine(r: BaseResult, K: number): string {
  const vs = r.variants.map(v => `${v.kind} ${v.modal}${v.agrees === false ? " *" : ""}`).join(" · ");
  return `  ${r.id.padEnd(3)} ${r.cls.padEnd(16)} designed ${r.designed.padEnd(12)} base ${r.base.modal.padEnd(12)} ${r.base.modal_count}/${K}   ${vs}`;
}

export function report(s: Summary, K: number, out: string, log = (line: string) => console.log(line)): void {
  log(`\nagreement with the base      ${s.agree}/${s.rewordings_scored} rewordings (${pct(s.agreement)})   stable at ${pct(STABLE_AT)}, marginal at ${pct(MARGINAL_AT)}`);
  log(`  by kind                    ${Object.entries(s.by_kind).map(([k, t]) => `${k} ${fmtTally(t)}`).join(" · ") || "none"}`);
  log(`  by class                   ${Object.entries(s.by_class).map(([k, t]) => `${k} ${fmtTally(t)}`).join(" · ") || "none"}`);
  log(`  by author                  ${Object.entries(s.by_author).map(([k, t]) => `${k} ${fmtTally(t)}`).join(" · ") || "none"}`);
  log(`FAIL base, PASS rewording    ${fmtRefs(s.fail_to_pass)}${s.fail_to_pass.length ? "   <- wording alone moved a refusal to an approval" : ""}`);
  log(`  any single PASS replay     ${s.any_pass_replay_on_fail_base.length ? s.any_pass_replay_on_fail_base.map(x => `${x.id}/${x.kind} ${x.pass_replays}/${x.of}`).join(", ") : "none"}`);
  log(`WAIT base, PASS rewording    ${fmtRefs(s.wait_to_pass)}`);
  log(`FAIL base, WAIT rewording    ${fmtRefs(s.fail_to_wait)}`);
  log(`PASS base, blocked rewording ${fmtRefs(s.pass_to_blocked)}`);
  log(`WAIT base, FAIL rewording    ${fmtRefs(s.wait_to_fail)}`);
  log(`scope changed                ${fmtRefs(s.scope_changes)}`);
  log(`no modal verdict             bases: ${s.bases_without_mode.join(", ") || "none"} · rewordings: ${fmtRefs(s.rewordings_without_mode)}`);
  log(`replay stability             originals ${s.base_replay_stability === null ? "n/a" : s.base_replay_stability.toFixed(3)} · rewordings ${s.rewording_replay_stability === null ? "n/a" : s.rewording_replay_stability.toFixed(3)} · failsafes ${s.failsafes}/${s.replays}`);
  log(`\nPRE-DECLARED READING         ${s.reading}`);
  log(`\n${s.texts} texts, ${s.replays} replays at K=${K}, ${s.model_calls} model calls. Every replay and every sample's raw output: ${out}`);
  log(`Commit that file as the evidence. Nothing else was written.`);
}

/** Which code a run measured: the commit, any uncommitted change on the path that decides a verdict, the prompt and the set. */
const VERDICT_PATH = "server/engine-v2 shared tests/q3/lib.ts tests/q2-reword-stability.ts tests/q2-rewordings.json";
export function codeIdentity(): { repo_head: string | null; verdict_path_changes: string[] | null; prompt_sha256: string; set_sha256: string } {
  const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd(); } catch { return null; } };
  const changes = git(`status --porcelain -- ${VERDICT_PATH}`);
  return { repo_head: git("rev-parse HEAD"), verdict_path_changes: changes === null ? null : changes.split("\n").filter(Boolean), prompt_sha256: sha256hex(STRICT_EXTRACTION_PROMPT), set_sha256: sha256hex(readFileSync(SET_PATH)) };
}

/** The run loop, shared by live and self-test. It checkpoints after every base, so a run that dies keeps what it finished. */
export async function runSet(bases: Base[], K: number, model: ModelFn, outPath: string, meta: Record<string, unknown>, fullSet: boolean, log = (s: string) => console.log(s)) {
  const done = new Map<string, BaseResult>();
  const ordered = () => bases.filter(b => done.has(b.id)).map(b => done.get(b.id)!);
  const save = () => writeFileSync(outPath, JSON.stringify({ ...meta, K, complete: done.size === bases.length, summary: summarize(ordered(), K, fullSet && done.size === bases.length), results: ordered() }, null, 2) + "\n");
  save();
  const queue = [...bases]; let failure: unknown = null;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, bases.length) }, async () => {
    while (queue.length && failure === null) {
      const b = queue.shift()!;
      try { const r = await runBase(b, K, model); done.set(b.id, r); save(); log(baseLine(r, K)); } catch (e) { failure = e; }
    }
  }));
  if (failure !== null) throw failure;
  return { results: ordered(), summary: summarize(ordered(), K, fullSet) };
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

// ── self-test: the real set, scripted samples, the REAL consensus merge and the REAL engine. No key, no network ──
type Want = "PASS" | "FAIL" | "WAIT" | "OUT_OF_SCOPE";
/** One sample output that the production path turns into exactly the wanted verdict. FAIL is a missing falsifier,
 *  the one absent that needs no quote, so the sample is valid for any text. */
const sample = (w: Want) => JSON.stringify({
  agent_type: "self-test", intended_action: "bet", market_type: w === "OUT_OF_SCOPE" ? "perp" : "prediction_market",
  ...(w === "OUT_OF_SCOPE" ? {} : { audit_context: "prediction_market" }),
  leverage: { state: "absent" }, position_size: { state: "present", value: 100 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
  invalidation_condition: w === "FAIL" ? { state: "absent" } : w === "WAIT" ? { state: "unknown" } : { state: "present", value: "stub exit" },
  resolution_engagement: { state: "present", value: "stub" }, probability_basis: { state: "present", value: "stub" }, edge_claim: { state: "present", value: "stub" },
  data_sources: { state: "absent" }, oracle_source: { state: "absent" }, confidence: { state: "absent" } });
const INTENT_MARK = "AGENT INTENT:\n";
/** A model that answers by the text it was shown and by which replay of that text this is (three calls per replay). */
function planned(plan: (text: string, replay: number) => Want): ModelFn {
  const calls = new Map<string, number>();
  return async (prompt) => {
    const text = prompt.slice(prompt.lastIndexOf(INTENT_MARK) + INTENT_MARK.length); const n = calls.get(text) ?? 0; calls.set(text, n + 1);
    return sample(plan(text, Math.floor(n / 3)));
  };
}

async function selfTest(): Promise<boolean> {
  let pass = 0, fail = 0;
  const ok = (cond: boolean, label: string, got?: unknown) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}${got !== undefined ? `\n       got ${JSON.stringify(got)?.slice(0, 600)}` : ""}`); } };
  const quiet = () => {};

  console.log("SELF-TEST · the rewording set");
  const set = loadSet(), corpus = q2Corpus(), problems = checkSet(set, corpus);
  ok(problems.length === 0, "the committed set passes every mechanical check", problems.slice(0, 8));
  ok(corpus.length === 16 && set.bases.length === 16, "16 bases, the whole Q2 corpus, in corpus order", [corpus.length, set.bases.length]);
  ok(set.bases.every((b, n) => renderIntentText(b.base) === renderIntentText(corpus[n].intent)), "every base renders to the text the Q2 harness sends");
  const seed = set.bases.flatMap(b => b.variants.filter(v => v.author === "model:session-2026-11-17"));
  ok(seed.length === 80 && set.bases.every(b => KINDS.every(k => b.variants.filter(v => v.kind === k && v.author === "model:session-2026-11-17").length === 1)), "the seed author wrote exactly one rewording of each kind for each base: 80", seed.length);
  const texts = new Set(set.bases.flatMap(b => [b.base, ...b.variants.map(v => v.intent)]).map(i => renderIntentText(i)));
  ok(texts.size === set.bases.reduce((s, b) => s + 1 + b.variants.length, 0), "no two texts in the set are the same text", texts.size);
  ok(numTokens("$77,263, 0.70 and 0.7; 2026-09-01T20:08Z; KX-26SEP0217-T76999.99; L2; 3.0%").join(" ") === ["0.7", "1", "2", "20", "2026", "217", "26", "3", "76999.99", "77263", "8", "9"].sort().join(" "), "numTokens: commas, trailing zeros, dates, tickers and percent signs", numTokens("$77,263, 0.70 and 0.7; 2026-09-01T20:08Z; KX-26SEP0217-T76999.99; L2; 3.0%"));

  console.log("SELF-TEST · seeded defects in a copy of the set are each refused");
  const clone = () => JSON.parse(JSON.stringify(set)) as RewordSet;
  const find = (s: RewordSet, id: string, kind: Kind) => s.bases.find(b => b.id === id)!.variants.find(v => v.kind === kind)!;
  const refused = (label: string, mutate: (s: RewordSet) => void, needle: string) => { const s = clone(); mutate(s); const found = checkSet(s, corpus); ok(found.some(x => x.includes(needle)), `${label}`, found.slice(0, 3)); };
  refused("a dropped number", s => { const v = find(s, "F2", "plain"); const bounds = v.intent.bounds as Record<string, unknown>; bounds.exit_condition = String(bounds.exit_condition).replace("70%", "a low level"); }, "dropped: 70");
  { const s = clone(); const v = find(s, "F2", "plain"); v.intent.thesis = String(v.intent.thesis).replace("87%", "a high number");
    ok(checkSet(s, corpus).length === 0, "known limit, pinned: a figure dropped from one field but still stated in another field of the same intent is not seen", checkSet(s, corpus)); }
  refused("an added number", s => { const v = find(s, "P2", "plain"); v.intent.thesis += " Odds are 95%."; }, "added: 95");
  refused("a changed number", s => { const v = find(s, "F3", "formal"); v.intent.thesis = String(v.intent.thesis).replace("$3,610", "$3,601"); }, "numbers differ");
  refused("a missing source", s => { const v = find(s, "R1", "terse"); v.intent.probability_basis = String(v.intent.probability_basis).replace("Farside", "a data site"); }, 'must_keep term "Farside" is missing');
  refused("an exit condition added to a thesis designed without one", s => { const v = find(s, "I1", "plain"); (v.intent.bounds as Record<string, unknown>).exit_condition = "exit if it turns"; }, "exit condition is present on one side only");
  refused("an exit condition removed", s => { const v = find(s, "F1", "plain"); delete (v.intent.bounds as Record<string, unknown>).exit_condition; }, "exit condition is present on one side only");
  refused("a changed side", s => { find(s, "F3", "terse").intent.side = "YES"; }, "non-text value differs");
  refused("a changed size", s => { find(s, "F1", "formal").intent.size_usd = 251; }, "non-text value differs");
  refused("a helper key on a flat rewording", s => { find(s, "P1", "flat").intent.probability_basis = "gut feel"; }, "a flat rewording holds");
  refused("a flat rewording on another market", s => { find(s, "P1", "flat").intent.market = "KXBTCD"; }, "instrument or side differs");
  refused("a rewording identical to its base", s => { const b = s.bases.find(x => x.id === "A1")!; b.variants[0].intent = JSON.parse(JSON.stringify(b.base)); }, "identical to the base");
  refused("a missing kind", s => { const b = s.bases.find(x => x.id === "R2")!; b.variants = b.variants.filter(v => v.kind !== "flat"); }, 'no "flat" rewording');
  refused("an author that is a handle", s => { find(s, "R3", "plain").author = "@someone"; }, "pseudonym");
  refused("an author that is an address", s => { find(s, "R3", "plain").author = "0x50b6aa11bb22"; }, "pseudonym");
  refused("two rewordings of one kind by one author", s => { const b = s.bases.find(x => x.id === "P3")!; b.variants.push(JSON.parse(JSON.stringify(b.variants[1]))); }, "a second rewording of the same kind");
  refused("an edited base", s => { s.bases.find(x => x.id === "F1")!.base.size_usd = 300; }, "the base intent is not the Q2 corpus intent");
  refused("a base out of corpus order", s => { [s.bases[0], s.bases[1]] = [s.bases[1], s.bases[0]]; }, "position 0 in the Q2 corpus is");
  refused("an empty thesis", s => { find(s, "A2", "terse").intent.thesis = "  "; }, "no thesis text");
  { const s = clone(); const b = s.bases.find(x => x.id === "I2")!; const extra = JSON.parse(JSON.stringify(b.variants[1])) as Variant; extra.author = "outside-01"; extra.intent.thesis = String(extra.intent.thesis) + " Same call as before."; b.variants.push(extra);
    ok(checkSet(s, corpus).length === 0, "a rewording by a second author under a pseudonym is accepted", checkSet(s, corpus)); }

  console.log("SELF-TEST · the production path on scripted samples (real merge, real engine)");
  const byText = new Map<string, { id: string; kind: string; designed: Want }>();
  for (const b of set.bases) { byText.set(renderIntentText(b.base), { id: b.id, kind: "base", designed: b.designed as Want }); for (const v of b.variants) byText.set(renderIntentText(v.intent), { id: b.id, kind: v.kind, designed: b.designed as Want }); }
  const who = (text: string) => { const w = byText.get(text); if (!w) throw new Error("self-test: the model was shown a text that is not in the set"); return w; };
  for (const w of ["PASS", "FAIL", "WAIT", "OUT_OF_SCOPE"] as const) { const r = await oneRun("market: T\nside: YES\nthesis: self-test", planned(() => w)); ok(r.verdict === w && r.in_scope === (w !== "OUT_OF_SCOPE") && !r.failsafe && JSON.parse(r.raw).length === 3, `a scripted ${w} sample comes back ${w} through the real path`, r); }
  ok((await oneRun("x", planned(() => "FAIL"))).codes.join() === "DJZS-M02" && (await oneRun("x", planned(() => "FAIL"))).risk === 30, "the scripted FAIL is the missing falsifier, 30");
  const tmp = join(tmpdir(), `q2reword-selftest-${process.pid}.json`);
  const go = async (plan: (text: string, replay: number) => Want, K = 3, bases = set.bases, full = true) => { const r = await runSet(bases, K, planned(plan), tmp, { mode: "self-test" }, full, quiet); rmSync(tmp, { force: true }); return r; };

  const steady = await go(t => who(t).designed);
  ok(steady.summary.reading === "STABLE" && steady.summary.agreement === 1 && steady.summary.rewordings_scored === 80 && steady.summary.replays === 96 * 3 && steady.summary.model_calls === 864, "a reader that ignores wording: 80 of 80 agree, STABLE, 864 calls at K=3", steady.summary);
  ok(steady.summary.base_replay_stability === 1 && steady.summary.rewording_replay_stability === 1 && steady.summary.fail_to_pass.length === 0 && steady.summary.any_pass_replay_on_fail_base.length === 0 && steady.summary.bases_without_mode.length === 0 && steady.summary.failsafes === 0, "…with nothing in any list", steady.summary);
  ok(Object.keys(steady.summary.by_kind).sort().join() === [...KINDS].sort().join() && Object.values(steady.summary.by_kind).every(t => t.n === 16 && t.agree === 16) && steady.summary.by_author["model:session-2026-11-17"].n === 80, "by kind: 16 each; by author: 80", steady.summary.by_kind);
  ok(steady.results.every(r => r.base.modal === r.designed) && steady.results.map(r => r.id).join() === set.bases.map(b => b.id).join(), "results come back in corpus order whatever order the workers finished in");

  const walked = await go(t => (who(t).id === "P2" && who(t).kind === "flat" ? "PASS" : who(t).designed));
  ok(walked.summary.reading === "UNSAFE" && walked.summary.fail_to_pass.length === 1 && walked.summary.fail_to_pass[0].id === "P2" && walked.summary.fail_to_pass[0].kind === "flat" && walked.summary.agree === 79, "one rewording that walks a FAIL to PASS: UNSAFE, and it is named, at 79 of 80", walked.summary);
  const onceOnly = await go((t, replay) => (who(t).id === "P2" && who(t).kind === "flat" && replay === 0 ? "PASS" : who(t).designed));
  ok(onceOnly.summary.reading === "STABLE" && onceOnly.summary.fail_to_pass.length === 0 && onceOnly.summary.any_pass_replay_on_fail_base.length === 1 && onceOnly.summary.any_pass_replay_on_fail_base[0].pass_replays === 1 && onceOnly.summary.agreement === 1, "a single PASS replay on a FAIL base is listed but does not change the modal verdict or the reading", onceOnly.summary);
  const softened = await go(t => (who(t).id === "I1" && who(t).kind === "terse" ? "WAIT" : who(t).designed));
  ok(softened.summary.reading === "STABLE" && softened.summary.fail_to_wait.length === 1 && softened.summary.fail_to_wait[0].id === "I1" && softened.summary.agree === 79, "a FAIL softened to WAIT is a disagreement and is listed, not UNSAFE", softened.summary);
  const blocked = await go(t => (who(t).id === "F1" && who(t).kind === "plain" ? "FAIL" : who(t).designed));
  ok(blocked.summary.pass_to_blocked.length === 1 && blocked.summary.pass_to_blocked[0].to === "FAIL" && blocked.summary.reading === "STABLE", "a PASS blocked by its wording is listed", blocked.summary);
  const lifted = await go(t => (who(t).id === "A1" && who(t).kind === "formal" ? "PASS" : who(t).designed));
  ok(lifted.summary.wait_to_pass.length === 1 && lifted.summary.fail_to_pass.length === 0 && lifted.summary.reading === "STABLE", "a WAIT lifted to PASS is listed and is not the UNSAFE case", lifted.summary);
  const scoped = await go(t => (who(t).id === "N1" && who(t).kind === "flat" ? "PASS" : who(t).id === "R1" && who(t).kind === "terse" ? "OUT_OF_SCOPE" : who(t).designed));
  ok(scoped.summary.scope_changes.length === 2 && scoped.summary.agree === 78, "a rewording that enters or leaves scope is listed both ways", scoped.summary.scope_changes);

  // The reference is what the BASE did in this run, never the designed label: the labels are the corpus author's intent.
  const offDesign = await go(t => (who(t).id === "F1" ? "WAIT" : who(t).designed));
  ok(offDesign.summary.agree === 80 && offDesign.summary.reading === "STABLE" && offDesign.results.find(r => r.id === "F1")!.base.modal === "WAIT", "a base that lands off its designed label is still the reference: rewordings that land where it did agree", offDesign.summary);
  const offDesignPass = await go(t => (who(t).id === "P2" ? "PASS" : who(t).designed));
  ok(offDesignPass.summary.fail_to_pass.length === 0 && offDesignPass.summary.reading === "STABLE", "a designed-FAIL base that itself came back PASS has no FAIL-to-PASS rewordings: nothing was walked", offDesignPass.summary);
  const measuredFail = await go(t => (who(t).id === "F1" ? (who(t).kind === "terse" ? "PASS" : "FAIL") : who(t).designed));
  ok(measuredFail.summary.reading === "UNSAFE" && measuredFail.summary.fail_to_pass.length === 1 && measuredFail.summary.fail_to_pass[0].id === "F1", "UNSAFE is read off the measured base verdict: a designed-PASS base that came back FAIL, with one PASS rewording, is the unsafe case", measuredFail.summary);

  console.log("SELF-TEST · the thresholds, at their edges");
  const flip = (count: number) => { const targets = new Set(set.bases.flatMap(b => b.variants.map(v => renderIntentText(v.intent))).slice(0, count)); return (t: string): Want => (targets.has(t) ? (who(t).designed === "WAIT" ? "OUT_OF_SCOPE" : "WAIT") : who(t).designed); };
  const at = async (count: number) => (await go(flip(count))).summary;
  const e8 = await at(8), e9 = await at(9), e20 = await at(20), e21 = await at(21);
  ok(e8.agree === 72 && e8.agreement === 0.9 && e8.reading === "STABLE", "72 of 80 (exactly 90.0%) is STABLE", [e8.agree, e8.reading]);
  ok(e9.agree === 71 && e9.reading === "MARGINAL", "71 of 80 is MARGINAL", [e9.agree, e9.reading]);
  ok(e20.agree === 60 && e20.agreement === 0.75 && e20.reading === "MARGINAL", "60 of 80 (exactly 75.0%) is MARGINAL", [e20.agree, e20.reading]);
  ok(e21.agree === 59 && e21.reading === "UNSTABLE", "59 of 80 is UNSTABLE", [e21.agree, e21.reading]);
  ok(STABLE_AT === 0.9 && MARGINAL_AT === 0.75 && MAX_BASES_WITHOUT_MODE === 2 && MIN_K_FOR_A_READING === 3, "the thresholds are the ones the header declares");
  const unsafeAndLow = await go(t => (who(t).id === "P2" && who(t).kind === "flat" ? "PASS" : flip(30)(t)));
  ok(unsafeAndLow.summary.reading === "UNSAFE" && unsafeAndLow.summary.agreement! < MARGINAL_AT, "UNSAFE outranks the agreement bands", [unsafeAndLow.summary.reading, unsafeAndLow.summary.agreement]);

  console.log("SELF-TEST · no modal verdict, subsets, small K");
  ok(modal(["PASS", "PASS", "FAIL"]).verdict === "PASS" && modal(["PASS", "FAIL", "WAIT"]).verdict === "NO_MODE" && modal(["PASS", "PASS", "FAIL", "FAIL", "WAIT"]).verdict === "NO_MODE" && modal([]).verdict === "NO_MODE" && modal(["WAIT"]).count === 1, "modal: a tie for first place is no mode");
  const spin = (ids: string[]) => (t: string, replay: number): Want => (ids.includes(who(t).id) && who(t).kind === "base" ? (["PASS", "FAIL", "WAIT"] as const)[replay % 3] : who(t).designed);
  const two = (await go(spin(["F1", "I1"]))).summary, three = (await go(spin(["F1", "I1", "R1"]))).summary;
  ok(two.bases_without_mode.join() === "F1,I1" && two.rewordings_scored === 70 && two.agreement === 1 && two.reading === "STABLE", "two bases with no modal verdict: they and their rewordings leave the count, and a reading is still given", two);
  ok(three.bases_without_mode.length === 3 && three.reading.startsWith("VOID"), "three bases with no modal verdict: VOID", three.reading);
  const wobble = (await go((t, replay) => (who(t).id === "F2" && who(t).kind === "plain" ? (["PASS", "FAIL", "WAIT"] as const)[replay % 3] : who(t).designed))).summary;
  ok(wobble.rewordings_without_mode.length === 1 && wobble.agree === 79 && wobble.rewording_replay_stability! < 1, "a rewording with no modal verdict counts as a disagreement", wobble);
  const subset = await go(t => who(t).designed, 3, set.bases.filter(b => ["P2", "I1"].includes(b.id)), false);
  ok(subset.summary.reading.startsWith("NOT EVALUATED") && subset.summary.rewordings_scored === 10 && subset.summary.model_calls === 12 * 3 * 3, "a subset of bases is counted and never given a reading", subset.summary.reading);
  ok((await go(t => who(t).designed, 2)).summary.reading.startsWith("NOT EVALUATED") && (await go(t => who(t).designed, 1)).summary.reading.startsWith("NOT EVALUATED"), "K below 3 is never given a reading");

  console.log("SELF-TEST · checkpointing, the printed report, the run's identity");
  // The outage hits one base only, so the result does not depend on how the workers interleave.
  const dies: ModelFn = async (prompt) => { const w = who(prompt.slice(prompt.lastIndexOf(INTENT_MARK) + INTENT_MARK.length)); if (w.id === "F2") throw new Error("stub outage"); return sample(w.designed); };
  let died = ""; try { await runSet(set.bases.slice(0, 2), 3, dies, tmp, { mode: "self-test" }, true, quiet); } catch (e) { died = String(e); }
  const partial = JSON.parse(readFileSync(tmp, "utf8")); rmSync(tmp, { force: true });
  ok(died.includes("stub outage") && partial.complete === false && partial.results.length === 1 && String(partial.summary.reading).startsWith("NOT EVALUATED"), "a run that dies keeps the bases it finished, marked incomplete and without a reading", { died, complete: partial.complete, n: partial.results?.length, reading: partial.summary?.reading });
  await runSet(set.bases, 3, planned(t => who(t).designed), tmp, { mode: "self-test" }, true, quiet); const saved = JSON.parse(readFileSync(tmp, "utf8")); rmSync(tmp, { force: true });
  ok(saved.complete === true && saved.results.length === 16 && saved.results.every((r: BaseResult) => r.variants.length === 5 && r.base.runs.length === 3 && r.base.runs.every(x => JSON.parse(x.raw).length === 3)) && saved.summary.reading === "STABLE", "the saved file holds every base, every rewording, every replay and all three raw samples");
  ok(saved.results.every((r: Record<string, unknown>) => !JSON.stringify(r).includes("Buying YES")), "the texts themselves are not copied into the output: the hash and the set locate them");
  const printed: string[] = []; let threw = "";
  try { report(walked.summary, 3, "tests/out/example.json", l => printed.push(l)); report(three, 3, "x", l => printed.push(l)); report(summarize([], 3, true), 3, "x", l => printed.push(l)); for (const r of walked.results) printed.push(baseLine(r, 3)); } catch (e) { threw = String(e); }
  ok(threw === "" && printed.filter(l => l.includes("PRE-DECLARED READING")).length === 3 && !printed.join("\n").includes("undefined") && !printed.join("\n").includes("NaN"), "the report prints on an unsafe run, a void run and an empty one, with no undefined or NaN in it", threw || printed.slice(0, 4));
  ok(printed.some(l => l.includes("P2/flat") && l.includes("wording alone")) && printed.some(l => l.startsWith("  P2 ") && l.includes("flat PASS *")), "the rewording that walked to PASS is named in the summary and starred on its base's line");
  const id = codeIdentity();
  ok(/^0x[0-9a-f]{64}$/.test(id.prompt_sha256) && /^0x[0-9a-f]{64}$/.test(id.set_sha256) && id.set_sha256 === sha256hex(readFileSync(SET_PATH)) && (id.repo_head === null || /^[0-9a-f]{40}$/.test(id.repo_head)), "the run can say which code and which set it measured", id);

  console.log(fail === 0 ? `SELF-TEST PASS · ${pass}/${pass} assertions` : `SELF-TEST FAIL · ${fail} of ${pass + fail} assertions failed`);
  return fail === 0;
}

// ── main. Runs only when this file is the script: importing it for its exports starts nothing ────────────────────
if (/q2-reword-stability(\.[cm]?ts)?$/.test(process.argv[1] ?? "")) (async () => {
  const args = process.argv.slice(2);
  if (args.some(x => x !== "--self-test")) { console.error(`unknown argument: ${args.filter(x => x !== "--self-test").join(" ")}\nusage: npx tsx tests/q2-reword-stability.ts [--self-test]   (K and ONLY are environment variables)`); process.exit(2); }
  // CLAUDE.md section 5: the offline harness runs before ANY live run. Enforced here, not remembered.
  const selfOk = await selfTest().catch(e => { console.log(`SELF-TEST FAIL · it threw: ${e instanceof Error ? e.message : String(e)}`); return false; });
  if (args.includes("--self-test")) process.exit(selfOk ? 0 : 1);
  if (!selfOk) { console.error("\nRefusing the live run: the self-test failed, so neither the set nor the counts could be trusted."); process.exit(1); }

  const K = Number(process.env.K ?? 3);
  if (!Number.isInteger(K) || K < 1) { console.error("K must be a positive integer"); process.exit(2); }
  const only = (process.env.ONLY ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const set = loadSet(); const bases = only.length ? set.bases.filter(b => only.includes(b.id)) : set.bases;
  if (!bases.length) { console.error(`ONLY matched no base: ${only.join(", ")}`); process.exit(2); }
  const key = devVar("ANTHROPIC_API_KEY");
  if (!key) { console.error("\nANTHROPIC_API_KEY not found (environment, or djzs-trust-mcp/.dev.vars). The live run is the operator's: a session without the key reports and stops."); process.exit(2); }

  const code = codeIdentity(); const nTexts = bases.reduce((s, b) => s + 1 + b.variants.length, 0);
  console.log(`\nQ2-REWORD rewording stability · LIVE · ${CLAUDE_MODEL} · ${EXTRACTION_CONTRACT_VERSION} · K=${K} · ${bases.length} base(s), ${nTexts} texts · ${nTexts * K * 3} model calls`);
  console.log(`  code ${code.repo_head?.slice(0, 7) ?? "unknown (git unavailable)"} · ${code.verdict_path_changes === null ? "working tree not checked" : code.verdict_path_changes.length ? `${code.verdict_path_changes.length} UNCOMMITTED CHANGE(S) ON THE VERDICT PATH OR THE SET, so this run measures the working tree, not the commit` : "verdict path and set clean"} · prompt ${code.prompt_sha256.slice(0, 14)} · set ${code.set_sha256.slice(0, 14)}`);
  console.log(`  a * marks a rewording whose modal verdict differs from its base's\n`);
  mkdirSync(OUT_DIR, { recursive: true });
  const out = `${OUT_DIR}/q2reword-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  const meta = { mode: "live", model: CLAUDE_MODEL, extraction_contract: EXTRACTION_CONTRACT_VERSION, ...code, thresholds: { stable_at: STABLE_AT, marginal_at: MARGINAL_AT, max_bases_without_mode: MAX_BASES_WITHOUT_MODE, min_k: MIN_K_FOR_A_READING }, started_at: new Date().toISOString() };
  try {
    const { summary } = await runSet(bases, K, anthropicModel(key), out, meta, bases.length === set.bases.length);
    report(summary, K, out);
  } catch (e) {
    console.error(`\nThe run stopped: ${e instanceof Error ? e.message : String(e)}\nWhat finished is in ${out}, marked incomplete. No reading is given for an incomplete run.`); process.exit(1);
  }
})();
