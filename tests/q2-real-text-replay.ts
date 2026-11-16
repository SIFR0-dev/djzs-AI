/**
 * Q2-REAL: REAL-TEXT REPLAY. Measurement only.
 *
 * Q2 measured the detector on short first-person intents written for the test (54 to 586 characters as rendered).
 * The Q3 study feeds it third-party news prose (up to 1,569). Of the eight sealed records that carry a thesis, seven
 * had a verdict-driving field demoted to unknown because the three samples disagreed. On Q2's own corpus the figure
 * is 102 of 490 runs. Eight runs is an observation, not a measurement. This is the measurement: replay each distinct
 * sealed narrative K times through the SAME extraction and the SAME engine, change nothing, and count.
 *
 * WHAT THIS FILE DOES NOT DO. It does not seal, grade, price or anchor. It writes nothing under tests/q3/. It does
 * not touch the extraction contract, the consensus merge or the engine. Evidence-unanimity is a standing ruling
 * (CLAUDE.md section 3). Nothing here reopens it. If the operator reopens it, these are the numbers to do it with.
 *
 * A replay is today's model on the sealed text. It does not re-create the sealed run, and the sealed verdict of
 * record does not change whatever this prints. Outcomes are not read: this measures reliability, not accuracy.
 * Replays inside one session share that session. A second run on another day is the cheap check on that.
 *
 * WHY A FIELD COMES OUT UNKNOWN. A scored field the engine receives as unknown got there one of three ways, and each
 * replay records which:
 *   STATE SPLIT     the three samples did not land on one state. Either the model wrote different states (model),
 *                   or it wrote the same state three times and the layer's per-sample checks demoted some (gate).
 *   EVIDENCE SPLIT  all three said absent with a verbatim quote, the quotes were not the identical span, and the
 *                   merge demoted the field. This is the evidence-unanimity rule working as written.
 *   ALL UNKNOWN     all three landed on unknown. No disagreement at all: the model stably reports it cannot tell.
 *
 * PRE-DECLARED READINGS. Written before the first live run. The operator may amend them before that run, not after.
 * One reading for evidence splits and one for state splits, same thresholds, scored fields only:
 *     SYSTEMATIC  on at least 2 distinct texts, the split occurs in at least 60% of replays (3 of K=5)
 *     NOISE       on no text does the split occur in more than 20% of replays (1 of K=5)
 *     UNRESOLVED  anything else: raise K on the affected texts before any ruling
 *   Reported, never judged here: all-unknown counts, the decided rate (PASS plus FAIL), verdict stability, and the
 *   engine-only counterfactual (the same replay with each evidence-split field kept absent).
 *   For every evidence split the three quotes are located in the text and the spans classed DISJOINT, OVERLAPPING
 *   or NESTED. Disjoint quotes are different claims by construction, which is the case the ruling exists for.
 *   Nested or overlapping quotes are one stretch of text cut at different boundaries. Whether that is one claim
 *   is the operator's reading, and every quote is saved so it can be made.
 *
 * The output keeps each sample's raw model output. Any alternative merge rule can therefore be scored offline
 * against these same samples, with no further model calls and no second draw to choose from.
 *
 * Cost: T texts x K replays x 3 samples. Six texts at K=5 is 90 calls, each about 3,000 tokens in and at most 1,024 out.
 *   npx tsx tests/q2-real-text-replay.ts               live. Operator shell only. Reads the key as q3-log does.
 *   npx tsx tests/q2-real-text-replay.ts --self-test   offline, no key, no cost. Proves the counting on synthetic samples.
 *   K=10 ONLY=q3-2026-09-14-001 npx tsx tests/q2-real-text-replay.ts     more replays on one text (no reading given)
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAuditInput, extractAuditInputConsensus, EXTRACTION_CONTRACT_VERSION, type ModelFn } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
import { PM_AUDIT_FIELDS, type AuditInput } from "../server/engine-v2/audit-input-schema";
import { renderIntentText, sha256hex, devVar } from "./q3/lib";

const REC_DIR = "tests/q3/records";
const Q2_OUT_DIR = "tests/out";
const CLAUDE_MODEL = "claude-sonnet-4-6"; // the model q3-log.ts used to produce the sealed verdicts
const SCORED: readonly string[] = PM_AUDIT_FIELDS; // invalidation_condition, resolution_engagement, probability_basis
const ADVISORY = "edge_claim"; // cannot change a verdict; its absent is worth 15 points, so it moves the risk band
const REPORTED = [...SCORED, ADVISORY];
const EVIDENCE_CAPABLE = ["resolution_engagement", "probability_basis", ADVISORY]; // PM fields whose absent carries a quote

// ── corpus: every distinct sealed text that carries a thesis, read exactly as q3-log rendered it ───────────────
type SealedRef = { id: string; deviated: boolean; verdict: string; risk: number; codes: string[]; unknown_fields: string[]; disagreements: string[] };
export type Text = { key: string; ids: string[]; primary: boolean; intent_sha256: string; text: string; chars: number; sealed: SealedRef[] };

export function loadCorpus(): { texts: Text[]; skipped: string[] } {
  const byHash = new Map<string, Text>(); const skipped: string[] = [];
  for (const f of readdirSync(REC_DIR).filter(x => x.endsWith(".json")).sort()) {
    for (const r of JSON.parse(readFileSync(`${REC_DIR}/${f}`, "utf8")) as Record<string, any>[]) {
      if (typeof r.intent?.thesis !== "string" || !r.intent.thesis.trim()) continue; // no_public_case: nothing to replay
      const text = renderIntentText(r.intent);
      // A replay is only worth reading if it is the sealed text, byte for byte.
      if (sha256hex(text) !== r.intent_sha256) { skipped.push(`${r.id}: rendered intent does not reproduce intent_sha256`); continue; }
      const t: Text = byHash.get(r.intent_sha256) ?? { key: r.id, ids: [], primary: false, intent_sha256: r.intent_sha256, text, chars: text.length, sealed: [] };
      t.ids.push(r.id); t.primary = t.primary || r.deviated === false;
      t.sealed.push({ id: r.id, deviated: r.deviated === true, verdict: r.engine?.verdict, risk: r.engine?.risk_score, codes: r.engine?.codes ?? [], unknown_fields: r.engine?.unknown_fields ?? [], disagreements: r.engine?.disagreements ?? [] });
      byHash.set(r.intent_sha256, t);
    }
  }
  return { texts: [...byHash.values()], skipped };
}

// ── one replay: the production path, untouched, plus the bookkeeping the sealed records never kept ─────────────
const collapse = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const normQuote = (s: string) => collapse(s).replace(/[.,;:!?]+$/, "").trim(); // the form the merge compares quotes in
const allSame = (xs: string[]) => xs.every(x => x === xs[0]);

export type Cause = "state_split" | "evidence_split" | "all_unknown";
export type SpanRelation = "disjoint" | "overlapping" | "nested" | "unlocated";
export type FieldRead = {
  merged: string;                        // the state the engine received
  cause: Cause | null;                   // why it is unknown, when it is
  split_origin: "model" | "gate" | null; // state splits only
  emitted: string[];                     // per sample, as the model wrote it
  effective: string[];                   // per sample, after the extraction layer's own per-sample gates
  quotes: (string | null)[];             // per sample, the quote the model attached
  shapes?: (string | null)[];            // resolution_engagement only
  gate_demotions: number;                // samples whose written present or absent did not survive the layer's per-sample checks
  span_relation: SpanRelation | null;    // evidence splits only
};
export type Replay = {
  in_scope: boolean; pm_votes: number; verdict: string; risk: number; codes: string[]; unknown_fields: string[];
  failsafe: boolean; unparsed_samples: number;
  disagreements: string[];               // the merge's own list, every field
  fields: Record<string, FieldRead>;     // the three scored fields and edge_claim
  counterfactual: { verdict: string; risk: number; codes: string[] } | null; // engine only: evidence-split fields kept absent
  consistent: boolean;                   // this file's reading of the samples agrees with what the merge reported
  raw: string[];                         // the three sample outputs, verbatim
};

/** A sample's JSON object as the model wrote it, located the way the extraction layer locates it. Null if it does not parse. */
function emittedObject(raw: string): Record<string, any> | null {
  try { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); const c = JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw); return c && typeof c === "object" && !Array.isArray(c) ? c : null; } catch { return null; }
}

