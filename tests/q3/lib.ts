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
export function renderIntentText(i: unknown): string {
  if (typeof i === "string") return i; if (!i || typeof i !== "object") return String(i);
  const o = i as Record<string, unknown>;
  return Object.keys(o).sort().map(k => { const v = o[k]; return `${k}: ${typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v)}`; }).join("\n");
}
/** §3 pool tag vocabulary — v1.5 rule 1 (categories) plus v1.8 (venue-native recurrence). ONE definition, consumed by
 *  the venue-direct read, the Dune publish check and the day's JSON; queries/polymarket_pool.sql carries the same
 *  strings in its header and matches them the same way, so the three cannot drift apart. */
export const POOL_TAGS_INCLUDE = ["Politics", "Elections", "Geopolitics", "World", "Economy", "Fed", "Finance", "Crypto"];
export const POOL_TAGS_EXCLUDE = ["Sports", "Esports", "Culture", "entertainment", "Weather", "Recurring", "Up", "Down", "5M", "15M", "1H", "4H"];
/** Tags reach us three ways: a real array of labels or {label} objects (Gamma), a JSON-array string, or a
 *  comma-delimited string (Dune). Normalise all three to lower-cased WHOLE tags. Matching is containment, never
 *  substring: v1.8 excludes the bare tags Up, Down and 1H, which a boundary regex would fire on inside other text,
 *  and the set is mixed case with non-ASCII present. */
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
/** True iff the tag set carries a scan category and none of the excluded ones. Exclusion wins over inclusion. */
export function poolTagsAdmit(tags: unknown): boolean {
  const t = new Set(normalizeTags(tags));
  const has = (labels: string[]) => labels.some(l => t.has(l.toLowerCase()));
  return has(POOL_TAGS_INCLUDE) && !has(POOL_TAGS_EXCLUDE);
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
