/**
 * buyer-probe.mjs — a v2-exact x402 BUYER for the production Bazaar route.
 *
 * The offline harness (adapter-offline.ts) pins the server's ordering invariants
 * with zero keys and zero egress. This is the other half: a real payer, signing
 * real EIP-3009 authorizations against the live route, asserting that the two
 * money-path branches behave as the terms promise.
 *
 *   npx --no-install node djzs-trust-mcp/harness/buyer-probe.mjs --mode refuse
 *   npx --no-install node djzs-trust-mcp/harness/buyer-probe.mjs --mode settle
 *
 * Exit 0 => every check in the ledger passed.
 * Exit 1 => at least one missed; the full ledger is printed either way.
 *
 * ── KEY HYGIENE (hard rules, enforced in code below) ──────────────────────
 *   - The wallet key comes ONLY from process.env.BUYER_PRIVATE_KEY.
 *   - Unset/blank => refuse to run. There is no prompt, no second source,
 *     no file fallback, no flag. A key cannot enter this process any other way.
 *   - The key is never echoed, logged, or written. console.log/error are wrapped
 *     with a redactor before the key is ever read, so even an exception message
 *     or a library stack trace carrying the value cannot reach stdout/stderr.
 *   - The value is dropped from process.env once the signer is built.
 *   - This file writes NOTHING to disk. No receipts, no caches, no dotfiles.
 *
 * ── WHAT EACH MODE PROVES ─────────────────────────────────────────────────
 *   --mode refuse : a schema-valid but OUT-OF-SCOPE intent, submitted WITH a
 *                   valid payment authorization. The route must refuse it at the
 *                   scope gate and NEVER settle: 200 / REFUSED_SCOPE /
 *                   charged:false / no PAYMENT-RESPONSE. This is the invariant
 *                   the terms page sells — "out of scope is refused WITHOUT
 *                   CHARGE" — and it is the one worth paying to test, because
 *                   the payer signs an authorization that must go unredeemed.
 *   --mode settle : the canonical in-scope probe intent (copied verbatim from the
 *                   discovery block). The route must settle FIRST and then return
 *                   a verdict: 200 / PASS|WAIT|FAIL / charged:true /
 *                   PAYMENT-RESPONSE present and decodable.
 *
 * NOTE ON CONSTANTS: the expected price, asset, network and payTo are restated
 * here as literals rather than imported from http-x402-bazaar.v2.ts. That is
 * deliberate. A buyer that imports the seller's own opinion of the price cannot
 * detect the seller changing it — the assertion would be circular. These are what
 * this probe BELIEVES it is buying; a drift is meant to fail the ledger loudly.
 *
 * Verified against the installed client packages @ build time (2026-08-20):
 *   @x402/core@2.23.0  @x402/evm@2.23.0  viem@2.55.1
 *   @x402/core/client      -> x402Client, x402HTTPClient, DEFAULT_MAX_AMOUNT_PER_PAYMENT
 *   @x402/core/http        -> decodePaymentResponseHeader
 *   @x402/evm/exact/client -> registerExactEvmScheme
 */

// ══ 1. REDACTING CONSOLE — installed BEFORE the key is read ═══════════════
// Wrapping stdout/stderr first means there is no window in which an unredacted
// value could be printed by a throw inside the very code that loads it.
const RAW_LOG = console.log.bind(console);
const RAW_ERR = console.error.bind(console);
let SECRETS = [];