/** Every place a quote occurs in the collapsed text, as [start, end) spans, matched the way the gate matches it. Null if nowhere. */
function occurrences(ct: string, quote: string | null): [number, number][] | null {
  if (quote === null) return null; const n = normQuote(quote); if (n === "") return null;
  const out: [number, number][] = []; for (let at = ct.indexOf(n); at >= 0; at = ct.indexOf(n, at + 1)) out.push([at, at + n.length]);
  return out.length ? out : null;
}

/** How the samples' quotes for one field sit in the text. A quote can occur more than once, so each pair is read at its
 *  closest placement; then the worst pair wins: disjoint, then overlapping, then nested. DISJOINT therefore means that
 *  some two of the quotes cannot be placed touching anywhere in the text. */
export function spanRelation(occ: ([number, number][] | null)[]): SpanRelation {
  if (occ.length < 2 || occ.some(o => !o)) return "unlocated";
  const rank = { nested: 0, overlapping: 1, disjoint: 2 } as const; let worst: keyof typeof rank = "nested";
  for (let i = 0; i < occ.length; i++) for (let j = i + 1; j < occ.length; j++) {
    let best: keyof typeof rank = "disjoint";
    for (const [a0, a1] of occ[i]!) for (const [b0, b1] of occ[j]!) {
      const rel: keyof typeof rank = a1 <= b0 || b1 <= a0 ? "disjoint" : (a0 <= b0 && b1 <= a1) || (b0 <= a0 && a1 <= b1) ? "nested" : "overlapping";
      if (rank[rel] < rank[best]) best = rel;
    }
    if (rank[best] > rank[worst]) worst = best;
  }
  return worst;
}

/** The merge is the authority. This only confirms that this file read the same three samples the merge did. */
export function agreesWithMerge(merged: string, stateSplit: boolean, evidenceSplit: boolean, effective: string[]): boolean {
  if (effective.length !== 3) return false;
  if (stateSplit !== !allSame(effective)) return false;                     // a state split is reported exactly when the samples differ
  if (evidenceSplit && !effective.every(s => s === "absent")) return false; // an evidence split needs three surviving absents
  return stateSplit || evidenceSplit ? merged === "unknown" : merged === effective[0];
}

/** `consensus` is the production merge. It is a parameter only so the self-test can hand in a tampered one and watch the consistency check trip. */
export async function replayOnce(text: string, model: ModelFn, consensus: typeof extractAuditInputConsensus = extractAuditInputConsensus): Promise<Replay> {
  const x = await consensus(text, model, 3); // exactly q3-log's Phase A call: N=3, default (PM) contract
  let raw: string[] = []; try { const p = JSON.parse(x.raw); if (Array.isArray(p)) raw = p.map(String); } catch { /* reported as inconsistent below */ }
  // Each sample once more through the layer's own single-sample path. Its real gates run, no model is called, and
  // nothing about those gates is re-implemented in this file.
  const singles = await Promise.all(raw.map(r => extractAuditInput(text, async () => r)));
  const objs = raw.map(emittedObject); const ct = collapse(text);
  const pm_votes = singles.filter(s => s.input.audit_context === "prediction_market").length;
  const in_scope = x.input.audit_context === "prediction_market";
  let consistent = in_scope === (pm_votes >= 2); // the per-field check below also fails on anything but three samples

  const fields: Record<string, FieldRead> = {};
  for (const f of REPORTED) {
    const emitted = objs.map(o => { const v = o?.[f]; return o === null ? "(unparsed)" : v === undefined || v === null ? "(missing)" : typeof v !== "object" ? "(bare value)" : typeof v.state === "string" ? v.state : "(no state)"; });
    const quotes = objs.map(o => { const v = o?.[f]; return v && typeof v === "object" && typeof v.quote === "string" && v.quote.trim() !== "" ? v.quote as string : null; });
    const effective = singles.map(s => ((s.input as unknown as Record<string, { state: string }>)[f]?.state) ?? "unknown");
    const merged = ((x.input as unknown as Record<string, { state: string }>)[f]?.state) ?? "unknown";
    const stateSplit = x.disagreements.includes(f), evidenceSplit = x.disagreements.includes(`${f}(evidence)`);
    const cause: Cause | null = merged !== "unknown" ? null : evidenceSplit ? "evidence_split" : stateSplit ? "state_split" : "all_unknown";
    const read: FieldRead = {
      merged, cause, split_origin: cause === "state_split" ? (allSame(emitted) ? "gate" : "model") : null, emitted, effective, quotes,
      gate_demotions: emitted.filter((s, i) => (s === "absent" || s === "present") && effective[i] !== s).length,
      span_relation: cause === "evidence_split" ? spanRelation(quotes.map(q => occurrences(ct, q))) : null,
    };
    if (f === "resolution_engagement") read.shapes = objs.map(o => (typeof o?.[f]?.shape === "string" ? o[f].shape as string : null));
    fields[f] = read;
    if (!agreesWithMerge(merged, stateSplit, evidenceSplit, effective)) consistent = false;
  }

  const base = { in_scope, pm_votes, failsafe: x.failsafe, unparsed_samples: objs.filter(o => o === null).length, disagreements: x.disagreements, fields, consistent, raw };
  if (!in_scope) return { ...base, verdict: "OUT_OF_SCOPE", risk: 0, codes: [], unknown_fields: [], counterfactual: null }; // as q3-log records it
  const e = runDeterministicAudit(x.input);
  const kept = EVIDENCE_CAPABLE.filter(f => fields[f].cause === "evidence_split");
  let counterfactual: Replay["counterfactual"] = null;
  if (kept.length) { // the frozen engine on the same merged input, with the agreed absents kept. No model involved.
    const alt = { ...x.input } as Record<string, unknown>; for (const f of kept) alt[f] = { state: "absent" };
    const c = runDeterministicAudit(alt as unknown as AuditInput);
    counterfactual = { verdict: c.verdict, risk: c.risk_score, codes: c.flags.map(fl => fl.code).sort() };
  }
  return { ...base, verdict: e.verdict, risk: e.risk_score, codes: e.flags.map(fl => fl.code).sort(), unknown_fields: e.unknown_fields, counterfactual };
}

