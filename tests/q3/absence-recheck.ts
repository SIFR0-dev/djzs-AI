/**
 * PROTOCOL v1.12 — the absence re-check at grading. SCAN_SPEC §8H.
 *
 * v1.12: "The absence must be re-checked at grading: if a dominant public case appeared after posted_at, the record is
 * graded as sealed and the later emergence is noted, never retrofitted into the sealed record."
 *
 * The re-check is a READ-ONLY search performed by the grading pass the same way the sealed search_record was produced
 * at Phase A — sources consulted, queries used, window, timestamp, and a stated judgement — and handed to q3-grade with
 * --recheck. This module owns the ONE definition of what a valid re-check is; q3-grade refuses to write an outcome for a
 * no_public_case record without one, and q3-verify fails a graded no_public_case record whose re-check does not pass the
 * same validator. The re-check lives at outcome.absence_recheck, which is in both PHASE_A_EXCLUDE and PHASE_B_EXCLUDE
 * (via `outcome`), so it can never reach a sealed hash and never alters a sealed field.
 *
 * Why not a scripted feed replay (tried 2026-09-17, rejected on evidence): Google News RSS returns results for the sealed
 * natural-language queries but its feed terms restrict use to a personal, non-commercial feed reader; GDELT's DOC API has
 * open terms but ANDs every word, so the sealed query "Fed rate cut September 2026 who expects cut Trump pressure Warsh"
 * returned {} over the window — a replay would report "no candidates" because of query syntax, not because the absence
 * held. A re-check that can only ever confirm the absence is not a re-check.
 */
export type Rec = Record<string, any>;
export const RECHECK_FINDINGS = ["absence_holds", "case_emerged"] as const;
export type RecheckFinding = typeof RECHECK_FINDINGS[number];
export interface AbsenceRecheck {
  sources_consulted: string[];
  queries: string[];
  window: { from: string; to: string };
  searched_at: string;
  finding: RecheckFinding;
  judgement: string;
}

export const needsAbsenceRecheck = (r: Rec) => r?.thesis_state === "no_public_case";

const t = (s: unknown) => (typeof s === "string" ? Date.parse(s) : NaN);
const nonEmptyStrings = (a: unknown) => Array.isArray(a) && a.length > 0 && a.every(x => typeof x === "string" && x.trim());

/** Every reason `recheck` is not a valid v1.12 re-check of sealed record `r` graded at `gradedAt`. Empty = valid.
 *  - the window must cover [posted_at, market.resolution_due]: v1.12 asks whether a case appeared AFTER posted_at, and
 *    the question stops mattering once the market's own resolution instant has passed;
 *  - searched_at must fall after resolution_due (the whole window had elapsed when it was searched) and no later than
 *    graded_at (it is a re-check AT grading, not one borrowed from a later pass);
 *  - every sealed search_record query must be re-run — extra queries are allowed, dropping a sealed one is not, or the
 *    re-check could quietly avoid the search that established the absence;
 *  - finding is one of two values and the judgement is stated, as the sealed search_record's was. */
export function validateAbsenceRecheck(r: Rec, recheck: unknown, gradedAt: string): string[] {
  const errs: string[] = [];
  if (!needsAbsenceRecheck(r)) return [`record is not thesis_state "no_public_case" — a v1.12 absence re-check does not apply and must not be attached`];
  if (!recheck || typeof recheck !== "object" || Array.isArray(recheck)) return ["absence re-check missing — v1.12 requires the absence be re-checked at grading"];
  const c = recheck as Record<string, any>;
  if (!nonEmptyStrings(c.sources_consulted)) errs.push("sources_consulted must be a non-empty list of the sources searched");
  if (!nonEmptyStrings(c.queries)) errs.push("queries must be a non-empty list of the queries used");
  else {
    const sealed: string[] = Array.isArray(r.search_record?.queries) ? r.search_record.queries : [];
    const dropped = sealed.filter(q => !c.queries.includes(q));
    if (dropped.length) errs.push(`queries must re-run every sealed search_record query; missing ${JSON.stringify(dropped)}`);
  }
  const posted = t(r.posted_at), due = t(r.market?.resolution_due), graded = t(gradedAt);
  if (!Number.isFinite(due)) errs.push(`sealed market.resolution_due ${JSON.stringify(r.market?.resolution_due)} is not a timestamp — the re-check window cannot be checked`);
  const from = t(c.window?.from), to = t(c.window?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) errs.push("window must carry parseable from and to");
  else {
    if (from > posted) errs.push(`window.from ${c.window.from} is after posted_at ${r.posted_at} — the re-check must cover everything since the seal`);
    if (Number.isFinite(due) && to < due) errs.push(`window.to ${c.window.to} is before market.resolution_due ${r.market.resolution_due} — the re-check must run to the resolution instant`);
  }
  const s = t(c.searched_at);
  if (!Number.isFinite(s)) errs.push(`searched_at must be a parseable timestamp (got ${JSON.stringify(c.searched_at)})`);
  else {
    if (Number.isFinite(due) && s < due) errs.push(`searched_at ${c.searched_at} is before market.resolution_due — the window had not elapsed when it was searched`);
    if (Number.isFinite(graded) && s > graded) errs.push(`searched_at ${c.searched_at} is after graded_at ${gradedAt} — a re-check must precede the grade it is attached to`);
  }
  if (!RECHECK_FINDINGS.includes(c.finding)) errs.push(`finding must be one of ${RECHECK_FINDINGS.join(" | ")} (got ${JSON.stringify(c.finding)})`);
  if (typeof c.judgement !== "string" || !c.judgement.trim()) errs.push("judgement must state what was found and why it does or does not amount to a dominant public case");
  return errs;
}

/** The outcome.note line for a graded no_public_case record. The grade itself is ALWAYS against the sealed criterion;
 *  a case that emerged later is noted here and never retrofitted into the sealed record. */
export const recheckNote = (c: AbsenceRecheck) => c.finding === "case_emerged"
  ? "v1.12 absence re-check: a public case emerged after posted_at — graded as sealed, noted here, never retrofitted"
  : "v1.12 absence re-check: absence holds through market.resolution_due";
