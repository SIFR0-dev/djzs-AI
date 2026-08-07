#!/usr/bin/env node
// refusal-agent.mjs — the reference agent: audit before act, log the refusal.
// ───────────────────────────────────────────────────────────────────────────
// The payer is PORTED VERBATIM from djzs-trust-mcp/demo-call.mjs (the proven
// mechanism for this server): agents/x402 `withX402Client` over the MCP SDK
// (StreamableHTTP), NETWORK "base", MAX_PAYMENT_ATOMIC 2000000n, callback-first
// callTool. NOT x402-fetch/wrapFetchWithPayment — this server negotiates payment
// at the MCP layer, not as a transport-level HTTP 402. Reference:
//   djzs-trust-mcp/harness/pol-paid-call.ts (GATE P) and site/guide.html (#pay).
//
// ONE DELIBERATE ADDITION to the ported payer: a `fetch` hook on the transport
// that reads the settlement tx out of the PAYMENT-RESPONSE header. demo-call.mjs
// closes by noting it cannot print the tx hash because the MCP transport does not
// surface that header to the callback. The log schema requires settlement_tx, and
// the daily-spend rail needs to know a run actually settled — so we hook it.
//
// Reads : env DJZS_PAYER_KEY      (0x + 64 hex; Base MAINNET USDC payer. RUNTIME
//                                  ONLY — never written to disk by this script.)
//         env DJZS_AGENT_ADDRESS  (the trading wallet whose trust record accrues)
//         env DJZS_ENDPOINT       (optional; defaults to the production Worker)
//         --intent <path>         (YAML-frontmatter intent file)
// Writes: ./refusal-log.json      (append-only decision log)
//
// COST: a `--mode paid` run SPENDS 2.00 USDC on Base mainnet (x402). `--mode dry`
// spends nothing and touches no network except the log. An out-of-scope intent is
// refused server-side and NOT charged.
//
// Run from the Worker package so bare imports resolve against ./node_modules:
//   cd djzs-trust-mcp && node agent/refusal-agent.mjs --intent agent/intents/x.md --mode dry
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";

// ── constants (ported verbatim) ────────────────────────────────────────────
const ENDPOINT = process.env.DJZS_ENDPOINT ?? "https://mcp.djzs.ai/mcp";
const NETWORK = "base";              // Base MAINNET (eip155:8453)
const MAX_PAYMENT_ATOMIC = 2000000n; // 2.00 USDC (6 decimals) — REQUIRED; lib default caps at 0.10

// ── rails ──────────────────────────────────────────────────────────────────
const PRICE_ATOMIC = 2000000n;       // 2.00 USDC per audit
const MIN_BALANCE_ATOMIC = 4000000n; // 4.00 USDC — refuse paid below two runs' worth
const MAX_PAID_RUNS_PER_UTC_DAY = 2;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet USDC (6 dec, verified on-chain)
// Two independent RPCs. Both must answer; the LOWER balance wins. A single RPC
// that lies or lags could green-light a spend we cannot cover.
const RPCS = [
  process.env.DJZS_RPC_1 ?? "https://mainnet.base.org",
  process.env.DJZS_RPC_2 ?? "https://base-rpc.publicnode.com",
];

const LOG_PATH = new URL("./refusal-log.json", import.meta.url);
const REQUIRED_FIELDS = ["claim", "falsifier", "residual", "probability_basis"];

// A probability basis must name WHERE the number came from, not just state one.
// "held from 37%" is a print with no venue — that is exactly the defect that made
// the first stamped verdict a WAIT and cost 2.00 USDC to discover.
const VENUE_TOKENS = [
  "polymarket", "kalshi", "manifold", "metaculus", "predictit", "betfair",
  "smarkets", "insight prediction", "futuur", "limitless", "drift", "zeitgeist",
];
const SOURCE_TOKENS = [
  "print", "mid", "midpoint", "last", "close", "book", "orderbook", "order book",
  "screenshot", "estimate", "model", "prior", "base rate", "baserate", "survey",
  "poll", "forecast", "backtest", "quote", "bid", "ask", "spread", "vwap",
];

// ── tiny helpers ───────────────────────────────────────────────────────────
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const fail = (code, msg) => { console.error(msg); process.exit(code); };
/** Collapse every whitespace run to a single space. Makes the render wrap-proof. */
const squash = (s) => s.replace(/\s+/g, " ").trim();
/** Strip em/en dashes — Operator posts are dash-free by house rule. */
const dedash = (s) => s.replace(/[—–]/g, "-");