function redact(value) {
  if (typeof value === "string") {
    let out = value;
    for (const s of SECRETS) if (s) out = out.split(s).join("[REDACTED]");
    return out;
  }
  if (value instanceof Error) return redact(value.stack ?? value.message);
  if (typeof value === "object" && value !== null) {
    try {
      return redact(JSON.stringify(value));
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

console.log = (...args) => RAW_LOG(...args.map(redact));
console.error = (...args) => RAW_ERR(...args.map(redact));

// ══ 2. ASSERTION LEDGER ═══════════════════════════════════════════════════
const ledger = [];
class LedgerHalt extends Error {}

function record(name, ok, detail) {
  const n = ledger.length + 1;
  ledger.push({ n, name, ok, detail });
  console.log(`CHECK ${n} ${ok ? "ok" : "FAIL"}: ${name}${!ok && detail ? ` :: ${detail}` : ""}`);
  return ok;
}

/** A soft check: records and continues, so one miss still yields a full ledger. */
function check(name, ok, detail) {
  return record(name, ok, detail);
}

/** A blocking check: nothing downstream is meaningful if it misses. */
function must(name, ok, detail) {
  if (!record(name, ok, detail)) throw new LedgerHalt(name);
  return true;
}

function printLedger() {
  const failed = ledger.filter((e) => !e.ok);
  console.log("\n──────── LEDGER ────────");
  for (const e of ledger) {
    console.log(`${e.ok ? "PASS" : "FAIL"}  ${String(e.n).padStart(2)}. ${e.name}${e.detail ? ` :: ${e.detail}` : ""}`);
  }
  console.log(`──────── ${ledger.length - failed.length}/${ledger.length} passed ────────`);
  return failed.length;
}

// ══ 3. WHAT THIS PROBE BELIEVES IT IS BUYING ══════════════════════════════
const DEFAULT_URL = "https://mcp.djzs.ai/x402/verify_pm_trade";
const EXPECT_AMOUNT = "2000000"; // 2.00 USDC at 6 decimals
const EXPECT_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (Base)
const EXPECT_NETWORK = "eip155:8453"; // Base mainnet
const EXPECT_PAY_TO = "0xc1923748669dFC3a79497d0403A90a275161eCCA"; // DJZS treasury

/**
 * The library's default per-payment cap is "$1" (DEFAULT_MAX_AMOUNT_PER_PAYMENT),
 * and this route quotes $2.00 — so the default would reject the quote before any
 * signature. The cap is raised to exactly $2, not disabled: the comparison is
 * `<=`, so this admits the intended price and nothing above it. If the route ever
 * quotes more, the spend control stops the payment rather than the ledger
 * discovering it after the money moved.
 */
const DEFAULT_MAX_USD = "$2";

// The canonical in-scope probe — copied verbatim from the discovery block's
// `input.intent` in http-x402-bazaar.v2.ts. If that example changes, change this.
const SETTLE_INTENT = {
  market: "KXBTC-26AUG29-T70000",
  side: "YES",
  thesis: "BTC closes above 70k by Aug 29 on ETF inflow continuation",
  probability_basis: "implied 0.41 vs model 0.55; basis: Kalshi mid, 2026-08-19T14:00Z",
  size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 66000" },
};

// Schema-valid and fully populated — every field the input schema names is
// present and well-formed. The ONLY thing wrong with it is that a spot-equity
// thesis is not a prediction-market trade. That is the point: the refusal must
// come from the scope gate, not from body validation, so a 400 here would be a
// different (and passing-looking) code path and is asserted against below.
const REFUSE_INTENT = {
  market: "NASDAQ:TSLA",
  side: "LONG",
  thesis: "TSLA to 500 on earnings",
  probability_basis: "implied 0.38 vs model 0.55; basis: CBOE options mid, 2026-08-20T14:00Z",
  size_usd: 250,
  bounds: { max_loss_usd: 250, exit_condition: "daily close below 420" },
};

// ══ 4. ARGUMENTS ══════════════════════════════════════════════════════════
function parseArgs(argv) {
  const out = { mode: null, url: DEFAULT_URL, maxUsd: DEFAULT_MAX_USD, rpcUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      return v;
    };
    if (a === "--mode") out.mode = next();
    else if (a === "--url") out.url = next();
    else if (a === "--max-usd") out.maxUsd = next();
    else if (a === "--rpc-url") out.rpcUrl = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `
buyer-probe.mjs — v2-exact x402 buyer for ${DEFAULT_URL}

  --mode refuse | settle   (required)
  --url <url>              target route            [default ${DEFAULT_URL}]
  --max-usd <money>        per-payment spend cap   [default ${DEFAULT_MAX_USD}]
  --rpc-url <url>          EVM RPC for the exact scheme, if it needs one

The wallet key is read ONLY from the environment variable BUYER_PRIVATE_KEY.
There is no flag for it and it is never printed.
`;

// ══ 5. KEY INTAKE — the only door ═════════════════════════════════════════
function loadSigningKey() {
  const raw = process.env.BUYER_PRIVATE_KEY;
  if (typeof raw !== "string" || raw.trim() === "") {
    console.error("REFUSING TO RUN: BUYER_PRIVATE_KEY is not set.");
    console.error("");
    console.error("Export it in the calling shell; this probe will not prompt for it,");
    console.error("read it from a file, or accept it as a flag:");
    console.error("");
    console.error("  export BUYER_PRIVATE_KEY=0x…   # then re-run");
    console.error("");
    process.exit(1);
  }
  const key = raw.trim();

  // Register for redaction BEFORE any validation that might quote the value.
  SECRETS.push(key, key.startsWith("0x") ? key.slice(2) : `0x${key}`);

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // Shape only — never the value, not even a prefix.
    console.error("REFUSING TO RUN: BUYER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key.");
    console.error(`  (received ${key.length} characters; expected 66)`);
    process.exit(1);
  }
  return key;
}

// ══ 6. THE PROBE ══════════════════════════════════════════════════════════
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.mode !== "refuse" && args.mode !== "settle") {
    console.error(`REFUSING TO RUN: --mode must be "refuse" or "settle"${args.mode ? `, got "${args.mode}"` : " (missing)"}.`);
    console.error(USAGE);
    process.exit(1);
  }

  const key = loadSigningKey();

  const { x402Client, x402HTTPClient, DEFAULT_MAX_AMOUNT_PER_PAYMENT } = await import("@x402/core/client");
  const { decodePaymentResponseHeader } = await import("@x402/core/http");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount } = await import("viem/accounts");

  const account = privateKeyToAccount(key);
  // The signer holds what it needs; nothing downstream should be able to reach
  // the raw value through the environment (including any child process).
  delete process.env.BUYER_PRIVATE_KEY;

  const intent = args.mode === "settle" ? SETTLE_INTENT : REFUSE_INTENT;

  console.log(`buyer-probe: mode=${args.mode}`);
  console.log(`  target : ${args.url}`);
  console.log(`  payer  : ${account.address}`); // public address, not the key
  console.log(`  cap    : ${args.maxUsd} (library default is ${DEFAULT_MAX_AMOUNT_PER_PAYMENT})`);
  console.log("");

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    ...(args.rpcUrl ? { schemeOptions: { rpcUrl: args.rpcUrl } } : {}),
  });
  client.setSpendControls({ maxAmountPerPayment: args.maxUsd });
  const http = new x402HTTPClient(client);

  const body = JSON.stringify({ intent });

  // ── Round 1: unpaid. Expect the 402 challenge. ──────────────────────────
  const unpaid = await fetch(args.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  must("round 1: unpaid POST is answered 402", unpaid.status === 402, `status=${unpaid.status}`);
  check("round 1: 402 carries a PAYMENT-REQUIRED header", unpaid.headers.get("PAYMENT-REQUIRED") !== null);

  let challengeBody = null;
  try {
    challengeBody = await unpaid.json();
  } catch {
    /* header path is authoritative; body is the v1 fallback */
  }
  const paymentRequired = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), challengeBody);
  must("round 1: challenge decodes to a PaymentRequired", !!paymentRequired?.accepts?.length);
  check("round 1: challenge declares x402Version 2", paymentRequired.x402Version === 2, `v=${paymentRequired.x402Version}`);

  // ── The quote is asserted BEFORE anything is signed. ────────────────────
  const accept = paymentRequired.accepts[0];
  check("quote: amount is 2.00 USDC atomic", accept.amount === EXPECT_AMOUNT, `amount=${accept.amount}`);
  check("quote: asset is Base USDC", String(accept.asset).toLowerCase() === EXPECT_ASSET.toLowerCase(), `asset=${accept.asset}`);
  check("quote: network is Base mainnet", accept.network === EXPECT_NETWORK, `network=${accept.network}`);
  check("quote: payTo is the DJZS treasury", String(accept.payTo).toLowerCase() === EXPECT_PAY_TO.toLowerCase(), `payTo=${accept.payTo}`);

  // ── Sign the authorization. No funds move here. ─────────────────────────
  const payload = await http.createPaymentPayload(paymentRequired);
  must("payment: authorization signed", !!payload, "createPaymentPayload returned nothing");
  const payHeaders = http.encodePaymentSignatureHeader(payload);
  check("payment: encoded as a PAYMENT-SIGNATURE header", typeof payHeaders["PAYMENT-SIGNATURE"] === "string");

  // ── Round 2: paid. ──────────────────────────────────────────────────────
  const paid = await fetch(args.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...payHeaders },
    body,
  });
  const paidText = await paid.text();
  let paidBody;
  try {
    paidBody = JSON.parse(paidText);
  } catch {
    paidBody = null;
  }
  must("round 2: paid POST returns a JSON body", paidBody !== null, paidText.slice(0, 200));

  // Read the settlement receipt off the wire directly rather than through a
  // transport helper: the assertion is about what the server actually sent.
  const settleHeader = paid.headers.get("PAYMENT-RESPONSE") ?? paid.headers.get("X-PAYMENT-RESPONSE");

  console.log("");
  if (args.mode === "refuse") {
    check("refuse: HTTP 200", paid.status === 200, `status=${paid.status}`);
    check("refuse: verdict is REFUSED_SCOPE", paidBody?.verdict === "REFUSED_SCOPE", `verdict=${JSON.stringify(paidBody?.verdict)}`);
    check("refuse: charged is false", paidBody?.charged === false, `charged=${JSON.stringify(paidBody?.charged)}`);
    check("refuse: NO PAYMENT-RESPONSE header — nothing settled", settleHeader === null, `header=${settleHeader ? "present" : "absent"}`);
    console.log("");
    console.log(`REASON: ${paidBody?.reason ?? "(none given)"}`);
    console.log("SETTLE: none");
  } else {
    check("settle: HTTP 200", paid.status === 200, `status=${paid.status}`);
    check(
      "settle: verdict is one of PASS/WAIT/FAIL",
      ["PASS", "WAIT", "FAIL"].includes(paidBody?.verdict),
      `verdict=${JSON.stringify(paidBody?.verdict)}`,
    );
    check("settle: charged is true", paidBody?.charged === true, `charged=${JSON.stringify(paidBody?.charged)}`);
    must("settle: PAYMENT-RESPONSE header present", typeof settleHeader === "string" && settleHeader.length > 0);

    const receipt = decodePaymentResponseHeader(settleHeader);
    check("settle: receipt decodes with success=true", receipt?.success === true, `success=${JSON.stringify(receipt?.success)}`);
    check("settle: receipt network is Base mainnet", receipt?.network === EXPECT_NETWORK, `network=${receipt?.network}`);

    console.log("");
    console.log(`VERDICT:    ${paidBody.verdict}  risk=${paidBody.risk_score}  flags=${JSON.stringify(paidBody.flags)}`);
    console.log("SETTLE: settled");
    console.log(`  transaction: ${receipt.transaction}`);
    console.log(`  network:     ${receipt.network}`);
  }
}

main()
  .then(() => {
    const failed = printLedger();
    console.log(failed === 0 ? "\nBUYER PROBE: PASS" : "\nBUYER PROBE: FAIL");
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    if (!(e instanceof LedgerHalt)) {
      console.error("\nPROBE ERROR:", e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    printLedger();
    console.log("\nBUYER PROBE: FAIL");
    process.exit(1);
  });
