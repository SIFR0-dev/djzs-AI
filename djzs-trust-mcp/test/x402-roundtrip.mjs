#!/usr/bin/env node
// x402-roundtrip.mjs — full Base Sepolia round trip against POST /x402/verify.
// ───────────────────────────────────────────────────────────────────────────
// Proves the HTTP x402 transport end to end, and specifically proves the
// FREE-REFUSAL property on chain: an out-of-scope audit moves zero USDC.
//
// Client libs are the installed @x402/core 2.18 pair, wired exactly as
// agents/dist/mcp/x402.js:149-153 wires withX402Client:
//   new x402Client() -> registerExactEvmScheme(client, { signer: account })
//   -> createPaymentPayload(paymentRequired) -> btoa(JSON) -> X-PAYMENT header
//
// TWO PHASES.
//   node test/x402-roundtrip.mjs            -> generate payer, print address, STOP
//   node test/x402-roundtrip.mjs --go       -> run T1..T5 (after funding)
//
// The throwaway key is written OUTSIDE the repo (os.tmpdir()) so it can never be
// staged and no .gitignore edit is needed. Testnet key, zero custody value.
//
// RAILS honoured here:
//   - agent_address is NEVER sent, so the mainnet trust-writer cannot fire.
//   - IRYS_UPLOAD_KEY / DJZS_WRITER_KEY are expected ABSENT; the route reports
//     pol_certificate.status "disabled" and omits trust_score. Asserted, not
//     worked around.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";

const URL_ = process.env.X402_TEST_URL ?? "http://127.0.0.1:8799/x402/verify";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://sepolia.base.org";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TREASURY = "0xc1923748669dFC3a79497d0403A90a275161eCCA";
const NETWORK = "eip155:84532";
const KEY_PATH = join(tmpdir(), "djzs-x402-sepolia-payer.json");

const INTENT_IN_SCOPE =
  "Thesis for a prediction-market trade: buy YES on the Fed holding in September at 64c on Kalshi. " +
  "Basis: KXFEDDECISION-26SEP-H0 mid 64.5c, retrieved 2026-08-09. Falsifier: the September FOMC " +
  "decision itself. Residual: a hot CPI print repricing the ladder toward the hike.";
const INTENT_OUT_OF_SCOPE = "Open a 5x BTC perpetual long at market because momentum is strong.";

