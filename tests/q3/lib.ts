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
export function devVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try { for (const l of readFileSync("djzs-trust-mcp/.dev.vars", "utf8").split("\n")) { const m = l.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`)); if (m) return m[1].trim(); } } catch {}
  return undefined;
}
/** Fields hashed in Phase A: everything the operator + engine wrote before the price was looked up. */
export const PHASE_A_EXCLUDE = new Set(["phase_a_hash", "price_at_audit", "implied_prob_at_audit", "price_captured_at", "record_hash", "outcome"]);
export const PHASE_B_EXCLUDE = new Set(["record_hash", "outcome"]);
export function strip(rec: Record<string, unknown>, ex: Set<string>) { const o: Record<string, unknown> = {}; for (const k of Object.keys(rec)) if (!ex.has(k)) o[k] = rec[k]; return o; }
