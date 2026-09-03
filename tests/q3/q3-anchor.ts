/**
 * Q3 daily anchor — local side. Computes the Merkle root of the day's record_hash values, asks the Worker
 * to sign+upload it with the PoL Irys key (POST /q3/anchor), verifies the Worker's root equals ours,
 * appends to tests/q3/anchors.json.
 *   npx tsx tests/q3/q3-anchor.ts 2026-09-02
 *   npx tsx tests/q3/q3-anchor.ts --verify 2026-09-02     # third-party path: fetch Irys item, recompute root, compare
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { merkleRoot, devVar } from "./lib";
const args = process.argv.slice(2); const verify = args.includes("--verify"); const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!date) { console.error("usage: q3-anchor.ts [--verify] YYYY-MM-DD"); process.exit(1); }
const WORKER = process.env.Q3_ANCHOR_URL ?? "https://mcp.djzs.ai/q3/anchor"; const ANCHORS = "tests/q3/anchors.json";
const recs = JSON.parse(readFileSync(`tests/q3/records/${date}.json`, "utf8")) as { id: string; record_hash: string | null; protocol_version: string }[];
const sealed = recs.filter(r => r.record_hash); const unsealed = recs.filter(r => !r.record_hash).map(r => r.id);
if (unsealed.length) { console.error(`refusing: ${unsealed.length} record(s) not sealed (Phase B missing): ${unsealed.join(", ")}`); process.exit(1); }
const hashes = sealed.map(r => r.record_hash!); const root = merkleRoot(hashes); const pv = sealed[0].protocol_version;
const anchors: any[] = existsSync(ANCHORS) ? JSON.parse(readFileSync(ANCHORS, "utf8")) : [];
(async () => {
  if (verify) {
    const a = anchors.find(x => x.date === date); if (!a) { console.error(`no anchor recorded for ${date}`); process.exit(1); }
    const r = await fetch(a.gateway_url); if (!r.ok) { console.error(`gateway ${r.status}`); process.exit(1); } const item = await r.json() as any;
    const ok = item.merkle_root === root && item.record_count === hashes.length && item.date === date;
    console.log(`${date} · local root ${root}\n       irys  root ${item.merkle_root} (${a.irys_id})\n${ok ? "VERIFIED — the committed records are the anchored records" : "MISMATCH — records changed after anchoring"}`); process.exit(ok ? 0 : 1);
  }
  if (anchors.some(x => x.date === date)) { console.error(`${date} already anchored (${anchors.find(x => x.date === date).irys_id}); use --verify`); process.exit(1); }
  const key = devVar("DJZS_Q3_ANCHOR_KEY"); if (!key) { console.error("DJZS_Q3_ANCHOR_KEY not found in .dev.vars/env"); process.exit(2); }
  const res = await fetch(WORKER, { method: "POST", headers: { "Content-Type": "application/json", "X-DJZS-Anchor-Key": key }, body: JSON.stringify({ date, protocol_version: pv, record_hashes: hashes }) });
  const body = await res.json() as any; if (!res.ok || body.status !== "anchored") { console.error(`anchor failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
  if (body.merkle_root !== root) { console.error(`ROOT MISMATCH — worker ${body.merkle_root} vs local ${root}; not recording`); process.exit(1); }
  anchors.push({ date, protocol_version: pv, record_count: hashes.length, merkle_root: root, irys_id: body.irys_id, gateway_url: body.gateway_url, anchored_at: new Date().toISOString() });
  writeFileSync(ANCHORS, JSON.stringify(anchors, null, 2) + "\n");
  console.log(`${date} · ${hashes.length} records · root ${root}\nanchored → ${body.gateway_url}\n→ ${ANCHORS}   COMMIT.`);
})();
