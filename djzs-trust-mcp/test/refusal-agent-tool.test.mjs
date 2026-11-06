// refusal-agent --tool: the PM path must be byte-identical to every run before
// the flag existed, and the perp path must have its own fixed render and gate.
// Run: cd djzs-trust-mcp && node --test test/refusal-agent-tool.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateIntent, renderWire, renderPerpWire, sha256, buildPostText, TOOLS, PERP_REQUIRED_FIELDS,
} from "../agent/refusal-agent.mjs";

const here = new URL("../agent/", import.meta.url);
const read = (p) => readFileSync(new URL(p, here), "utf8");
const log = JSON.parse(read("refusal-log.json"));

// ── PM path: pinned to the log. These three intent files produced entries 3, 7, 8.
// If the default-tool render or validator moves, these shas move, and this fails.
const PINNED = [
  ["intents/clarity-act-no-v2.md", 3],
  ["intents/september-hike-72.md", 7],
  ["intents/september-hold.md", 8],
];

test("pm (default) render still hashes to the logged intent_sha256", () => {
  for (const [file, seq] of PINNED) {
    const entry = log.find((e) => Number(e.seq) === seq);
    assert.ok(entry, `log entry ${seq} present`);
    const v = validateIntent(read(file));            // no tool arg: the pre-flag call shape
    assert.equal(v.ok, true, `${file} passes the PM field gate`);
    assert.equal(v.tool, "pm");
    assert.equal(sha256(v.wire), entry.intent_sha256, `${file} -> entry ${seq}`);
    assert.equal(sha256(renderWire(v.fields)), entry.intent_sha256, "renderWire(fields) agrees");
  }
});

test("pm post_text regenerates byte-identical for logged EXECUTED entries", () => {
  for (const [file, seq] of PINNED) {
    const entry = log.find((e) => Number(e.seq) === seq);
    if (!entry.post_text) continue;
    const v = validateIntent(read(file));
    // Entries written before the flag carry no `tool`; buildPostText must treat that as PM.
    const regenerated = buildPostText({ ...entry, fields: v.fields });
    assert.equal(regenerated, entry.post_text, `entry ${seq} post_text unchanged`);
  }
});

test("tool table: names and required fields", () => {
  assert.equal(TOOLS.pm.name, "verify_pm_trade");
  assert.equal(TOOLS.perp.name, "verify_perp_trade");
  assert.deepEqual(TOOLS.pm.required, ["claim", "falsifier", "residual", "probability_basis"]);
  assert.deepEqual(PERP_REQUIRED_FIELDS, ["instrument", "side", "venue", "leverage", "size_usd", "entry", "stop_loss", "thesis"]);
  assert.equal(validateIntent("---\nclaim: x.\n---", "nope").ok, false);
});

// ── perp path: fixed render, pinned sha, gate behaviour.
const GOOD = `---
instrument: ETH-PERP
side: Short
venue: Hyperliquid
leverage: 3
size_usd: 300
entry: $4,120.50
stop_loss: 4,300
take_profit: 3,800
thesis: Funding has been positive for six sessions while open interest fell, so the crowded long unwinds into the weekly close
invalidation: a daily close above 4,300 with funding still positive
data_sources: Hyperliquid info API, fundingHistory and metaAndAssetCtxs, read 2026-10-20T20:00Z
---
notes never reach the wire.
`;

const EXPECTED_WIRE =
  "Short ETH-PERP on Hyperliquid, 3x, 300 USD notional, entry $4,120.50, stop 4,300, target 3,800. " +
  "Thesis: Funding has been positive for six sessions while open interest fell, so the crowded long unwinds into the weekly close. " +
  "Invalidation: a daily close above 4,300 with funding still positive. " +
  "Data sources: Hyperliquid info API, fundingHistory and metaAndAssetCtxs, read 2026-10-20T20:00Z.";

test("perp: fixed render and pinned sha", () => {
  const v = validateIntent(GOOD, "perp");
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.tool, "perp");
  assert.equal(v.fields.side, "short", "side is normalised to lower case before render");
  assert.equal(v.wire, EXPECTED_WIRE);
  // Pinned 2026-10-20. If renderPerpWire moves, this moves, and every future
  // perp entry would hash against a different preimage than the log's history.
  assert.equal(sha256(v.wire), "784b6f98c03cfebc55408c7eb81df0409c423ae81b91dfd3e8647d53cea6d0f3");
  assert.equal(sha256(renderPerpWire(v.fields)), sha256(v.wire));
});

test("perp: optional fields render only when present, in fixed order", () => {
  const minimal = GOOD.replace(/^take_profit:.*\n/m, "").replace(/^invalidation:.*\n/m, "").replace(/^data_sources:.*\n/m, "");
  const v = validateIntent(minimal, "perp");
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(
    v.wire,
    "Short ETH-PERP on Hyperliquid, 3x, 300 USD notional, entry $4,120.50, stop 4,300. " +
    "Thesis: Funding has been positive for six sessions while open interest fell, so the crowded long unwinds into the weekly close.",
  );
});

test("perp: the gate refuses what the operator can already see", () => {
  const cases = [
    [GOOD.replace(/^stop_loss:.*\n/m, ""), /missing or empty field: stop_loss/],
    [GOOD.replace("stop_loss: 4,300", "stop_loss: 4,000"), /short: stop_loss must be above entry/],
    [GOOD.replace("side: Short", "side: long"), /long: stop_loss must be below entry/],
    [GOOD.replace("side: Short", "side: sell"), /side must be exactly 'long' or 'short'/],
    [GOOD.replace("leverage: 3", "leverage: 3x"), /leverage must be a bare positive number/],
    [GOOD.replace("size_usd: 300", "size_usd: $300"), /size_usd must be a bare positive number/],
    [GOOD.replace("take_profit: 3,800", "take_profit: 4,500"), /short: take_profit must be below entry/],
    [GOOD.replace("into the weekly close", "into the weekly close."), /thesis must not end with '.'/],
    [GOOD.replace(/^thesis:.*$/m, "thesis: short it"), /thesis is under 20 characters/],
  ];
  for (const [raw, re] of cases) {
    const v = validateIntent(raw, "perp");
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(v.problems)}`);
  }
});

test("perp: the template cannot be paid on", () => {
  const v = validateIntent(read("intents/perp-TEMPLATE.md"), "perp");
  assert.equal(v.ok, false);
});

test("perp: post text uses thesis and stop, and names the partial taxonomy on a PARKED entry", () => {
  const v = validateIntent(GOOD, "perp");
  const base = { seq: 42, tool: "verify_perp_trade", risk_score: 0, flags: [], verdict_hash: "0x" + "ab".repeat(32), ts_block: 1, intent_sha256: sha256(v.wire), fields: v.fields };
  const executed = buildPostText({ ...base, decision: "EXECUTED" });
  assert.match(executed, /The trade taken, gated: Funding has been positive/);
  assert.match(executed, /kill condition: stop 4,300; a daily close above 4,300/);
  const parked = buildPostText({ ...base, decision: "PARKED", halt_reason: "WAIT: 1 field(s) unresolvable from intent — [stop_loss]. Clarify intent and re-audit." });
  assert.match(parked, /No live code fired \(DJZS-LF-v1\.2, 4 of 11 live\)\. The engine still halted/);
  // A PM-shaped call (no tool) still renders the original wording.
  const pmParked = buildPostText({ ...base, tool: undefined, decision: "PARKED", halt_reason: "WAIT: x.", fields: { claim: "Claim here." } });
  assert.match(pmParked, /All four codes cleared\./);
});
