/**
 * DJZS-A calldata-bench — Step 2 gate. ZERO network.
 * ───────────────────────────────────────────────────
 * Part A: unit decode cases. Calldata is built IN the bench with viem's
 * encodeFunctionData, decoded by the adapter, and asserted FieldState-by-FieldState
 * (SourceRef included — fetched_at is the injected fixed clock, so it is exact).
 * Part B: two integration cases feeding adapter output through the Step-1
 * comparators end-to-end: (1) unbounded approval -> A01 critical -> FAIL, (2)
 * ABI-absent -> all-unknown -> WAIT.
 *
 * Run:  ./node_modules/.bin/tsx server/engine-v2/calibration/calldata-bench.ts
 * Exit: 0 all green + deterministic; 1 otherwise.
 */
import { encodeFunctionData, type Abi } from "viem";
import {
  decodeCalldataTruth,
  type CalldataTruth,
  type TxInput,
  type AbiInput,
} from "../adapters/calldata";
import {
  runAssertionAudit,
  type ClaimRecord,
  type TruthRecord,
  type AConfig,
  type FieldState,
  type SourceRef,
  type AVerdict,
  type EnvClass,
  type Authority,
  type AssumedState,
} from "../assertion-engine";

const ERC20_ABI = [
  {
    type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "transferFrom", stateMutability: "nonpayable",
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

const MAX_UINT256 = (1n << 256n) - 1n;
const FETCHED_AT = "2020-01-01T00:00:00.000Z";
const OPTS = { fetchedAt: FETCHED_AT };

// Recipient/spender addresses are digit-only so EIP-55 checksum == lowercase
// (keeps expectations trivially exact); the token carries letters on purpose.
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKENL = TOKEN.toLowerCase();
const RECIP = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";

// Canonical ERC-20 selectors (independent of the adapter's own derivation).
const SEL_TRANSFER = "0xa9059cbb";
const SEL_TRANSFERFROM = "0x23b872dd";
const SEL_APPROVE = "0x095ea7b3";

const src = (sel: string, to: string): SourceRef => ({ adapter: "calldata", fetched_at: FETCHED_AT, ref: `${sel}@${to.toLowerCase()}` });
const p = <T>(value: T, sel: string, to: string): FieldState<T> => ({ state: "present", value, source: src(sel, to) });
const U = { state: "unknown", reason: "unfetchable" } as const;
const ABSENT = { state: "absent" } as const;

// bigint-aware deep equality (JSON.stringify can't serialize bigint).
function eq(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function allUnknownTruth(): CalldataTruth {
  return { tx_amount: U, tx_recipient: U, touched_set: U, approval_bound: U };
}

interface UnitCase {
  name: string;
  tx: TxInput;
  abi: AbiInput;
  expected: CalldataTruth;
}

const verifiedErc20: AbiInput = { provenance: "verified", abi: ERC20_ABI as unknown as Abi };

const txTransfer: TxInput = {
  to: TOKEN, value: 0n, chainId: 8453,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [RECIP, 1000n] }),
};
const txTransferFrom: TxInput = {
  to: TOKEN, value: 0n, chainId: 8453,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transferFrom", args: [SPENDER, RECIP, 2500n] }),
};
const txApproveFinite: TxInput = {
  to: TOKEN, value: 0n, chainId: 8453,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SPENDER, 500n] }),
};
const txApproveMax: TxInput = {
  to: TOKEN, value: 0n, chainId: 8453,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SPENDER, MAX_UINT256] }),
};
const txNative: TxInput = { to: RECIP, value: 5n, chainId: 8453, data: "0x" };

