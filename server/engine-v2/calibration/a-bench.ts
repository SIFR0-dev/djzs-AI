/**
 * DJZS-A A-BENCH — Step 1 calibration gate (DRAFT-UNVERIFIED).
 * ────────────────────────────────────────────────────────────
 * Zero network. Tests the COMPARATORS + LADDER + verdict_hash machinery against
 * SYNTHETIC claim/truth pairs whose expected verdicts are derived from
 * shared/a-taxonomy.draft.ts. These are machinery fixtures, NOT the real
 * incident-record bench — that is a separate, later merge (and stays out of this
 * one). Also reconciles the draft taxonomy hash against the author-supplied
 * value, printing candidate canonicalizations on mismatch WITHOUT touching the table.
 *
 * Run:  djzs-trust-mcp/node_modules/.bin/tsx server/engine-v2/calibration/a-bench.ts
 * Exit: 0 all synthetic verdicts + determinism green; 1 a verdict/determinism failed.
 *       (The taxonomy-hash reconciliation is reported but does NOT gate exit —
 *        the machinery is correct regardless of which canonical form is locked.)
 */
import { canonicalize, sha256Hex } from "../hash";
import {
  runAssertionAudit,
  type ClaimRecord,
  type TruthRecord,
  type AConfig,
  type AVerdict,
  type FieldState,
  type SourceRef,
} from "../assertion-engine";
import {
  A_TAXONOMY,
  ALL_A_CODES,
  A_DRAFT_VERSION,
  A_SCHEMA_VERSION,
  A_TAXONOMY_HASH,
  A_TAXONOMY_CANON_PREIMAGE,
  A_TAXONOMY_CANON_PREIMAGE_EXPECTED,
  A_TAXONOMY_HASH_EXPECTED_DRAFT,
} from "../../../shared/a-taxonomy.draft";

const SRC: SourceRef = { adapter: "synthetic", fetched_at: "1970-01-01T00:00:00.000Z", ref: "bench" };
const P = <T>(value: T): FieldState<T> => ({ state: "present", value, source: SRC });
const ABSENT = { state: "absent" } as const;
const UNK = (reason: "unfetchable" | "timeout" | "conflict" | "unsupported_env"): FieldState<never> =>
  ({ state: "unknown", reason });

const CFG: AConfig = { amount_tolerance: 0, price_slippage_bps: 50 };

// Baseline: every comparator CLEARs -> clean PASS. Fixtures mutate one axis.
function baseClaim(): ClaimRecord {
  return {
    amount: P(100),
    scope: P(["USDC"]),
    env: P({ chainId: 8453, class: "evm-l2" }),
    authority: P("user"),
    assumed_state: P({ price: 100, nonce: 5 }),
  };
}
function baseTruth(): TruthRecord {
  return {
    amount: P(100),
    approval: P("bounded"),
    touched: P(["USDC"]),
    env: P({ chainId: 8453, class: "evm-l2" }),
    binding: P("binding"),
    provenance: P("principal"),
    fresh_state: P({ price: 100, nonce: 5 }),
  };
}

interface Fixture {
  name: string;
  expected: AVerdict;
  claim: ClaimRecord;
  truth: TruthRecord;
}

function mut<R>(base: R, patch: Partial<R>): R {
  return { ...base, ...patch };
}

const FIXTURES: Fixture[] = [
  { name: "clean PASS (all clear)", expected: "PASS", claim: baseClaim(), truth: baseTruth() },
  {
    name: "A01 solo — unbounded approval (critical) -> FAIL",
    expected: "FAIL",
    claim: baseClaim(),
    truth: mut(baseTruth(), { approval: P("unbounded") }),
  },
  {
    name: "A02 solo — scope violation (adv 15) -> PASS",
    expected: "PASS",
    claim: baseClaim(),
    truth: mut(baseTruth(), { touched: P(["USDC", "WETH"]) }),
  },
  {
    name: "A03 solo — env mismatch (adv 10) -> PASS",
    expected: "PASS",
    claim: baseClaim(),
    truth: mut(baseTruth(), { env: P({ chainId: 1, class: "evm-mainnet" }) }),
  },
  {
    name: "A04 solo — no_binding (critical) -> FAIL",
    expected: "FAIL",
    claim: baseClaim(),
    truth: mut(baseTruth(), { binding: P("no_binding") }),
  },
  {
    name: "A05 solo — external authority (adv 15) -> PASS",
    expected: "PASS",
    claim: baseClaim(),
    truth: mut(baseTruth(), { provenance: P("external") }),
  },
  {
    name: "A06 solo — stale price (adv 10) -> PASS",
    expected: "PASS",
    claim: baseClaim(),
    truth: mut(baseTruth(), { fresh_state: P({ price: 150, nonce: 5 }) }),
  },
  {
    name: "WAIT — provenance unknown (no flags) -> WAIT",
    expected: "WAIT",
    claim: baseClaim(),
    truth: mut(baseTruth(), { provenance: UNK("unsupported_env") }),
  },
  {
    name: "threshold FAIL — A02+A05 = 30 >= 25 (no critical) -> FAIL",
    expected: "FAIL",
    claim: baseClaim(),
    truth: mut(baseTruth(), { touched: P(["USDC", "WETH"]), provenance: P("external") }),
  },
];

