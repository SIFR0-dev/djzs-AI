// Q3 shared helpers — canonical JSON, hashing, Merkle root. Kept tiny and dependency-free so any verifier can port it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(x => x === undefined ? "null" : canonical(x)).join(",") + "]";
  // Skip undefined values exactly as JSON.stringify does, so hash(in-memory) === hash(reloaded) by construction.
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
export const sha256hex = (s: string | Buffer) => "0x" + createHash("sha256").update(s).digest("hex");
export function merkleRoot(hashes: string[]): string {
  const norm = [...new Set(hashes.map(h => h.toLowerCase()))].sort(); if (!norm.length) throw new Error("no hashes");
  let lvl = norm.map(h => Buffer.from(h.slice(2), "hex"));
  while (lvl.length > 1) { if (lvl.length % 2) lvl.push(lvl[lvl.length - 1]); const n: Buffer[] = []; for (let i = 0; i < lvl.length; i += 2) n.push(createHash("sha256").update(Buffer.concat([lvl[i], lvl[i + 1]])).digest()); lvl = n; }
  return "0x" + lvl[0].toString("hex");
}
/** Renders the intent for extraction. A null or undefined field is OMITTED, never rendered as the token "null".
 *  §3 already says an absent basis or invalidation is omitted rather than stated, and v1.12 says the engine sees "an
 *  input whose thesis is absent" — rendering `thesis: null` would hand the extractor a literal string to read as
 *  content, which is the opposite of absence. Hash-neutral on every record written before v1.12: none carries a null
 *  inside intent, checked. */
export function renderIntentText(i: unknown): string {
  if (typeof i === "string") return i; if (!i || typeof i !== "object") return String(i);
  const o = i as Record<string, unknown>;
  return Object.keys(o).sort().filter(k => o[k] !== null && o[k] !== undefined).map(k => { const v = o[k]; return `${k}: ${typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v)}`; }).join("\n");
}
/** §3 pool tag vocabulary — v1.5 rule 1 (categories) plus v1.8 (venue-native recurrence). ONE definition, consumed by
 *  the venue-direct read, the Dune publish check and the day's JSON; queries/polymarket_pool.sql carries the same
 *  strings in its header and matches them the same way, so the three cannot drift apart. */
export const POOL_TAGS_INCLUDE = ["Politics", "Elections", "Geopolitics", "World", "Economy", "Fed", "Finance", "Crypto"];
/** Split by the amendment that put each label here, because v1.9 treats the two halves differently: the v1.5
 *  category exclusions always apply, while the v1.8 recurrence tags are only a PROXY for a duration the venue may
 *  publish directly. Concatenated in this order the union is byte-identical to the pre-v1.9 constant. */
export const POOL_TAGS_EXCLUDE_CATEGORY = ["Sports", "Esports", "Culture", "entertainment", "Weather"];
/** "Up or Down" is ONE tag, not two. PROTOCOL v1.8 reads "Recurring, Up or Down, or an interval tag (5M, 15M, 1H,
 *  4H)" and the pre-registered text was right: the venue publishes a single label `Up or Down` (confirmed live
 *  2026-09-10, x12 across 600 events), and standalone `Up` / `Down` tags DO NOT EXIST. Listing them separately meant
 *  the recurrence proxy could never fire on any market, so the v1.8 fallback was dead code from the day it landed. */
export const POOL_TAGS_EXCLUDE_RECURRENCE = ["Recurring", "Up or Down", "5M", "15M", "1H", "4H"];
export const POOL_TAGS_EXCLUDE = [...POOL_TAGS_EXCLUDE_CATEGORY, ...POOL_TAGS_EXCLUDE_RECURRENCE];
/** v1.9: a pool candidate is excluded when the interval from the read to its scheduled resolution is under 24h. */
export const POOL_MIN_HOURS_TO_CLOSE = 24;
/** ORACLE, NOT CRITERION. A venue-native recurrence market names itself in its own URL. Nothing in the pool query or
 *  the venue reads filters on this — v1.9's rule is the published close time alone. It exists so a check can assert,
 *  from a fact the rule never saw, that the rule excluded what it should have. Inverting that (filtering on the slug)
 *  would make pool membership a naming judgement, which is exactly what §3 removes. */
export const RECURRENCE_SLUG_ORACLE = /updown-\d+[mh]/i;
/** True iff a venue URL names the market as a recurrence contract. Accepts the whole link or a bare slug. */
export function slugNamesRecurrence(link: unknown): boolean {
  return RECURRENCE_SLUG_ORACLE.test(String(link ?? ""));
}
/** Tags reach us as a real array of labels or {label} objects (Gamma) or as ARRAY(VARCHAR) through the Dune API —
 *  both arrive here as arrays. The JSON-array-string and comma-string branches below are kept as tolerated legacy
 *  shapes, not live ones: market_details.tags is ARRAY(VARCHAR) at source, which is why polymarket_pool.sql no
 *  longer json_parses it. Normalise every shape to lower-cased WHOLE tags. Matching is containment, never substring:
 *  v1.8's set still includes the bare interval tags 5M, 15M, 1H and 4H, which a substring or boundary regex would
 *  fire on inside other text, and the set is mixed case with non-ASCII present. (The Up/Down example this comment
 *  used to give was wrong twice over: the tag is the single label "Up or Down", and the live vocabulary also carries
 *  an unrelated "Finance Updown" that a substring match would wrongly catch.) */