const UNIT_CASES: UnitCase[] = [
  {
    name: "ERC-20 transfer(to, 1000)",
    tx: txTransfer, abi: verifiedErc20,
    expected: {
      tx_amount: p(1000n, SEL_TRANSFER, TOKEN),
      tx_recipient: p(RECIP.toLowerCase(), SEL_TRANSFER, TOKEN),
      touched_set: p([TOKENL], SEL_TRANSFER, TOKEN),
      approval_bound: ABSENT,
    },
  },
  {
    name: "ERC-20 transferFrom(from, to, 2500)",
    tx: txTransferFrom, abi: verifiedErc20,
    expected: {
      tx_amount: p(2500n, SEL_TRANSFERFROM, TOKEN),
      tx_recipient: p(RECIP.toLowerCase(), SEL_TRANSFERFROM, TOKEN),
      touched_set: p([TOKENL], SEL_TRANSFERFROM, TOKEN),
      approval_bound: ABSENT,
    },
  },
  {
    name: "ERC-20 approve(spender, 500) — finite",
    tx: txApproveFinite, abi: verifiedErc20,
    expected: {
      tx_amount: p(500n, SEL_APPROVE, TOKEN),
      tx_recipient: p(SPENDER.toLowerCase(), SEL_APPROVE, TOKEN),
      touched_set: p([TOKENL], SEL_APPROVE, TOKEN),
      approval_bound: p({ bound: "finite", amount: 500n }, SEL_APPROVE, TOKEN),
    },
  },
  {
    name: "ERC-20 approve(spender, MAX_UINT256) — unbounded",
    tx: txApproveMax, abi: verifiedErc20,
    expected: {
      tx_amount: p(MAX_UINT256, SEL_APPROVE, TOKEN),
      tx_recipient: p(SPENDER.toLowerCase(), SEL_APPROVE, TOKEN),
      touched_set: p([TOKENL], SEL_APPROVE, TOKEN),
      approval_bound: p({ bound: "unbounded" }, SEL_APPROVE, TOKEN),
    },
  },
  {
    name: "native transfer (empty data -> amount from value)",
    tx: txNative, abi: { provenance: "absent" },
    expected: {
      tx_amount: p(5n, "0x", RECIP),
      tx_recipient: p(RECIP.toLowerCase(), "0x", RECIP),
      touched_set: p([RECIP.toLowerCase()], "0x", RECIP),
      approval_bound: ABSENT,
    },
  },
  {
    name: "unknown selector (verified ABI, selector not present) -> all unknown",
    tx: { to: TOKEN, value: 0n, chainId: 8453, data: "0xdeadbeef" }, abi: verifiedErc20,
    expected: allUnknownTruth(),
  },
  {
    name: "malformed/truncated data -> all unknown",
    tx: { to: TOKEN, value: 0n, chainId: 8453, data: `${SEL_TRANSFER}00` }, abi: verifiedErc20,
    expected: allUnknownTruth(),
  },
  {
    name: "ABI absent -> all unknown (no selector guess)",
    tx: txTransfer, abi: { provenance: "absent" },
    expected: allUnknownTruth(),
  },
  {
    name: "ABI unverified -> all unknown (provenance gate)",
    tx: txTransfer, abi: { provenance: "unverified", abi: ERC20_ABI as unknown as Abi },
    expected: allUnknownTruth(),
  },
];

// ─── Step-1 wiring for the integration cases ────────────────────────────────
const SYN: SourceRef = { adapter: "synthetic", fetched_at: FETCHED_AT, ref: "bench" };
const P = <T>(value: T): FieldState<T> => ({ state: "present", value, source: SYN });
const UNK: FieldState<never> = { state: "unknown", reason: "unfetchable" };
const CFG: AConfig = { amount_tolerance: 0, price_slippage_bps: 50 };

/** Map calldata output into a TruthRecord; fields no calldata decode can know
 *  (env/binding/provenance/fresh_state) are honestly unknown until their adapters run. */