function shorten(s, max = 120) {
  // Clamp to complete clauses. Contract: whole clauses only, never an elided
  // fragment, no terminal punctuation (the template supplies it). Boundary =
  // . ; ! ? followed by whitespace; the lookahead keeps decimals intact.
  // Last boundary at or under max; else first boundary past max; else the
  // whole string. Soft cap by design: a long clause ships whole rather than
  // as "against the....".
  const t = squash(s).replace(/[.;\s]+$/, "");
  if (t.length <= max) return t;
  const bounds = [...t.matchAll(/[.;!?](?=\s|$)/g)].map((m) => m.index);
  const within = bounds.filter((idx) => idx < max);
  const cutAt = within.length ? within[within.length - 1] : (bounds.length ? bounds[0] : t.length);
  return t.slice(0, cutAt).replace(/[,;:.\s]+$/, "");
}

const shortHash = (h) => (typeof h === "string" && h.length > 10 ? `${h.slice(0, 6)}...${h.slice(-4)}` : String(h ?? "n/a"));
const flagCodes = (flags) => (flags ?? []).map((f) => f?.code ?? f).filter(Boolean);
const usd = (atomic) => (Number(atomic) / 1e6).toFixed(2);

// ── CLI ────────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: node agent/refusal-agent.mjs --intent <path> --mode dry|paid [--expect-sha <64-hex>]\n" +
  "  --expect-sha is REQUIRED in paid mode: the run refuses unless the wire sha matches.";

function parseArgs(argv) {
  const out = { intent: null, mode: null, expectSha: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--intent") out.intent = argv[++i];
    else if (argv[i] === "--mode") out.mode = argv[++i];
    else if (argv[i] === "--expect-sha") out.expectSha = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else fail(2, `Unknown argument: ${argv[i]}\n${USAGE}`);
  }
  return out;
}

/** Accept the ticket with or without a 0x prefix, any case. */
const normalizeSha = (s) => String(s ?? "").trim().replace(/^0x/i, "").toLowerCase();