export function normalizeTags(tags: unknown): string[] {
  let arr: unknown[];
  if (Array.isArray(tags)) arr = tags;
  else { const s = String(tags ?? ""); let parsed: unknown = null; try { parsed = JSON.parse(s); } catch {}
    arr = Array.isArray(parsed) ? parsed : s.split(","); }
  return arr
    .map(x => (x && typeof x === "object" ? String((x as Record<string, unknown>).label ?? "") : String(x ?? "")))
    .map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase())
    .filter(Boolean);
}
/** Hours from `now` to a venue's published close/expiration. Strings are parsed as dates (both venues publish ISO
 *  8601: Kalshi close_time, Polymarket endDate); a bare number is epoch MILLISECONDS, the one convention this takes.
 *  null means the venue published nothing usable — and null is the ONLY case in which the v1.8 tag proxy still
 *  decides. An unparseable value is null rather than 0: a parse failure must not exclude (or admit) a market on an
 *  interval nobody published. A past close yields a negative number, which is under any positive threshold. */
export function hoursToClose(closeTime: unknown, now: Date | string | number = Date.now()): number | null {
  if (closeTime == null || closeTime === "") return null;
  const t = typeof closeTime === "number" ? closeTime : closeTime instanceof Date ? closeTime.getTime() : Date.parse(String(closeTime));
  const n = typeof now === "number" ? now : now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  return (t - n) / 3_600_000;
}
/** v1.9's duration test. True = admitted. The close time GOVERNS wherever the venue publishes one, so a market
 *  carrying a recurrence tag but closing days out is admitted, and an untagged hourly ladder (Kalshi publishes
 *  categories, not tags — the gap v1.8 could not reach) is excluded. Only where no close time exists does the v1.8
 *  tag set decide, as the amendment's fallback proxy; pass no `tags` and there is nothing left to fall back to, so
 *  the candidate is admitted and the caller should count that case rather than let it pass silently. */
export function poolDurationAdmit(closeTime: unknown, now: Date | string | number = Date.now(), tags?: unknown): boolean {
  const h = hoursToClose(closeTime, now);
  if (h !== null) return h >= POOL_MIN_HOURS_TO_CLOSE;
  if (tags === undefined) return true;
  const t = new Set(normalizeTags(tags));
  return !POOL_TAGS_EXCLUDE_RECURRENCE.some(l => t.has(l.toLowerCase()));
}
/** True iff the tag set carries a scan category and none of the v1.5 exclusions. The duration rule is NOT applied
 *  here: on Polymarket tags live on the event and the close time on each market, so the category gate runs once per
 *  event and poolDurationAdmit runs per market. */
export function poolCategoryAdmit(tags: unknown): boolean {
  const t = new Set(normalizeTags(tags));
  const has = (labels: string[]) => labels.some(l => t.has(l.toLowerCase()));
  return has(POOL_TAGS_INCLUDE) && !has(POOL_TAGS_EXCLUDE_CATEGORY);
}
/** Full §3 pool admission for a candidate whose tags and close time are both to hand: v1.5 categories, then v1.9's
 *  duration test with v1.8 as its fallback. */
export function poolAdmit(tags: unknown, closeTime?: unknown, now: Date | string | number = Date.now()): boolean {
  return poolCategoryAdmit(tags) && poolDurationAdmit(closeTime, now, tags);
}
/** Tags-only admission, unchanged from v1.8 by construction: with no close time poolDurationAdmit falls back to the
 *  recurrence proxy, so this is still categories ∧ ¬exclusions over the full union. Kept for the callers that see a
 *  tag set and nothing else (the Dune publish check reads a query that has already applied the duration test). */
export function poolTagsAdmit(tags: unknown): boolean {
  return poolAdmit(tags, undefined);
}
export function devVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try { for (const l of readFileSync("djzs-trust-mcp/.dev.vars", "utf8").split("\n")) { const m = l.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`)); if (m) return m[1].trim(); } } catch {}
  return undefined;
}
/** Fields hashed in Phase A: everything the operator + engine wrote before the price was looked up.
 *  volume_24h / volume_total (v1.7a) are sealed at Phase B alongside the price, so they are excluded here for the same
 *  reason price_at_audit is. Adding a name to this set cannot change any existing hash: strip() removes keys by name,
 *  and a record that never carried the key canonicalises identically either way. */
export const PHASE_A_EXCLUDE = new Set(["phase_a_hash", "price_at_audit", "implied_prob_at_audit", "price_captured_at", "volume_24h", "volume_total", "record_hash", "outcome"]);
export const PHASE_B_EXCLUDE = new Set(["record_hash", "outcome"]);
export function strip(rec: Record<string, unknown>, ex: Set<string>) { const o: Record<string, unknown> = {}; for (const k of Object.keys(rec)) if (!ex.has(k)) o[k] = rec[k]; return o; }