// ── summary and the pre-declared readings ──────────────────────────────────────────────────────────────────────
export type TextResult = Omit<Text, "text"> & { replays: Replay[] };
const votes = (xs: string[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return c; };
const fmtVotes = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
const scoredCause = (c: Cause) => (r: Replay) => SCORED.some(f => r.fields[f].cause === c);

export function reading(results: TextResult[], K: number, fullCorpus: boolean, cause: "evidence_split" | "state_split"): { label: string; per_text: Record<string, number> } {
  const per_text: Record<string, number> = {}; for (const t of results) per_text[t.key] = t.replays.filter(scoredCause(cause)).length;
  if (!fullCorpus) return { label: "NOT EVALUATED (subset run)", per_text };
  if (results.some(t => t.replays.some(r => !r.consistent))) return { label: "VOID (a replay failed its consistency check)", per_text };
  const hi = Math.ceil((3 * K) / 5), lo = Math.floor(K / 5), counts = Object.values(per_text); // 60% and 20%, in whole numbers
  if (counts.filter(n => n >= hi).length >= 2) return { label: "SYSTEMATIC", per_text };
  if (Math.max(0, ...counts) <= lo) return { label: "NOISE", per_text };
  return { label: "UNRESOLVED", per_text };
}

function fieldTable(replays: Replay[]) {
  const out: Record<string, unknown> = {};
  for (const f of REPORTED) {
    const rs = replays.map(r => r.fields[f]); const n = (p: (r: FieldRead) => boolean) => rs.filter(p).length;
    const absentQuotes = new Set<string>(); for (const r of rs) r.effective.forEach((s, i) => { if (s === "absent" && r.quotes[i]) absentQuotes.add(normQuote(r.quotes[i]!)); });
    out[f] = {
      scored: SCORED.includes(f), present: n(r => r.merged === "present"), absent: n(r => r.merged === "absent"), unknown: n(r => r.merged === "unknown"),
      state_split: n(r => r.cause === "state_split"), state_split_by_model: n(r => r.split_origin === "model"), state_split_by_gate: n(r => r.split_origin === "gate"),
      evidence_split: n(r => r.cause === "evidence_split"), all_unknown: n(r => r.cause === "all_unknown"),
      span_relations: votes(rs.filter(r => r.span_relation).map(r => r.span_relation!)),
      sample_states: votes(rs.flatMap(r => r.effective)), sample_gate_demotions: rs.reduce((s, r) => s + r.gate_demotions, 0), distinct_absent_quotes: absentQuotes.size,
    };
  }
  return out as Record<string, Record<string, any>>;
}

export function summarize(results: TextResult[], K: number, fullCorpus: boolean) {
  const all = results.flatMap(t => t.replays); const n = all.length || 1; const cf = all.filter(r => r.counterfactual);
  return {
    texts: results.length, replays: all.length, model_calls: all.length * 3,
    verdict_votes: votes(all.map(r => r.verdict)),
    decided_rate: all.filter(r => r.verdict === "PASS" || r.verdict === "FAIL").length / n,
    verdict_stability: results.length ? results.reduce((s, t) => s + Math.max(0, ...Object.values(votes(t.replays.map(r => r.verdict)))) / (t.replays.length || 1), 0) / results.length : 0,
    replays_with_scored_disagreement: all.filter(r => scoredCause("state_split")(r) || scoredCause("evidence_split")(r)).length,
    replays_with_scored_state_split: all.filter(scoredCause("state_split")).length,
    replays_with_scored_evidence_split: all.filter(scoredCause("evidence_split")).length,
    replays_with_scored_all_unknown: all.filter(scoredCause("all_unknown")).length,
    fields: fieldTable(all),
    counterfactual: { replays: cf.length, verdict_votes: votes(cf.map(r => r.counterfactual!.verdict)), verdict_differs: cf.filter(r => r.counterfactual!.verdict !== r.verdict).length, risk_differs: cf.filter(r => r.counterfactual!.risk !== r.risk).length },
    out_of_scope: all.filter(r => !r.in_scope).length, split_context_votes: all.filter(r => r.pm_votes !== 0 && r.pm_votes !== 3).length,
    failsafes: all.filter(r => r.failsafe).length, unparsed_samples: all.reduce((s, r) => s + r.unparsed_samples, 0),
    consistency_errors: all.filter(r => !r.consistent).length,
    reading_evidence_split: reading(results, K, fullCorpus, "evidence_split"),
    reading_state_split: reading(results, K, fullCorpus, "state_split"),
  };
}

/** The same count on Q2's own tracked runs, PM classes only, read from disk so the comparison is not a number typed in here. */
export function q2Baseline(dir = Q2_OUT_DIR): { files: number; runs: number; disagreement: number; state_split: number; evidence_split: number } | null {
  const PM_CLASSES = new Set(["FULL", "NO_INVALIDATION", "NO_RESOLUTION", "NO_PROBABILITY", "AMBIGUOUS"]);
  let files = 0, runs = 0, disagreement = 0, state_split = 0, evidence_split = 0;
  try {
    for (const f of readdirSync(dir).filter(x => /^q2-live-.*\.json$/.test(x)).sort()) {
      const d = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { results?: { cls?: string; runs?: { disagreements?: string[] }[] }[] }; let used = false;
      for (const c of d.results ?? []) { if (!PM_CLASSES.has(String(c.cls))) continue;
        for (const r of c.runs ?? []) { const dis = r.disagreements ?? [];
          const st = dis.some(x => SCORED.includes(x)), ev = dis.some(x => x.endsWith("(evidence)") && SCORED.includes(x.slice(0, -"(evidence)".length)));
          runs++; used = true; if (st || ev) disagreement++; if (st) state_split++; if (ev) evidence_split++; } }
      if (used) files++;
    }
  } catch { return null; }
  return runs ? { files, runs, disagreement, state_split, evidence_split } : null;
}

// ── the run loop, shared by live and self-test. Checkpoints after every text: a dead run keeps what it finished ─
const short = (id: string) => id.replace(/^q3-/, "");
export async function runCorpus(texts: Text[], K: number, model: ModelFn, outPath: string, meta: Record<string, unknown>, fullCorpus: boolean, log = (s: string) => console.log(s)) {
  const results: TextResult[] = [];
  const save = () => writeFileSync(outPath, JSON.stringify({ ...meta, K, complete: results.length === texts.length, summary: summarize(results, K, fullCorpus), results }, null, 2) + "\n");
  save();
  for (const t of texts) {
    const { text, ...rest } = t; const replays: Replay[] = [];
    for (let k = 0; k < K; k++) replays.push(await replayOnce(text, model));
    results.push({ ...rest, replays }); save();
    log(`  ${t.ids.map(short).join(" = ").padEnd(28)} ${String(t.chars).padStart(5)} ch  ${t.primary ? "primary" : "pilot  "}  ${fmtVotes(votes(replays.map(r => r.verdict)))}`);
    const ft = fieldTable(replays);
    for (const f of REPORTED) { const c = ft[f]; if (!c.unknown) continue;
      const parts = [c.state_split ? `state split ${c.state_split} (model ${c.state_split_by_model}, gate ${c.state_split_by_gate})` : "", c.evidence_split ? `evidence split ${c.evidence_split} (${fmtVotes(c.span_relations)})` : "", c.all_unknown ? `all unknown ${c.all_unknown}` : ""].filter(Boolean).join(" · ");
      log(`      ${(f + (c.scored ? "" : " (advisory)")).padEnd(32)} unknown ${c.unknown}/${K}: ${parts}   samples: ${fmtVotes(c.sample_states)}${c.distinct_absent_quotes > 1 ? `, ${c.distinct_absent_quotes} distinct quotes` : ""}`); }
    const cf = replays.filter(r => r.counterfactual);
    if (cf.length) log(`      agreed absent kept: ${fmtVotes(votes(cf.map(r => `${r.counterfactual!.verdict} at ${r.counterfactual!.risk}`)))}`);
    const bad = replays.filter(r => !r.consistent).length; if (bad) log(`      CONSISTENCY CHECK FAILED on ${bad} replay(s): do not read these numbers`);
  }
  return { results, summary: summarize(results, K, fullCorpus) };
}

// ── the printed summary. A function so the self-test runs it too: it must not be able to fail after a paid run ──
export function report(s: ReturnType<typeof summarize>, K: number, out: string, log = (line: string) => console.log(line)) {
  const pct = (x: number, of: number) => (of ? `${Math.round((100 * x) / of)}%` : "n/a"); const N = s.replays; const b = q2Baseline();
  log(`\nverdicts                   ${fmtVotes(s.verdict_votes)}   decided (PASS or FAIL) ${pct(s.decided_rate * N, N)}   stability ${s.verdict_stability.toFixed(3)}`);
  log(`scored-field disagreement  ${s.replays_with_scored_disagreement}/${N} replays (${pct(s.replays_with_scored_disagreement, N)})${b ? `   Q2 synthetic corpus, ${b.files} tracked runs: ${b.disagreement}/${b.runs} (${pct(b.disagreement, b.runs)})` : ""}`);
  log(`  state split              ${s.replays_with_scored_state_split}/${N}${b ? `   Q2: ${b.state_split}/${b.runs}` : ""}`);
  log(`  evidence split           ${s.replays_with_scored_evidence_split}/${N}${b ? `   Q2: ${b.evidence_split}/${b.runs}` : ""}`);
  log(`all three say unknown      ${s.replays_with_scored_all_unknown}/${N} replays (stable abstention, not disagreement)`);
  for (const f of REPORTED) { const c = s.fields[f]; log(`  ${(f + (c.scored ? "" : " (advisory)")).padEnd(34)} present ${c.present} · absent ${c.absent} · unknown ${c.unknown} = state split ${c.state_split} (model ${c.state_split_by_model}, gate ${c.state_split_by_gate}) + evidence split ${c.evidence_split} + all unknown ${c.all_unknown}`); }
  log(`quote spans in splits      ${REPORTED.map(f => (Object.keys(s.fields[f].span_relations).length ? `${f}: ${fmtVotes(s.fields[f].span_relations)}` : "")).filter(Boolean).join(" · ") || "none"}`);
  log(`agreed absent kept         ${s.counterfactual.replays}/${N} replays have one: ${fmtVotes(s.counterfactual.verdict_votes)} · verdict differs in ${s.counterfactual.verdict_differs}, risk differs in ${s.counterfactual.risk_differs} (engine only: a count, not a recommendation)`);
  log(`out of scope ${s.out_of_scope}/${N} · split context votes ${s.split_context_votes}/${N} · failsafe ${s.failsafes}/${N} · unparsed samples ${s.unparsed_samples}/${N * 3} · consistency errors ${s.consistency_errors}`);
  const perText = (r: { per_text: Record<string, number> }) => Object.entries(r.per_text).map(([k, n]) => `${short(k)} ${n}/${K}`).join(", ");
  log(`\nPRE-DECLARED READING, evidence splits   ${s.reading_evidence_split.label}\n    ${perText(s.reading_evidence_split)}`);
  log(`PRE-DECLARED READING, state splits      ${s.reading_state_split.label}\n    ${perText(s.reading_state_split)}`);
  log(`\nEvery replay, every sample's raw output and quotes: ${out}\nCommit that file as the evidence. Nothing else was written.`);
}

// ── model: the same request body q3-log.ts anthropicModel() sends. Only transport differs: a per-call timeout and more patient retries ─
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

// ── self-test: synthetic samples through the REAL consensus merge and the REAL engine. No key, no network ──────
const ST_TEXT = "market: Test market\nside: YES\nthesis: Analysts say a hike is all but certain. Traders put the odds at nine in ten. The desk will exit if the print comes in soft.";
const stSample = (over: Record<string, unknown> = {}) => JSON.stringify({
  agent_type: "self-test", intended_action: "bet", market_type: "prediction_market", audit_context: "prediction_market",
  leverage: { state: "absent" }, position_size: { state: "present", value: 100 }, stop_loss: { state: "absent" }, take_profit: { state: "absent" },
  invalidation_condition: { state: "present", value: "exit if the print comes in soft" },
  resolution_engagement: { state: "present", value: "argues the hike itself" },
  probability_basis: { state: "present", value: "CME FedWatch 90%" }, edge_claim: { state: "present", value: "stub edge" },
  data_sources: { state: "absent" }, oracle_source: { state: "absent" }, confidence: { state: "absent" }, ...over });
/** A model that hands out the given sample outputs in rotation, one per call. */
const scripted = (outs: string[]): ModelFn => { let i = 0; return async () => outs[i++ % outs.length]; };
const absent = (quote: string, shape?: string) => (shape ? { state: "absent", shape, quote } : { state: "absent", quote });
const basis = (...quotes: string[]) => scripted(quotes.map(q => stSample({ probability_basis: absent(q) })));

/** Seeded noise over a sealed text: states drawn at random, absents quoting real spans of that text at shifting boundaries. */
function noisy(seed: number): ModelFn {
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  return async (prompt) => {
    if (rnd() < 0.03) return "the model returned prose, not JSON";
    const words = collapse(prompt.slice(prompt.lastIndexOf("AGENT INTENT:") + "AGENT INTENT:".length)).split(" "); const w0 = Math.min(12, Math.max(0, words.length - 30));
    const span = () => { const start = w0 + pick([0, 0, 0, 2, 20]); return words.slice(start, start + pick([5, 5, 8])).join(" "); };
    const tri = (mk: () => unknown) => { const r = rnd(); return r < 0.2 ? { state: "present", value: "stub" } : r < 0.7 ? mk() : { state: "unknown" }; };
    return stSample({
      invalidation_condition: tri(() => ({ state: "absent" })), probability_basis: tri(() => absent(span())), edge_claim: tri(() => absent(span())),
      resolution_engagement: tri(() => (rnd() < 0.3 ? absent(span()) : absent(span(), pick(["a", "b", "c", "d"])))),
      ...(rnd() < 0.1 ? { audit_context: "perp" } : {}) });
  };
}

async function selfTest(): Promise<boolean> {
  let pass = 0, fail = 0;
  const ok = (cond: boolean, label: string, got?: unknown) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}${got !== undefined ? `\n       got ${JSON.stringify(got)}` : ""}`); } };
  const lean = (r: Replay) => ({ verdict: r.verdict, risk: r.risk, codes: r.codes, unknown_fields: r.unknown_fields, disagreements: r.disagreements, counterfactual: r.counterfactual, consistent: r.consistent, pb: r.fields.probability_basis, re: r.fields.resolution_engagement });
  const pb = (r: Replay) => r.fields.probability_basis;
  const seen: Replay[] = []; const run = async (m: ModelFn) => { const r = await replayOnce(ST_TEXT, m); seen.push(r); return r; };

  console.log("SELF-TEST · classification on synthetic samples (real merge, real engine)");
  const a = await run(scripted([stSample()]));
  ok(a.verdict === "PASS" && a.risk === 0 && REPORTED.every(f => a.fields[f].merged === "present" && a.fields[f].cause === null) && a.counterfactual === null && a.pm_votes === 3, "three agreeing present samples: PASS at 0, nothing unknown, no counterfactual", lean(a));

  const b = await run(basis("a hike is all but certain", "the odds at nine in ten", "Analysts say"));
  ok(b.verdict === "WAIT" && b.risk === 0 && pb(b).cause === "evidence_split" && pb(b).merged === "unknown" && pb(b).gate_demotions === 0 && allSame(pb(b).effective) && pb(b).effective[0] === "absent", "three absents quoting different sentences: evidence split, WAIT at 0", lean(b));
  ok(pb(b).span_relation === "disjoint", "those quotes are classed disjoint", pb(b));
  ok(b.counterfactual?.verdict === "FAIL" && b.counterfactual.risk === 25 && b.counterfactual.codes.join() === "DJZS-M03", "kept absent, the engine returns FAIL at 25 on the unsourced probability", b.counterfactual);

  const c = await run(basis("Traders put the odds at nine in ten", "the odds at nine in ten", "odds at nine"));
  ok(pb(c).cause === "evidence_split" && pb(c).span_relation === "nested", "one stretch cut at three boundaries: evidence split, classed nested", pb(c));
  const c2 = await run(basis("a hike is all but certain. Traders put", "Traders put the odds at nine in ten", "certain. Traders put the odds"));
  ok(pb(c2).cause === "evidence_split" && pb(c2).span_relation === "overlapping", "staggered boundaries: classed overlapping", pb(c2));

  const c3 = await run(basis("TRADERS PUT THE ODDS AT NINE IN TEN", "the  odds at nine in ten.", "Odds At Nine"));
  ok(pb(c3).cause === "evidence_split" && pb(c3).span_relation === "nested", "quotes are located the way the gate matches them: case, spacing and a trailing stop ignored", pb(c3));

  const c4 = await run(basis("The desk will exit if the print comes in soft", "the print", "the"));
  ok(pb(c4).cause === "evidence_split" && pb(c4).span_relation === "nested", "a short quote that first occurs elsewhere is still read as nested where it can be", pb(c4));

  const d = await run(scripted([stSample(), stSample({ probability_basis: absent("a hike is all but certain") }), stSample({ probability_basis: { state: "unknown" } })]));
  ok(pb(d).cause === "state_split" && pb(d).split_origin === "model" && d.counterfactual === null && d.verdict === "WAIT", "present / absent / unknown: state split made by the model, no counterfactual", lean(d));
  const d2 = await run(basis("a hike is all but certain", "a hike is all but certain", "a hike is almost certain"));
  ok(pb(d2).cause === "state_split" && pb(d2).split_origin === "gate" && pb(d2).gate_demotions === 1 && allSame(pb(d2).emitted) && pb(d2).effective.join() === "absent,absent,unknown" && d2.verdict === "WAIT", "three absents, one quote not in the text: state split made by the gate", lean(d2));

  const e = await run(basis("a hike is all but certain"));
  ok(e.verdict === "FAIL" && e.risk === 25 && pb(e).merged === "absent" && pb(e).cause === null, "three absents with the identical quote: FAIL at 25, nothing unknown", lean(e));
  const f = await run(basis("a hike is all but certain", "A hike is  all but certain.", "a hike is all but CERTAIN"));
  ok(f.verdict === "FAIL" && pb(f).cause === null, "quotes differing only in case, spacing or a trailing stop are not a split", lean(f));

  const h = await run(basis("this sentence is not in the text"));
  ok(h.verdict === "WAIT" && pb(h).cause === "all_unknown" && pb(h).gate_demotions === 3 && !h.disagreements.includes("probability_basis") && h.counterfactual === null, "three absents whose quote is not in the text: all unknown, no disagreement recorded, three gate demotions", lean(h));
  const h2 = await run(scripted([stSample({ probability_basis: { state: "unknown" } })]));
  ok(pb(h2).cause === "all_unknown" && pb(h2).gate_demotions === 0 && h2.verdict === "WAIT", "three samples that say unknown: all unknown, no gate involved", lean(h2));

  const h3 = await run(scripted([stSample({ probability_basis: "CME FedWatch puts it at 90%" })]));
  ok(h3.verdict === "PASS" && pb(h3).merged === "present" && pb(h3).emitted.join() === "(bare value),(bare value),(bare value)" && pb(h3).gate_demotions === 0, "a bare stated value is read as present, as the layer reads it", lean(h3));
  const h4 = await run(scripted([JSON.stringify({ ...JSON.parse(stSample()), probability_basis: undefined })]));
  ok(pb(h4).cause === "all_unknown" && pb(h4).emitted[0] === "(missing)" && pb(h4).gate_demotions === 0 && h4.verdict === "WAIT", "a field the model left out is unknown, with no demotion counted", lean(h4));
  const h5 = await run(scripted([stSample(), stSample(), stSample({ probability_basis: { state: "present", value: "" } })]));
  ok(pb(h5).cause === "state_split" && pb(h5).split_origin === "gate" && pb(h5).gate_demotions === 1 && pb(h5).effective.join() === "present,present,unknown", "a present with no value does not survive: state split made by the layer, one demotion", lean(h5));

  const i1 = await run(scripted([stSample({ resolution_engagement: absent("Analysts say a hike is all but certain", "a") })]));
  ok(i1.verdict === "FAIL" && i1.risk === 30 && i1.codes.join() === "DJZS-M01" && i1.fields.resolution_engagement.shapes?.join() === "a,a,a", "three identical engagement absents with a shape: FAIL at 30", lean(i1));
  const i2 = await run(scripted([stSample({ resolution_engagement: absent("Analysts say a hike is all but certain") })]));
  ok(i2.fields.resolution_engagement.cause === "all_unknown" && i2.fields.resolution_engagement.gate_demotions === 3 && i2.verdict === "WAIT", "the same absents without a shape do not survive the gate", lean(i2));

  const g = await run(scripted(["not json at all"]));
  ok(g.failsafe === true && g.unparsed_samples === 3 && g.verdict === "OUT_OF_SCOPE" && g.in_scope === false, "three unparseable samples: failsafe, recorded out of scope as q3-log records it", lean(g));
  const g2 = await run(scripted([stSample(), stSample(), "not json at all"]));
  ok(g2.failsafe === false && g2.unparsed_samples === 1 && g2.in_scope && g2.verdict === "WAIT" && SCORED.every(x => g2.fields[x].cause === "state_split" && g2.fields[x].split_origin === "model"), "one unparseable sample of three: in scope, every scored field state-split", lean(g2));
  const j = await run(scripted([stSample(), stSample({ audit_context: "perp" }), stSample({ audit_context: "perp" })]));
  ok(j.in_scope === false && j.pm_votes === 1 && j.verdict === "OUT_OF_SCOPE", "one context vote of three: out of scope", lean(j));

  const k = await run(scripted(["a hike is all but certain", "the odds at nine in ten", "Analysts say"].map(q => stSample({ edge_claim: absent(q) }))));
  ok(k.verdict === "PASS" && k.risk === 0 && k.fields.edge_claim.cause === "evidence_split" && k.counterfactual?.verdict === "PASS" && k.counterfactual.risk === 15, "an evidence split on the advisory field alone: verdict holds, the kept absent adds 15", lean(k));

  const k2 = await run(scripted(["a hike is all but certain", "the odds at nine in ten", "Analysts say"].map(q => stSample({ resolution_engagement: absent(q, "a"), probability_basis: absent(q), edge_claim: absent(q) }))));
  ok(k2.verdict === "WAIT" && k2.risk === 0 && EVIDENCE_CAPABLE.every(x => k2.fields[x].cause === "evidence_split") && k2.counterfactual?.verdict === "FAIL" && k2.counterfactual.risk === 70 && k2.counterfactual.codes.join() === "DJZS-M01,DJZS-M03,DJZS-M04", "three fields evidence-split at once: the counterfactual keeps all three", lean(k2));

  ok(seen.every(r => r.consistent), "every replay above passes its consistency check", seen.map(r => r.consistent));
  const dModel = () => scripted([stSample(), stSample({ probability_basis: absent("a hike is all but certain") }), stSample({ probability_basis: { state: "unknown" } })]);
  const tampered = (change: (x: Awaited<ReturnType<typeof extractAuditInputConsensus>>) => Partial<Awaited<ReturnType<typeof extractAuditInputConsensus>>>): typeof extractAuditInputConsensus => async (t, m, n, ctx) => { const x = await extractAuditInputConsensus(t, m, n, ctx); return { ...x, ...change(x) }; };
  const t1 = await replayOnce(ST_TEXT, dModel(), tampered(() => ({ disagreements: [] })));
  const t2 = await replayOnce(ST_TEXT, dModel(), tampered(x => ({ raw: JSON.stringify(Array(3).fill(JSON.parse(x.raw)[0])) })));
  const t3 = await replayOnce(ST_TEXT, dModel(), tampered(() => ({ raw: "not the three samples" })));
  const t4 = await replayOnce(ST_TEXT, dModel(), tampered(x => ({ input: { ...x.input, audit_context: undefined } })));
  ok((await replayOnce(ST_TEXT, dModel())).consistent && !t1.consistent && !t2.consistent && !t3.consistent && !t4.consistent, "a merge result that does not match its own samples is flagged: lost disagreement, swapped samples, missing samples, wrong scope", [t1.consistent, t2.consistent, t3.consistent, t4.consistent]);
  const A3 = ["absent", "absent", "absent"], P3 = ["present", "present", "present"], mixedStates = ["present", "absent", "absent"];
  ok(agreesWithMerge("present", false, false, P3) && agreesWithMerge("absent", false, false, A3) && agreesWithMerge("unknown", true, false, mixedStates) && agreesWithMerge("unknown", false, true, A3), "the consistency check accepts the four shapes a merge can produce");
  ok(!agreesWithMerge("unknown", false, false, mixedStates) && !agreesWithMerge("unknown", true, false, A3), "it fires when a state split is reported without differing samples, or the reverse");
  ok(!agreesWithMerge("unknown", true, true, ["absent", "absent", "unknown"]), "it fires when an evidence split is reported without three surviving absents");
  ok(!agreesWithMerge("absent", false, true, A3) && !agreesWithMerge("present", false, false, A3) && !agreesWithMerge("present", true, false, mixedStates) && !agreesWithMerge("present", false, false, ["present", "present"]), "it fires when the merged state is not what the samples imply, or a sample is missing");
  ok(spanRelation([[[0, 5]], null, [[2, 4]]]) === "unlocated" && spanRelation([[[0, 5]], [[5, 9]]]) === "disjoint" && spanRelation([[[0, 9]], [[2, 4]], [[0, 9]]]) === "nested", "span relation edge cases");
  ok(spanRelation([[[20, 40]], [[0, 3], [25, 28]]]) === "nested" && spanRelation([[[0, 10]], [[2, 4], [50, 53]]]) === "nested" && spanRelation([[[20, 40]], [[0, 3], [38, 41]]]) === "overlapping" && spanRelation([[[20, 40]], [[0, 3], [50, 53]]]) === "disjoint", "a quote that occurs twice is read at its closest placement, whichever occurrence comes first");

  const hand = summarize([{ key: "hand", ids: ["hand"], primary: true, intent_sha256: "hand", chars: 0, sealed: [], replays: [a, b, c, d, d2, e, h, k, h5] }], 9, true);
  const hp = hand.fields.probability_basis;
  ok(hand.replays === 9 && hand.model_calls === 27 && hand.verdict_votes.PASS === 2 && hand.verdict_votes.WAIT === 6 && hand.verdict_votes.FAIL === 1 && hand.decided_rate === 3 / 9 && hand.verdict_stability === 6 / 9, "summary of nine known replays: verdict counts, decided rate, stability", hand);
  ok(hand.replays_with_scored_disagreement === 5 && hand.replays_with_scored_state_split === 3 && hand.replays_with_scored_evidence_split === 2 && hand.replays_with_scored_all_unknown === 1, "summary: five disagreements (three state, two evidence), one stable abstention, the advisory split not counted", hand);
  ok(hp.present === 2 && hp.absent === 1 && hp.unknown === 6 && hp.state_split === 3 && hp.state_split_by_model === 1 && hp.state_split_by_gate === 2 && hp.evidence_split === 2 && hp.all_unknown === 1 && hp.span_relations.disjoint === 1 && hp.span_relations.nested === 1 && hp.sample_gate_demotions === 5 && hand.fields.edge_claim.evidence_split === 1 && hand.fields.edge_claim.scored === false, "summary: the per-field table matches the nine replays", hand.fields);
  ok(hand.counterfactual.replays === 3 && hand.counterfactual.verdict_differs === 2 && hand.counterfactual.risk_differs === 3 && hand.counterfactual.verdict_votes.FAIL === 2 && hand.counterfactual.verdict_votes.PASS === 1 && hand.out_of_scope === 0 && hand.consistency_errors === 0, "summary: three counterfactuals, two change the verdict, all three change the risk", hand.counterfactual);
  ok(hp.sample_states.absent === 12 && hp.sample_states.present === 9 && hp.sample_states.unknown === 6 && hp.distinct_absent_quotes === 5, "summary: sample-level states and distinct surviving quotes", hp);

  ok(summarize([{ key: "f", ids: ["f"], primary: true, intent_sha256: "f", chars: 0, sealed: [], replays: [f] }], 1, true).fields.probability_basis.distinct_absent_quotes === 1 && summarize([{ key: "c3", ids: ["c3"], primary: true, intent_sha256: "c3", chars: 0, sealed: [], replays: [c3] }], 1, true).fields.probability_basis.distinct_absent_quotes === 3, "distinct quotes are counted in the form the merge compares them in");

  console.log("SELF-TEST · the pre-declared readings");
  const withCause = (cause: Cause | null, field = "probability_basis"): Replay => ({ ...a, fields: { ...a.fields, [field]: { ...a.fields[field], cause } } });
  const mk = (key: string, hits: number, K: number, cause: Cause = "evidence_split", field?: string): TextResult => ({ key, ids: [key], primary: true, intent_sha256: key, chars: 0, sealed: [], replays: Array.from({ length: K }, (_, n) => withCause(n < hits ? cause : null, field)) });
  const rd = (counts: number[], K = 5, full = true) => reading(counts.map((n, x) => mk(`t${x}`, n, K)), K, full, "evidence_split").label;
  ok(rd([3, 3, 0, 0, 0, 0]) === "SYSTEMATIC", "two texts at 3 of 5: SYSTEMATIC");
  ok(rd([5, 2, 2, 2, 2, 2]) === "UNRESOLVED", "one text high, the rest in between: UNRESOLVED");
  ok(rd([1, 1, 0, 0, 1, 0]) === "NOISE" && rd([0, 0, 0, 0, 0, 0]) === "NOISE", "never more than 1 of 5: NOISE");
  ok(rd([2, 0, 0, 0, 0, 0]) === "UNRESOLVED", "a single text at 2 of 5: UNRESOLVED");
  ok(rd([6, 6, 0], 10) === "SYSTEMATIC" && rd([2, 2, 2], 10) === "NOISE" && rd([3, 0, 0], 10) === "UNRESOLVED" && rd([9, 9, 0], 15) === "SYSTEMATIC" && rd([8, 8, 0], 15) === "UNRESOLVED" && rd([3, 3, 3], 15) === "NOISE", "thresholds scale with K (60% and 20%, whole numbers)");
  ok(rd([5, 5, 5], 5, false).startsWith("NOT EVALUATED"), "a subset run is never given a reading");
  const mixed = [mk("t0", 5, 5, "state_split"), mk("t1", 5, 5, "state_split"), mk("t2", 5, 5, "all_unknown")];
  ok(reading(mixed, 5, true, "evidence_split").label === "NOISE" && reading(mixed, 5, true, "state_split").label === "SYSTEMATIC", "each reading counts its own cause only, and all-unknown counts toward neither");
  ok(reading([mk("t0", 5, 5, "evidence_split", ADVISORY), mk("t1", 5, 5, "evidence_split", ADVISORY)], 5, true, "evidence_split").label === "NOISE", "a split on the advisory field alone does not count toward a reading");
  ok(reading([mk("t0", 5, 5), { ...mk("t1", 5, 5), replays: [{ ...withCause("evidence_split"), consistent: false }] }], 5, true, "evidence_split").label.startsWith("VOID"), "one inconsistent replay voids the reading");

  console.log("SELF-TEST · the sealed corpus loads and the run loop checkpoints");
  const { texts, skipped } = loadCorpus();
  ok(skipped.length === 0, "every thesis-bearing sealed record reproduces its intent_sha256", skipped);
  ok(texts.length >= 6 && texts.reduce((s, t) => s + t.ids.length, 0) >= 8, "at least six distinct texts from at least eight thesis-bearing records", texts.map(t => t.ids));
  ok(texts.some(t => t.ids.length === 2), "cross-venue twins are replayed once, not twice");
  if (texts.length < 6) { console.log(`SELF-TEST FAIL · ${fail} of ${pass + fail} assertions failed (the sealed corpus did not load, the rest was not run)`); return false; }
  const out = join(tmpdir(), `q2real-selftest-${process.pid}.json`); const lines: string[] = [];
  const res = await runCorpus(texts, 2, scripted([stSample()]), out, { mode: "self-test" }, true, s => lines.push(s));
  const saved = JSON.parse(readFileSync(out, "utf8")); rmSync(out, { force: true });
  ok(saved.complete === true && saved.results.length === texts.length && saved.results.every((t: TextResult) => t.replays.length === 2 && t.replays.every(r => r.raw.length === 3)) && lines.length === texts.length, "the checkpoint holds every text, every replay and all three raw samples");
  ok(saved.results.every((t: Record<string, unknown>) => !("text" in t) && typeof t.intent_sha256 === "string"), "the sealed text is not copied into the output: ids and the hash locate it");
  ok(res.summary.replays === texts.length * 2 && res.summary.model_calls === texts.length * 6 && res.summary.decided_rate === 1 && res.summary.consistency_errors === 0 && res.summary.reading_evidence_split.label === "NOISE" && res.summary.reading_state_split.label === "NOISE", "summary counts add up on an all-agreeing stub", res.summary);
  let calls = 0, died = ""; const dies: ModelFn = async () => { if (++calls > 3) throw new Error("stub outage"); return stSample(); };
  try { await runCorpus(texts.slice(0, 2), 1, dies, out, { mode: "self-test" }, true, () => {}); } catch (err) { died = String(err); }
  const partial = JSON.parse(readFileSync(out, "utf8")); rmSync(out, { force: true });
  ok(died.includes("stub outage") && partial.complete === false && partial.results.length === 1 && partial.summary.replays === 1, "a run that dies on its second text leaves the first text on disk, marked incomplete", { died, complete: partial.complete, results: partial.results.length });
  const mixedRun = await runCorpus(texts.slice(0, 2), 5, basis("a hike is all but certain", "the odds at nine in ten", "Analysts say"), out, { mode: "self-test" }, true, () => {}); rmSync(out, { force: true });
  ok(mixedRun.summary.replays_with_scored_all_unknown === 10 && mixedRun.summary.fields.probability_basis.all_unknown === 10 && mixedRun.summary.fields.probability_basis.sample_gate_demotions === 30, "quotes that are not in a sealed text never survive its gate", mixedRun.summary.fields.probability_basis);

  console.log("SELF-TEST · bookkeeping holds on seeded noise over the sealed texts, and the summary prints");
  // The first six texts only. Records are append-only, so with the fixed seed this run is the same run forever.
  const nz = await runCorpus(texts.slice(0, 6), 20, noisy(20261115), out, { mode: "self-test" }, true, () => {}); rmSync(out, { force: true });
  const z = nz.summary; const inScope = nz.results.flatMap(t => t.replays).filter(r => r.in_scope);
  ok(z.consistency_errors === 0, "no replay disagrees with the merge about what the samples said", z.consistency_errors);
  ok(REPORTED.every(f => { const c = z.fields[f]; return c.present + c.absent + c.unknown === z.replays && c.unknown === c.state_split + c.evidence_split + c.all_unknown && c.state_split === c.state_split_by_model + c.state_split_by_gate && Object.values(c.span_relations as Record<string, number>).reduce((p, q) => p + q, 0) === c.evidence_split; }), "per field: present + absent + unknown is every replay, and every unknown has exactly one cause", z.fields);
  ok(EVIDENCE_CAPABLE.every(f => z.fields[f].evidence_split > 0 && z.fields[f].state_split_by_model > 0) && EVIDENCE_CAPABLE.reduce((n, f) => n + z.fields[f].all_unknown, 0) > 0 && z.fields.resolution_engagement.state_split_by_gate > 0 && z.fields.resolution_engagement.sample_gate_demotions > 0, "the noise reaches every cause: both kinds of state split, evidence splits, all unknown", z.fields);
  ok(z.fields.probability_basis.sample_gate_demotions === 0 && z.fields.edge_claim.sample_gate_demotions === 0, "an absent that quotes the text verbatim is never counted as a gate demotion", z.fields);
  ok(z.fields.invalidation_condition.evidence_split === 0 && z.fields.invalidation_condition.state_split_by_gate === 0 && z.fields.invalidation_condition.sample_gate_demotions === 0 && z.fields.invalidation_condition.absent > 0, "the field with no quote gate is never demoted by one and never evidence-splits", z.fields.invalidation_condition);
  ok(z.counterfactual.replays === inScope.filter(r => EVIDENCE_CAPABLE.some(f => r.fields[f].cause === "evidence_split")).length && z.out_of_scope > 0 && z.unparsed_samples > 0, "a counterfactual exists exactly where an in-scope replay has an evidence split", z.counterfactual);
  ok(inScope.every(r => r.unknown_fields.slice().sort().join() === SCORED.filter(f => r.fields[f].merged === "unknown").sort().join()), "the fields this file calls unknown are the fields the engine reports unknown");
  ok(inScope.every(r => !r.counterfactual || (r.counterfactual.risk > r.risk && !(r.verdict !== "PASS" && r.counterfactual.verdict === "PASS"))) && inScope.some(r => r.counterfactual && r.counterfactual.verdict !== r.verdict) && inScope.some(r => r.counterfactual && r.counterfactual.verdict === r.verdict), "keeping an agreed absent always raises the risk and never produces a PASS that was not one; some verdicts change, some do not");
  const printed: string[] = []; let threw = ""; try { report(z, 20, "tests/out/example.json", line => printed.push(line)); report(summarize([], 5, true), 5, "x", line => printed.push(line)); } catch (err) { threw = String(err); }
  ok(threw === "" && printed.filter(line => line.includes("PRE-DECLARED READING")).length === 4 && !printed.join("\n").includes("undefined") && !printed.join("\n").includes("NaN"), "the summary prints on a noisy run and on an empty one, with no undefined or NaN in it", threw || printed);
  const q2dir = mkdtempSync(join(tmpdir(), "q2real-baseline-"));
  const q2run = (disagreements: string[]) => ({ disagreements });
  writeFileSync(join(q2dir, "q2-live-a.json"), JSON.stringify({ results: [
    { cls: "FULL", runs: [q2run([]), q2run(["edge_claim", "oracle_source"]), q2run(["probability_basis"])] },
    { cls: "NO_PROBABILITY", runs: [q2run(["probability_basis(evidence)"]), q2run(["resolution_engagement", "probability_basis(evidence)"]), q2run(["edge_claim(evidence)"])] },
    { cls: "NON_PM", runs: [q2run(["invalidation_condition"])] }] }));
  writeFileSync(join(q2dir, "q2-live-b.json"), JSON.stringify({ results: [{ cls: "VAGUE_STOP", runs: [q2run(["invalidation_condition"])] }] }));
  writeFileSync(join(q2dir, "q2real-live-c.json"), JSON.stringify({ results: [{ cls: "FULL", runs: [q2run(["probability_basis"])] }] }));
  const synth = q2Baseline(q2dir); rmSync(q2dir, { recursive: true, force: true });
  ok(synth !== null && synth.files === 1 && synth.runs === 6 && synth.disagreement === 3 && synth.state_split === 2 && synth.evidence_split === 2, "the Q2 baseline counts PM-class runs only, scored fields only, and ignores this harness's own outputs", synth);
  const base = q2Baseline(); ok(base === null || (base.runs > 0 && base.disagreement <= base.runs && base.state_split + base.evidence_split >= base.disagreement), "the tracked Q2 runs read cleanly, or are reported as missing", base);
  ok(q2Baseline(join(tmpdir(), "q2real-no-such-directory")) === null, "a missing baseline directory is reported as missing, not as an error");

  console.log(fail === 0 ? `SELF-TEST PASS · ${pass}/${pass} assertions` : `SELF-TEST FAIL · ${fail} of ${pass + fail} assertions failed`);
  return fail === 0;
}

// ── main. Runs only when this file is the script: importing it for its exports starts nothing ─────────────────
if (/q2-real-text-replay(\.[cm]?ts)?$/.test(process.argv[1] ?? "")) (async () => {
  const args = process.argv.slice(2);
  if (args.some(x => x !== "--self-test")) { console.error(`unknown argument: ${args.filter(x => x !== "--self-test").join(" ")}\nusage: npx tsx tests/q2-real-text-replay.ts [--self-test]   (K and ONLY are environment variables)`); process.exit(2); }
  // CLAUDE.md section 5: the offline harness runs before ANY live run. Enforced here, not remembered.
  const selfOk = await selfTest().catch(err => { console.log(`SELF-TEST FAIL · it threw: ${err instanceof Error ? err.message : String(err)}`); return false; });
  if (args.includes("--self-test")) process.exit(selfOk ? 0 : 1);
  if (!selfOk) { console.error("\nRefusing the live run: the self-test failed, so the counts could not be trusted."); process.exit(1); }

  const K = Number(process.env.K ?? 5);
  if (!Number.isInteger(K) || K < 1) { console.error("K must be a positive integer"); process.exit(2); }
  const only = (process.env.ONLY ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const { texts: allTexts, skipped } = loadCorpus();
  const texts = only.length ? allTexts.filter(t => t.ids.some(id => only.includes(id))) : allTexts;
  if (!texts.length) { console.error(only.length ? `ONLY matched no sealed thesis-bearing record: ${only.join(", ")}` : "no thesis-bearing sealed records found"); process.exit(2); }
  const key = devVar("ANTHROPIC_API_KEY");
  if (!key) { console.error("\nANTHROPIC_API_KEY not found (environment, or djzs-trust-mcp/.dev.vars). The live run is the operator's: a session without the key reports and stops."); process.exit(2); }

  console.log(`\nQ2-REAL real-text replay · LIVE · ${CLAUDE_MODEL} · ${EXTRACTION_CONTRACT_VERSION} · K=${K} · ${texts.length} text(s) · ${texts.length * K * 3} model calls`);
  for (const s of skipped) console.log(`  SKIPPED ${s}`);
  mkdirSync(Q2_OUT_DIR, { recursive: true });
  const out = `${Q2_OUT_DIR}/q2real-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  let s: ReturnType<typeof summarize>;
  try { s = (await runCorpus(texts, K, anthropicModel(key), out, { mode: "live", model: CLAUDE_MODEL, extraction_contract: EXTRACTION_CONTRACT_VERSION, started_at: new Date().toISOString(), only, skipped }, only.length === 0)).summary; }
  catch (e) { console.error(`\nRun stopped: ${e instanceof Error ? e.message : String(e)}\nEvery text finished before the stop is in ${out} (complete: false). Nothing else was written.`); process.exit(1); }

  report(s, K, out);
})().catch(e => { console.error(e); process.exit(1); });