function reconcileTaxonomyHash(): void {
  console.log("\n== TAXONOMY HASH RECONCILIATION (governance envelope) ==");
  console.log(`  version           : ${A_SCHEMA_VERSION} (draft ${A_DRAFT_VERSION})`);
  console.log(`  preimage          : ${A_TAXONOMY_CANON_PREIMAGE}`);
  const preimageMatch = A_TAXONOMY_CANON_PREIMAGE === A_TAXONOMY_CANON_PREIMAGE_EXPECTED;
  console.log(`  preimage verbatim : ${preimageMatch ? "YES" : "NO"} (derived form == author's envelope string)`);
  console.log(`  my hash           : ${A_TAXONOMY_HASH}`);
  console.log(`  expected draft    : ${A_TAXONOMY_HASH_EXPECTED_DRAFT}`);
  const match = A_TAXONOMY_HASH === A_TAXONOMY_HASH_EXPECTED_DRAFT;
  console.log(`  HASH MATCH        : ${match ? "YES" : "NO"}`);
  if (match && preimageMatch) return;

  // Table unchanged. Try standard canonicalizations of the SAME table to locate
  // the author's canonical form. NOT adjusting weights/names — only the encoding.
  const rows = ALL_A_CODES.map((c) => A_TAXONOMY[c]);
  const keyed = A_TAXONOMY;
  const keyedNoCode = Object.fromEntries(
    ALL_A_CODES.map((c) => [c, { name: A_TAXONOMY[c].name, weight: A_TAXONOMY[c].weight, critical: A_TAXONOMY[c].critical }]),
  );
  const weightsOnly = Object.fromEntries(ALL_A_CODES.map((c) => [c, A_TAXONOMY[c].weight]));
  const yesNo = Object.fromEntries(
    ALL_A_CODES.map((c) => [c, { code: c, name: A_TAXONOMY[c].name, weight: A_TAXONOMY[c].weight, critical: A_TAXONOMY[c].critical ? "yes" : "no" }]),
  );
  const candidates: Array<[string, unknown]> = [
    ["keyed-by-code {code,name,weight,critical} (my primary)", keyed],
    ["keyed-by-code {name,weight,critical} (no code dup)", keyedNoCode],
    ["array of rows [{code,name,weight,critical}]", rows],
    ["version-wrapped {taxonomy_version, taxonomy:keyed}", { taxonomy_version: A_DRAFT_VERSION, taxonomy: keyed }],
    ["schema-wrapped {schema_version, taxonomy:keyed}", { schema_version: A_SCHEMA_VERSION, taxonomy: keyed }],
    ["weights-only {code:weight}", weightsOnly],
    ["keyed, critical as yes/no strings", yesNo],
    ["array of rows, JSON.stringify (unsorted, no canonicalize)", rows],
  ];
  console.log("\n  candidate canonicalizations of the SAME table (locate the author's form):");
  for (const [label, obj] of candidates) {
    const pre = label.includes("unsorted") ? JSON.stringify(obj) : canonicalize(obj);
    const h = sha256Hex(pre);
    const hit = h === A_TAXONOMY_HASH_EXPECTED_DRAFT ? "  <<< MATCHES EXPECTED" : "";
    console.log(`   - ${label}: ${h}${hit}`);
  }
  console.log("  -> hash left UNFROZEN pending your confirmation of the canonical form; table untouched.");
}

function main(): void {
  console.log("DJZS-A A-BENCH · Step 1 · DRAFT-UNVERIFIED · synthetic fixtures");
  console.log(`fixtures: ${FIXTURES.length} | codes: ${ALL_A_CODES.join(",")} | fail_threshold: 25\n`);

  let failures = 0;
  for (const f of FIXTURES) {
    const r1 = runAssertionAudit(f.claim, f.truth, CFG);
    const r2 = runAssertionAudit(f.claim, f.truth, CFG); // determinism
    const verdictOk = r1.verdict === f.expected;
    const deterministic = r1.verdict_hash === r2.verdict_hash;
    const ok = verdictOk && deterministic;
    if (!ok) failures++;
    const codes = r1.flags.map((x) => x.code).join("+") || "-";
    console.log(
      `[${ok ? "PASS" : "FAIL"}] ${f.name}\n` +
        `        got ${r1.verdict} (exp ${f.expected}) risk=${r1.risk_score} flags=[${codes}] ` +
        `unknown=[${r1.unknown_fields.join(",") || "-"}] det=${deterministic}\n` +
        `        verdict_hash ${r1.verdict_hash}`,
    );
  }

  reconcileTaxonomyHash();

  console.log(`\n== RESULT ==  ${failures === 0 ? "ALL SYNTHETIC FIXTURES GREEN" : `${failures} FIXTURE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