// ── intent file: YAML frontmatter -> byte-deterministic wire string ────────
// Supported form (one key per line; indented continuation lines are joined):
//   ---
//   claim: ...
//   falsifier: ...
//   residual: ...
//   probability_basis: ...
//   ---
//   (free notes below the fence are IGNORED and never reach the wire)
function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return { error: "No YAML frontmatter found. The file must open with a '---' fence." };
  const fields = {};
  let current = null;
  for (const line of m[1].split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      current = kv[1];
      fields[current] = kv[2] ?? "";
    } else if (/^\s+\S/.test(line) && current) {
      fields[current] += ` ${line.trim()}`;
    } else {
      return { error: `Cannot parse frontmatter line: ${line.slice(0, 60)}` };
    }
  }
  for (const k of Object.keys(fields)) {
    fields[k] = squash(String(fields[k]).replace(/^["']|["']$/g, ""));
  }
  return { fields };
}

/**
 * THE FIXED RENDER. Single spaces, fixed field order, .trim() last.
 * This is the exact string sent to verify_pm_trade, and intent_sha256 is its
 * sha256 — so the hash is reproducible from the intent file alone, forever.
 * DO NOT change this function. Changing it silently re-hashes every future
 * entry against a different preimage than the log's history.
 */
function renderWire(f) {
  return `${f.claim} Falsifier: ${f.falsifier}. Residual exposure: ${f.residual}. Probability basis: ${f.probability_basis}.`.trim();
}

function validateIntent(raw) {
  const problems = [];
  const { fields, error } = parseFrontmatter(raw);
  if (error) return { ok: false, problems: [error] };

  for (const k of REQUIRED_FIELDS) {
    if (!fields[k] || fields[k].length === 0) problems.push(`missing or empty field: ${k}`);
  }
  if (problems.length) return { ok: false, problems, fields };

  // Punctuation contract with the FIXED RENDER (which is frozen and must not move):
  // the template supplies the terminal "." after falsifier/residual/probability_basis,
  // and supplies NOTHING after claim. So claim must carry its own terminator and the
  // other three must not, or the wire gets "announcement.." / "37%Falsifier:".
  if (!/[.!?]$/.test(fields.claim)) {
    problems.push("claim must end with terminal punctuation (. ! or ?) — the render appends none");
  }
  for (const k of ["falsifier", "residual", "probability_basis"]) {
    if (/\.$/.test(fields[k])) {
      problems.push(`${k} must not end with '.' — the render appends one (would produce '..')`);
    }
  }

  // probability_basis needs an explicit venue/print/estimate — a bare number is not a basis.
  const pb = fields.probability_basis.toLowerCase();
  const hasVenue = VENUE_TOKENS.some((t) => pb.includes(t));
  const hasSource = SOURCE_TOKENS.some((t) => pb.includes(t));
  const hasPrint = /\d/.test(pb);
  if (!hasVenue && !hasSource) {
    problems.push("probability_basis names no venue or source (e.g. Polymarket, Kalshi, a book print, a model/prior/base rate)");
  }
  if (!hasPrint) {
    problems.push("probability_basis carries no numeric print (the level the basis actually reads)");
  }

  const wire = renderWire(fields);
  if (wire.length < 10) problems.push("rendered intent is under 10 characters");

  return { ok: problems.length === 0, problems, fields, wire };
}

// ── RPC ────────────────────────────────────────────────────────────────────
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${url} -> ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

/** balanceOf(address) on Base USDC, across both RPCs. Both must answer. */
async function checkBalance(address) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const reads = await Promise.allSettled(
    RPCS.map(async (url) => ({ url, value: BigInt(await rpc(url, "eth_call", [{ to: USDC, data }, "latest"])) })),
  );
  const ok = reads.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const bad = reads.map((r, i) => (r.status === "rejected" ? `${RPCS[i]}: ${r.reason?.message ?? r.reason}` : null)).filter(Boolean);
  if (ok.length < RPCS.length) {
    return { ok: false, reason: `balance unverifiable on ${bad.length} of ${RPCS.length} RPC(s) — ${bad.join("; ")}`, reads: ok };
  }
  const min = ok.reduce((a, b) => (b.value < a ? b.value : a), ok[0].value);
  return { ok: true, balance: min, reads: ok };
}

async function currentBlock() {
  for (const url of RPCS) {
    try { return Number(BigInt(await rpc(url, "eth_blockNumber", []))); } catch { /* try next */ }
  }
  return null;
}

async function blockTimestamp(n) {
  for (const url of RPCS) {
    try {
      const b = await rpc(url, "eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
      if (b?.timestamp) return Number(BigInt(b.timestamp)) * 1000;
    } catch { /* try next */ }
  }
  return null;
}

// ── log ────────────────────────────────────────────────────────────────────
function readLog() {
  if (!existsSync(LOG_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(LOG_PATH, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("log root is not an array");
    return parsed;
  } catch (e) {
    fail(1, `refusal-log.json is unreadable (${e.message}). Refusing to run rather than overwrite the record.`);
  }
}

function appendLog(entry) {
  const log = readLog();
  log.push(entry);
  writeFileSync(LOG_PATH, `${JSON.stringify(log, null, 2)}\n`);
  return entry;
}

/**
 * Does this entry consume a paid slot?
 *
 * Spec says: entries with a settlement_tx. Implemented as settlement_tx OR a
 * non-null verdict, because a verdict only comes back from a SETTLED audit
 * (out-of-scope refusals return isError and are never charged) — so if the
 * PAYMENT-RESPONSE header capture ever fails, the strict reading would count a
 * real 2.00 USDC spend as zero and let the cap run open. The extra clause only
 * ever refuses more, never less. Flip to `e.settlement_tx != null` alone if you
 * want the literal rule.
 */
const consumesPaidSlot = (e) => e.settlement_tx != null || e.verdict != null;

/** Count settled runs whose ts_block falls in the current UTC day. */
async function paidRunsToday(log, nowBlock) {
  const candidates = log.filter((e) => consumesPaidSlot(e) && typeof e.ts_block === "number");
  if (!candidates.length) return { count: 0, unresolved: 0 };
  // ~43200 blocks/day at 2s. Look back 60000 to be safely past midnight UTC.
  const floor = nowBlock == null ? -Infinity : nowBlock - 60000;
  const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  let count = 0, unresolved = 0;
  for (const e of candidates) {
    if (e.ts_block < floor) continue;              // comfortably older than today
    const ts = await blockTimestamp(e.ts_block);
    if (ts == null) { unresolved++; count++; continue; } // cannot date it -> assume today (conservative)
    if (ts >= dayStart) count++;
  }
  return { count, unresolved };
}

const nextSeq = (log) => log.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0) + 1;

// ── Operator post ──────────────────────────────────────────────────────────
// BLOCKED entries get no post_text — they are internal only.
/**
 * The SUPERSEDED post. An entry carrying a `status` of SUPERSEDED_BY_* must never
 * render the clean EXECUTED template: the verdict was sound but the intent it
 * certified was not, and a standalone "trade taken, gated" post would launder that
 * distinction. This text exists for the log's completeness and publishes ONLY
 * inside the incident narrative.
 */
function buildSupersededPostText({ seq, status, risk_score, verdict_hash, ts_block, intent_sha256, fields }) {
  const n = String(seq).padStart(3, "0");
  const by = String(status ?? "").replace(/^SUPERSEDED_BY_/, "");
  const thesis = dedash(shorten(fields?.claim ?? "", 120));
  return [
    `DJZS REFUSAL LOG // ${n} [SUPERSEDED]`,
    ``,
    `The audit that should not have been bought: ${thesis}.`,
    ``,
    `PASS ${risk_score}/100, and the verdict is sound. The intent it certified is`,
    `not: the probability basis was a placeholder, and the paid run raced a rewrite`,
    `of the file four minutes behind it.`,
    ``,
    `verdict_hash ${shortHash(verdict_hash)} · settled Base block ${ts_block ?? "unrecorded"} · certificate on`,
    `Irys, binding intent ${String(intent_sha256 ?? "").slice(0, 8)}, a wire string no dry run approved.`,
    ``,
    `Caught by verification, not by the engine. M03 checks that a basis is stated,`,
    `not that it is true. Rail added: --expect-sha. Superseded by ${by}.`,
    ``,
    `This entry publishes only inside the incident. It is not a record of a trade.`,
    ``,
    `END_TRANSMISSION. //`,
  ].join("\n");
}

function buildPostText({ seq, decision, status, risk_score, flags, halt_reason, verdict_hash, ts_block, intent_sha256, fields }) {
  // Structural guard: supersession outranks the decision template.
  if (typeof status === "string" && status.startsWith("SUPERSEDED")) {
    return buildSupersededPostText({ seq, status, risk_score, verdict_hash, ts_block, intent_sha256, fields });
  }
  const n = String(seq).padStart(3, "0");
  const thesis = dedash(shorten(fields?.claim ?? "", 120));
  const hash = shortHash(verdict_hash);
  const block = ts_block ?? "unrecorded";

  // Branch on DECISION, not on the raw verdict: decision comes from the single
  // DECISION_BY_VERDICT table, so the two vocabularies can only diverge in one
  // place instead of two. (This function previously tested verdict === "PROCEED"
  // and carried the same defect as the table.)
  if (decision === "EXECUTED") {
    const residual = dedash(shorten(fields?.residual ?? "", 240));
    return [
      `DJZS REFUSAL LOG // ${n}`,
      ``,
      `The trade taken, gated: ${thesis}.`,
      ``,
      `PROCEED ${risk_score}/100. Cleared, not endorsed. The named residual is on`,
      `record as the kill condition: ${residual}.`,
      ``,
      `verdict_hash ${hash} · settled Base block ${block} · certificate on Irys.`,
      ``,
      `The audit gated the logic. The position is mine.`,
      ``,
      `END_TRANSMISSION. //`,
    ].join("\n");
  }

  const codes = flagCodes(flags);
  const middle = decision === "REFUSED"
    ? `FAIL ${risk_score}/100: ${codes.join(" + ")}.`
    : `All four codes cleared. The engine still halted: ${dedash(shorten(String(halt_reason ?? "").split(".")[0], 140))}.`;

  return [
    `DJZS REFUSAL LOG // ${n}`,
    ``,
    `The trade not taken: ${thesis}.`,
    ``,
    middle,
    `Settled: 2.00 USDC, Base block ${block}.`,
    ``,
    `verdict_hash ${hash}. Certificate anchored on Irys.`,
    ``,
    `Here is the decision I did not make, and here is the receipt for why.`,
    ``,
    `END_TRANSMISSION. //`,
  ].join("\n");
}

// TWO VOCABULARIES, do not mix them: the engine returns `verdict` in
// {PASS, WAIT, FAIL} and `action` in {PROCEED, HALT}. Entry 002 was logged
// BLOCKED on a clean PASS because this table was keyed on PROCEED (an ACTION
// word) and "PASS" fell through the `?? "BLOCKED"` default. PROCEED is kept
// only as a defensive alias; the live key is the verdict.
const DECISION_BY_VERDICT = {
  PASS: "EXECUTED",
  PROCEED: "EXECUTED",
  WAIT: "PARKED",
  FAIL: "REFUSED",
};

// ── the paid call (ported payer + settlement-header hook) ──────────────────
function decodePaymentHeader(raw) {
  if (!raw) return null;
  for (const attempt of [() => JSON.parse(raw), () => JSON.parse(Buffer.from(raw, "base64").toString("utf8"))]) {
    try {
      const v = attempt();
      if (v && typeof v === "object") return v;
    } catch { /* next */ }
  }
  return null;
}

async function runAudit(wire, account, agentAddress) {
  // The hook: same fetch, but every response is inspected for the settle receipt.
  const captured = { tx: null, network: null, success: null };
  const hookedFetch = async (input, init) => {
    const res = await fetch(input, init);
    const raw = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    const decoded = decodePaymentHeader(raw);
    if (decoded?.transaction) {
      captured.tx = decoded.transaction;
      captured.network = decoded.network ?? null;
      captured.success = decoded.success ?? null;
    }
    return res;
  };

  const client = new Client({ name: "djzs-refusal-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: hookedFetch }));

  const paid = withX402Client(client, { account, network: NETWORK, maxPaymentValue: MAX_PAYMENT_ATOMIC });

  // callback-first: arg 1 approves the quoted 402 requirements; withX402Client then
  // signs EIP-3009 and retries with X-PAYMENT. The facilitator submits + pays gas.
  const t0 = Date.now();
  let res;
  try {
    res = await paid.callTool(
      (reqs) => {
        console.log(`// 402 -> payment required: ${JSON.stringify(reqs).slice(0, 400)}`);
        console.log(`// approving ${usd(PRICE_ATOMIC)} USDC, signing EIP-3009, retrying with X-PAYMENT ...`);
        return true;
      },
      { name: "verify_pm_trade", arguments: { intent: wire, agent_address: agentAddress } },
    );
  } catch (e) {
    await client.close().catch(() => {});
    return { error: e instanceof Error ? e.message : String(e), captured, seconds: ((Date.now() - t0) / 1000).toFixed(1) };
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  await client.close().catch(() => {});

  // PRIMARY SOURCE for the settlement tx. Entry 002 logged settlement_tx null on a
  // real 2.00 USDC spend because this was read from an HTTP response header — the
  // premise inherited from demo-call.mjs's closing note, and it is wrong. The
  // agents/x402 MCP path never sets a header; the server attaches the facilitator
  // receipt to the tool RESULT (agents/dist/mcp/x402.js:127-133):
  //   result._meta["x402/payment-response"] = { success, transaction, network, payer }
  // The header hook above is retained only as a harmless fallback.
  const meta = res?._meta?.["x402/payment-response"];
  if (meta?.transaction) {
    captured.tx = meta.transaction;
    captured.network = meta.network ?? captured.network;
    captured.success = meta.success ?? captured.success;
    captured.source = "_meta";
  } else if (captured.tx) {
    captured.source = "header";
  }

  const text = res?.content?.[0]?.text;
  if (res?.isError || !text) {
    // in_scope:false (out-of-scope refusal) also lands here — and is NOT charged.
    return { error: `not settled: ${(text ?? JSON.stringify(res)).slice(0, 400)}`, captured, seconds };
  }
  return { out: JSON.parse(text), captured, seconds };
}

// ── modes ──────────────────────────────────────────────────────────────────
function logBlocked(seq, tsBlock, intentSha, reason) {
  return appendLog({
    seq,
    ts_block: tsBlock,
    intent_sha256: intentSha,
    verdict: null,
    risk_score: null,
    flags: [],
    halt_reason: reason,
    verdict_hash: null,
    settlement_tx: null,
    cert_url: null,
    decision: "BLOCKED",
    post_text: null,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.intent) fail(2, "--intent <path> is required.");
  if (args.mode !== "dry" && args.mode !== "paid") fail(2, "--mode must be exactly 'dry' or 'paid'.");

  let raw;
  try { raw = readFileSync(args.intent, "utf8"); }
  catch { fail(2, `Cannot read intent file: ${args.intent}`); }

  const v = validateIntent(raw);

  // ── GATE 1: the four fields. Costs nothing, runs in both modes. ──────────
  if (!v.ok) {
    console.error(`// REFUSED (field gate) :: ${args.intent}`);
    for (const p of v.problems) console.error(`//   - ${p}`);
    console.error("// Nothing spent. Fix the intent file and re-run.");
    if (args.mode === "paid") {
      const log = readLog();
      logBlocked(nextSeq(log), await currentBlock(), null, `field gate: ${v.problems.join("; ")}`);
      console.error("// logged as BLOCKED.");
    }
    process.exit(3);
  }

  const intentSha = sha256(v.wire);
  console.log(`// intent    :: ${args.intent}`);
  console.log(`// wire      :: ${v.wire.length} chars, sha256 ${intentSha}`);

  if (args.mode === "dry") {
    console.log("// FIELD GATE PASSED — all four fields present, probability_basis is sourced.");
    console.log("// dry run: nothing spent, nothing logged.");
    console.log("");
    console.log(v.wire);
    console.log("");
    console.log("// TICKET for the paid run — the file must not change after this:");
    console.log(`//   --expect-sha ${intentSha}`);
    process.exit(0);
  }

  // ── GATE 0: the ticket. Costs nothing; must precede every other paid gate. ──
  // Entry 002 paid 2.00 USDC to audit an intent file that was rewritten four
  // minutes later, so the permanent cert binds a wire string no dry run ever
  // approved. The operator now carries the dry run's sha forward by hand, and a
  // file edited in between can no longer be spent on silently.
  if (!args.expectSha) {
    fail(2, `--expect-sha is required in paid mode.\n${USAGE}\n\nThis run's wire sha is:\n  ${intentSha}\nRe-run the dry gate, then pass its sha as the ticket.`);
  }
  const expected = normalizeSha(args.expectSha);
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    fail(2, `--expect-sha must be 64 hex characters (0x optional); got ${expected.length} char(s).`);
  }
  if (expected !== intentSha) {
    const reason = `ticket mismatch: --expect-sha ${expected} but the intent file renders to ${intentSha} (file changed since the dry run)`;
    console.error(`// REFUSED :: ${reason}`);
    console.error("// Nothing spent. Re-run --mode dry and use the sha it prints.");
    const log0 = readLog();
    logBlocked(nextSeq(log0), await currentBlock(), intentSha, reason);
    console.error("// logged as BLOCKED.");
    process.exit(6);
  }
  console.log(`// ticket    :: MATCH (${intentSha})`);

  // ── paid path ────────────────────────────────────────────────────────────
  const key = process.env.DJZS_PAYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    fail(2, "DJZS_PAYER_KEY missing/invalid — set it to a 0x 64-hex private key (Base mainnet USDC payer). Refusing to run.");
  }
  const agentAddress = process.env.DJZS_AGENT_ADDRESS;
  if (!agentAddress || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    fail(2, "DJZS_AGENT_ADDRESS missing/invalid — set it to the trading wallet (0x + 40 hex). Refusing to run.");
  }

  const account = privateKeyToAccount(key);
  console.log(`// DJZS agent :: verify_pm_trade @ ${ENDPOINT} (${NETWORK})`);
  console.log(`// payer      :: ${account.address}`);
  console.log(`// trading    :: ${agentAddress}`);

  const log = readLog();
  const seq = nextSeq(log);
  const nowBlock = await currentBlock();

  // ── GATE 2: balance on two RPCs. ────────────────────────────────────────
  const bal = await checkBalance(account.address);
  if (!bal.ok) {
    const reason = `balance rail: ${bal.reason}`;
    console.error(`// REFUSED :: ${reason}`);
    logBlocked(seq, nowBlock, intentSha, reason);
    process.exit(4);
  }
  for (const r of bal.reads) console.log(`// balance    :: ${usd(r.value)} USDC (${r.url})`);
  if (bal.balance < MIN_BALANCE_ATOMIC) {
    const reason = `balance rail: payer holds ${usd(bal.balance)} USDC, floor is ${usd(MIN_BALANCE_ATOMIC)}`;
    console.error(`// REFUSED :: ${reason}`);
    logBlocked(seq, nowBlock, intentSha, reason);
    process.exit(4);
  }

  // ── GATE 3: daily cap. ──────────────────────────────────────────────────
  const { count, unresolved } = await paidRunsToday(log, nowBlock);
  if (unresolved) console.log(`// note      :: ${unresolved} entr(ies) could not be dated from chain; counted as today.`);
  if (count >= MAX_PAID_RUNS_PER_UTC_DAY) {
    const reason = `daily cap: ${count} settled run(s) already logged this UTC day, cap is ${MAX_PAID_RUNS_PER_UTC_DAY}`;
    console.error(`// REFUSED :: ${reason}`);
    logBlocked(seq, nowBlock, intentSha, reason);
    process.exit(5);
  }
  console.log(`// cap       :: ${count}/${MAX_PAID_RUNS_PER_UTC_DAY} settled runs this UTC day`);
  console.log("// connecting ...");

  // ── the audit ───────────────────────────────────────────────────────────
  const { out, error, captured, seconds } = await runAudit(v.wire, account, agentAddress);
  if (error) {
    // No verdict came back. An out-of-scope refusal is NOT charged; a transport
    // failure after signing might be. Record whatever the header gave us.
    const reason = `audit did not settle (${seconds}s): ${error}`;
    console.error(`// ${reason}`);
    const entry = logBlocked(seq, nowBlock, intentSha, reason);
    if (captured.tx) {
      entry.settlement_tx = captured.tx;
      const l = readLog(); l[l.length - 1] = entry; writeFileSync(LOG_PATH, `${JSON.stringify(l, null, 2)}\n`);
      console.error(`// WARNING: a settlement tx WAS captured (${captured.tx}) despite no verdict. Funds may have moved.`);
    }
    process.exit(1);
  }

  const settleBlock = (await currentBlock()) ?? nowBlock;
  const verdict = out.verdict;
  const decision = DECISION_BY_VERDICT[verdict] ?? "BLOCKED";
  const codes = flagCodes(out.flags);

  const entry = {
    seq,
    ts_block: settleBlock,
    intent_sha256: intentSha,
    verdict,
    risk_score: out.risk_score ?? null,
    flags: codes,
    halt_reason: out.halt_reason ?? null,
    verdict_hash: out.verdict_hash ?? null,
    settlement_tx: captured.tx,
    cert_url: out.pol_certificate?.gateway_url ?? null,
    decision,
    trust_score: out.trust_score ?? null,
    post_text: null,
  };
  entry.post_text = decision === "BLOCKED"
    ? null
    : buildPostText({ ...entry, ts_block: settleBlock, fields: v.fields });

  appendLog(entry);

  console.log(`// settled in ${seconds}s -> agent/refusal-log.json (entry ${String(seq).padStart(3, "0")})`);
  console.log("============================================");
  console.log("  VERDICT :", verdict, "  ACTION:", out.action, "  RISK:", out.risk_score);
  console.log("  FLAGS   :", JSON.stringify(codes));
  console.log("  UNKNOWN :", JSON.stringify(out.unknown_fields ?? []));
  console.log("  HASH    :", out.verdict_hash);
  console.log("  DECISION:", decision);
  console.log("  TX      :", captured.tx ? `${captured.tx} (via ${captured.source})` : "(NOT CAPTURED — check _meta['x402/payment-response'])");
  if (out.pol_certificate) {
    console.log("  POL     :", out.pol_certificate.status, out.pol_certificate.irys_id ? `(${out.pol_certificate.irys_id})` : "");
  }
  if (out.trust_score) {
    const t = out.trust_score;
    console.log("  TRUST   :", t.status, t.error_class ? `[${t.error_class}]` : "", t.detail ?? t.reason ?? t.tx_hash ?? "");
  }
  console.log("============================================");
  if (entry.post_text) {
    console.log("");
    console.log(entry.post_text);
  }
}

// Exported so the log seeder (and any future tooling) renders posts through the
// SAME code path as a live run — a hand-copied post would drift from the template.
export {
  buildPostText, buildSupersededPostText, renderWire, validateIntent, sha256, DECISION_BY_VERDICT,
  paidRunsToday, consumesPaidSlot, currentBlock, checkBalance,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