function truthFromCalldata(ct: CalldataTruth): TruthRecord {
  let approval: TruthRecord["approval"];
  if (ct.approval_bound.state === "present") {
    approval = P<"bounded" | "unbounded">(ct.approval_bound.value.bound === "unbounded" ? "unbounded" : "bounded");
  } else if (ct.approval_bound.state === "absent") {
    approval = { state: "absent" };
  } else {
    approval = { state: "unknown", reason: ct.approval_bound.reason };
  }
  const touched: TruthRecord["touched"] =
    ct.touched_set.state === "present" ? P(ct.touched_set.value)
    : ct.touched_set.state === "absent" ? { state: "absent" }
    : { state: "unknown", reason: ct.touched_set.reason };

  return {
    amount: UNK, // bigint tx_amount not bridged to the number field this step (flagged)
    approval,
    touched,
    env: UNK, // A03 env comes from a different adapter
    binding: UNK, // A04 from the registry adapter (Step 4)
    provenance: UNK, // A05 from the provenance adapter (Step 6)
    fresh_state: UNK, // A06 from the state adapter (Step 3)
  };
}

function claim(amount: number, scope: string[]): ClaimRecord {
  return {
    amount: P(amount),
    scope: P(scope),
    env: P<EnvClass>({ chainId: 8453, class: "evm-l2" }),
    authority: P<Authority>("user"),
    assumed_state: P<AssumedState>({ price: 100, nonce: 5 }),
  };
}

interface IntegrationCase {
  name: string;
  expected: AVerdict;
  run: () => ReturnType<typeof runAssertionAudit>;
}

const INTEGRATION: IntegrationCase[] = [
  {
    name: "approve(MAX) decoded -> A01 unbounded (critical) -> FAIL (even amid unknowns)",
    expected: "FAIL",
    run: () => {
      const ct = decodeCalldataTruth(txApproveMax, verifiedErc20, OPTS);
      return runAssertionAudit(claim(50, [TOKENL]), truthFromCalldata(ct), CFG);
    },
  },
  {
    name: "ABI-absent decode -> all unknown -> WAIT",
    expected: "WAIT",
    run: () => {
      const ct = decodeCalldataTruth(txTransfer, { provenance: "absent" }, OPTS);
      return runAssertionAudit(claim(50, [TOKENL]), truthFromCalldata(ct), CFG);
    },
  },
];

function main(): void {
  console.log("DJZS-A CALLDATA-BENCH · Step 2 · pure decode, provenance-gated · zero network\n");
  let failures = 0;

  console.log("== Part A: unit decode cases ==");
  for (const c of UNIT_CASES) {
    const got = decodeCalldataTruth(c.tx, c.abi, OPTS);
    const got2 = decodeCalldataTruth(c.tx, c.abi, OPTS); // determinism
    const ok = eq(got, c.expected);
    const det = eq(got, got2);
    if (!ok || !det) failures++;
    const ab =
      got.approval_bound.state === "present" ? got.approval_bound.value.bound : got.approval_bound.state;
    console.log(`[${ok && det ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(`        amount=${fmt(got.tx_amount)} recipient=${fmt(got.tx_recipient)} approval=${ab} det=${det}`);
    if (!ok) console.log(`        MISMATCH vs expected`);
  }

  console.log("\n== Part B: integration through Step-1 comparators ==");
  for (const c of INTEGRATION) {
    const r1 = c.run();
    const r2 = c.run(); // determinism
    const ok = r1.verdict === c.expected;
    const det = r1.verdict_hash === r2.verdict_hash;
    if (!ok || !det) failures++;
    const codes = r1.flags.map((f) => f.code).join("+") || "-";
    console.log(`[${ok && det ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(
      `        got ${r1.verdict} (exp ${c.expected}) risk=${r1.risk_score} flags=[${codes}] ` +
        `unknown=[${r1.unknown_fields.join(",") || "-"}] det=${det}`,
    );
    console.log(`        verdict_hash ${r1.verdict_hash}`);
  }

  console.log(`\n== RESULT ==  ${failures === 0 ? "ALL GREEN" : `${failures} CASE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

function fmt(f: FieldState<unknown>): string {
  if (f.state === "present") return typeof f.value === "bigint" ? `${f.value}n` : JSON.stringify(f.value);
  return f.state;
}

main();