// ── assertion plumbing ─────────────────────────────────────────────────────
let pass = 0, failed = 0;
const results = [];
function assert(label, cond, detail = "") {
  const ok = !!cond;
  ok ? pass++ : failed++;
  results.push({ label, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
  return ok;
}
const usdc = (atomic) => (Number(atomic) / 1e6).toFixed(6);

/**
 * Fail-fast barrier. Each paid test spends 2.00 testnet USDC, so continuing past
 * a failure both wastes funds and muddies the T4 balance deltas. Called after
 * every test block: first failure halts the run.
 */
function checkpoint(stage) {
  if (failed === 0) return;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  HALTED AT ${stage} — ${failed} assertion(s) failed, ${pass} passed.`);
  console.log("  No retry attempted (each paid retry spends 2.00 USDC).");
  for (const r of results.filter((x) => !x.ok)) console.log(`    FAIL: ${r.label}  ${r.detail}`);
  console.log("=".repeat(60));
  process.exit(1);
}

// ── chain read (public Sepolia RPC; no key, no gas) ────────────────────────
async function usdcBalance(address) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const r = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_SEPOLIA, data }, "latest"] }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`sepolia rpc: ${j.error.message}`);
  return BigInt(j.result);
}

// ── payer ──────────────────────────────────────────────────────────────────
function loadOrCreatePayer() {
  if (existsSync(KEY_PATH)) {
    const { privateKey } = JSON.parse(readFileSync(KEY_PATH, "utf8"));
    return { account: privateKeyToAccount(privateKey), created: false };
  }
  const privateKey = generatePrivateKey();
  writeFileSync(KEY_PATH, JSON.stringify({ privateKey, note: "throwaway Base Sepolia test payer" }, null, 2), { mode: 0o600 });
  return { account: privateKeyToAccount(privateKey), created: true };
}

// ── one HTTP call ──────────────────────────────────────────────────────────
async function post(intent, paymentToken) {
  const headers = { "content-type": "application/json" };
  if (paymentToken) headers["X-PAYMENT"] = paymentToken;
  // NOTE: agent_address is deliberately never included (mainnet trust-write rail).
  const res = await fetch(URL_, {
    method: "POST",
    headers,
    body: JSON.stringify({ intent }),
    signal: AbortSignal.timeout(120000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* leave null */ }
  return { status: res.status, body, headers: res.headers };
}

/** Fetch a fresh 402 challenge and sign a payment payload for it. */
async function signPaymentFor(intent, account) {
  const unpaid = await post(intent);
  if (unpaid.status !== 402) throw new Error(`expected 402 challenge, got ${unpaid.status}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const paymentRequired = {
    x402Version: unpaid.body.x402Version ?? 2,
    resource: unpaid.body.resource ?? { url: URL_, description: "", mimeType: "application/json" },
    accepts: unpaid.body.accepts,
    extensions: unpaid.body.extensions,
  };
  const payload = await client.createPaymentPayload(paymentRequired);
  return { token: btoa(JSON.stringify(payload)), challenge: unpaid };
}

// ── phase 1: generate + stop ───────────────────────────────────────────────
const go = process.argv.includes("--go");
const { account, created } = loadOrCreatePayer();

if (!go) {
  console.log("DJZS x402 Base Sepolia round trip — PHASE 1 (setup)\n");
  console.log(`  payer address : ${account.address}`);
  console.log(`  key file      : ${KEY_PATH}  ${created ? "(newly generated)" : "(reused)"}`);
  console.log(`  network       : ${NETWORK} (Base Sepolia)`);
  console.log(`  target        : ${URL_}`);
  let bal = null;
  try { bal = await usdcBalance(account.address); } catch (e) { console.log(`  balance       : unreadable (${e.message})`); }
  if (bal !== null) console.log(`  USDC balance  : ${usdc(bal)}`);
  console.log("\nSTOPPING. Fund this address with Base Sepolia USDC at https://faucet.circle.com");
  console.log("(EIP-3009 exact: the facilitator pays gas, so the payer needs ZERO ETH.)");
  console.log("Needs >= 2.000000 USDC for one paid audit; 4.000000 is comfortable.\n");
  console.log("Then, with wrangler dev already running:");
  console.log("  node test/x402-roundtrip.mjs --go");
  process.exit(0);
}

// ── phase 2: the round trip ────────────────────────────────────────────────
console.log("DJZS x402 Base Sepolia round trip — PHASE 2\n");
console.log(`  payer  ${account.address}`);
console.log(`  target ${URL_}\n`);

const startBal = await usdcBalance(account.address);
console.log(`  starting USDC: ${usdc(startBal)}`);
if (startBal < 2000000n) {
  console.error(`\nABORT: payer holds ${usdc(startBal)} USDC, need >= 2.000000. Fund at https://faucet.circle.com`);
  process.exit(2);
}

// ── T1 UNPAID ──────────────────────────────────────────────────────────────
console.log("\nT1 UNPAID — 402 challenge");
{
  const r = await post(INTENT_IN_SCOPE);
  assert("HTTP 402", r.status === 402, `got ${r.status}`);
  const hdr = r.headers.get("PAYMENT-REQUIRED");
  assert("PAYMENT-REQUIRED header present", !!hdr);
  let decoded = null;
  if (hdr) { try { decoded = decodePaymentRequiredHeader(hdr); } catch (e) { assert("header decodes", false, e.message); } }
  if (decoded) {
    assert("header decodes", true);
    const a = decoded.accepts?.[0] ?? {};
    assert('scheme "exact"', a.scheme === "exact", `got ${a.scheme}`);
    assert(`network ${NETWORK}`, a.network === NETWORK, `got ${a.network}`);
    assert("payTo == treasury", String(a.payTo).toLowerCase() === TREASURY.toLowerCase(), `got ${a.payTo}`);
    assert("amount 2000000", String(a.amount) === "2000000", `got ${a.amount}`);
    assert('extra.name "USDC" (Sepolia EIP-712 domain)', a.extra?.name === "USDC", `got ${a.extra?.name}`);
  }
}
checkpoint("T1 UNPAID");

// ── T2 PAID, IN SCOPE ──────────────────────────────────────────────────────
console.log("\nT2 PAID, IN SCOPE — settle expected");
const balBeforeT2 = await usdcBalance(account.address);
let t2Tx = null;
{
  const { token } = await signPaymentFor(INTENT_IN_SCOPE, account);
  const r = await post(INTENT_IN_SCOPE, token);
  assert("HTTP 200", r.status === 200, `got ${r.status}${r.status !== 200 ? ` body=${JSON.stringify(r.body).slice(0, 220)}` : ""}`);
  assert("verdict JSON present", !!r.body && typeof r.body.verdict === "string", `verdict=${r.body?.verdict}`);
  assert("verdict_hash present", !!r.body?.verdict_hash);
  const prHdr = r.headers.get("PAYMENT-RESPONSE");
  assert("PAYMENT-RESPONSE header present", !!prHdr);
  if (prHdr) {
    try {
      const settle = decodePaymentResponseHeader(prHdr);
      t2Tx = settle.transaction;
      assert("PAYMENT-RESPONSE decodes to a tx hash", /^0x[0-9a-fA-F]{64}$/.test(String(t2Tx)), `got ${t2Tx}`);
    } catch (e) { assert("PAYMENT-RESPONSE decodes to a tx hash", false, e.message); }
  }
  // Rails: absent secrets must degrade, not be worked around.
  assert("pol_certificate disabled (IRYS_UPLOAD_KEY absent by design)",
    r.body?.pol_certificate?.status === "disabled", `got ${r.body?.pol_certificate?.status}`);
  assert("trust_score absent (no agent_address sent; mainnet writer untouched)",
    r.body?.trust_score === undefined, `got ${JSON.stringify(r.body?.trust_score)}`);
}
checkpoint("T2 PAID IN SCOPE");

// ── T3 PAID, OUT OF SCOPE ──────────────────────────────────────────────────
console.log("\nT3 PAID, OUT OF SCOPE — refusal must be FREE");
const balAfterT2 = await usdcBalance(account.address);
{
  const { token } = await signPaymentFor(INTENT_OUT_OF_SCOPE, account);
  const r = await post(INTENT_OUT_OF_SCOPE, token);
  assert("HTTP 402", r.status === 402, `got ${r.status}`);
  assert("settled:false", r.body?.settled === false, `got ${r.body?.settled}`);
  assert("in_scope:false", r.body?.in_scope === false, `got ${r.body?.in_scope}`);
  assert("no PAYMENT-RESPONSE header (nothing settled)", !r.headers.get("PAYMENT-RESPONSE"));
}
checkpoint("T3 PAID OUT OF SCOPE");
const balAfterT3 = await usdcBalance(account.address);

// ── T4 BALANCES ────────────────────────────────────────────────────────────
console.log("\nT4 BALANCES — free-refusal proven on chain");
{
  const dT2 = balAfterT2 - balBeforeT2;
  const dT3 = balAfterT3 - balAfterT2;
  console.log(`  before T2 ${usdc(balBeforeT2)} | after T2 ${usdc(balAfterT2)} | after T3 ${usdc(balAfterT3)}`);
  assert("T2 delta exactly -2.000000", dT2 === -2000000n, `got ${usdc(dT2)}`);
  assert("T3 delta exactly 0", dT3 === 0n, `got ${usdc(dT3)}`);
}
checkpoint("T4 BALANCES");

// ── T5 MALFORMED ───────────────────────────────────────────────────────────
console.log("\nT5 MALFORMED X-PAYMENT — reject, no settlement");
const balBeforeT5 = await usdcBalance(account.address);
{
  const { token } = await signPaymentFor(INTENT_IN_SCOPE, account);
  // Flip bytes inside the base64 payload so the signature no longer matches.
  const obj = JSON.parse(atob(token));
  if (obj?.payload?.signature) obj.payload.signature = obj.payload.signature.slice(0, -4) + "dead";
  else obj.accepted = { ...obj.accepted, amount: "1" };
  const tampered = btoa(JSON.stringify(obj));
  const r = await post(INTENT_IN_SCOPE, tampered);
  assert("HTTP 402", r.status === 402, `got ${r.status}`);
  assert("error reports invalid payment", typeof r.body?.error === "string" && r.body.error !== "PAYMENT_REQUIRED", `got ${r.body?.error}`);
  assert("no PAYMENT-RESPONSE header", !r.headers.get("PAYMENT-RESPONSE"));
}
const balAfterT5 = await usdcBalance(account.address);
assert("T5 delta exactly 0", balAfterT5 - balBeforeT5 === 0n, `got ${usdc(balAfterT5 - balBeforeT5)}`);

// ── summary ────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`  ${pass} passed, ${failed} failed`);
console.log(`  net USDC moved: ${usdc(balAfterT5 - startBal)} (expected -2.000000)`);
if (t2Tx) {
  console.log("\n  T2 SETTLEMENT TX:");
  console.log(t2Tx);
}
console.log("=".repeat(60));
process.exit(failed === 0 ? 0 : 1);
