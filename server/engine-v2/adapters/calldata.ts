/**
 * DJZS-A adapter · calldata — decode what a transaction actually does (Step 2).
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE, ZERO I/O. The caller supplies the ABI WITH its provenance; this adapter
 * never fetches an ABI, never guesses a selector, never reaches the network.
 * Doctrine (adapter never guesses):
 *   - ABI absent OR unverified  -> every field unknown("unfetchable").
 *   - unknown selector / malformed / truncated data -> unknown, never a throw
 *     that escapes the adapter.
 *   - only a VERIFIED ABI is decoded; a decode is a fact (max-uint256 == unbounded
 *     approval is a decode fact, not an opinion).
 *   - fetched_at is an INJECTED clock (opts.fetchedAt), never Date.now(), so the
 *     SourceRef is deterministic and the bench reproduces byte-for-byte.
 *
 * Serves A01 (amount / approval bound), A02 (touched set), A04 (recipient).
 * Reuses Step 1's FieldState<T> / SourceRef / UnknownReason exactly.
 *
 * NOTE (flagged design item, NOT defaulted): tx_amount is a uint256 `bigint` — the
 * honest decode type. Step 1's ClaimRecord/TruthRecord `amount` is `number`, so a
 * faithful A01 amount-DIFF over real calldata needs a bigint bridge (widen the
 * engine field to bigint, or a documented scaled representation). That is a
 * separate ruling; this step does not touch Step 1. The integration fixtures here
 * exercise the paths that do NOT need the bridge (unbounded-approval fire; unknowns).
 */
import { decodeFunctionData, maxUint256, type Abi } from "viem";
import type { FieldState, SourceRef, UnknownReason } from "../assertion-engine";

export interface TxInput {
  to: string;
  /** 0x-prefixed calldata. "0x" or "" => native transfer (amount from `value`). */
  data: string;
  /** native value, wei. */
  value: bigint;
  chainId: number;
}

export type AbiInput =
  | { provenance: "verified"; abi: Abi }
  | { provenance: "unverified"; abi: Abi }
  | { provenance: "absent" };

export type ApprovalBound = { bound: "finite"; amount: bigint } | { bound: "unbounded" };

export interface CalldataTruth {
  tx_amount: FieldState<bigint>; // A01
  tx_recipient: FieldState<string>; // A04
  touched_set: FieldState<string[]>; // A02
  approval_bound: FieldState<ApprovalBound>; // A01
}

export interface DecodeOpts {
  /** Injected clock, ISO. NEVER Date.now() — determinism is load-bearing. */
  fetchedAt: string;
}

const norm = (a: string): string => a.toLowerCase();

function selectorOf(data: string): string {
  return data && data.startsWith("0x") && data.length >= 10 ? data.slice(0, 10) : "0x";
}

function srcFor(tx: TxInput, opts: DecodeOpts): SourceRef {
  return { adapter: "calldata", fetched_at: opts.fetchedAt, ref: `${selectorOf(tx.data)}@${norm(tx.to)}` };
}

function present<T>(value: T, source: SourceRef): FieldState<T> {
  return { state: "present", value, source };
}
const ABSENT = { state: "absent" } as const;
function unknown(reason: UnknownReason): FieldState<never> {
  return { state: "unknown", reason };
}

/** Every field unknown for the same reason — the no-best-effort default. */
function allUnknown(reason: UnknownReason): CalldataTruth {
  return {
    tx_amount: unknown(reason),
    tx_recipient: unknown(reason),
    touched_set: unknown(reason),
    approval_bound: unknown(reason),
  };
}

export function decodeCalldataTruth(tx: TxInput, abi: AbiInput, opts: DecodeOpts): CalldataTruth {
  const src = srcFor(tx, opts);

  // Native transfer: empty calldata -> amount is the native value; no ABI needed.
  if (!tx.data || tx.data === "0x" || tx.data === "") {
    return {
      tx_amount: present(tx.value, src),
      tx_recipient: present(norm(tx.to), src),
      touched_set: present([norm(tx.to)], src),
      approval_bound: ABSENT, // a native transfer grants no approval
    };
  }

  // Provenance gate: only a VERIFIED ABI is decoded. Absent/unverified -> unknown.
  if (abi.provenance !== "verified") {
    return allUnknown("unfetchable");
  }

  let functionName: string;
  let args: readonly unknown[];
  try {
    const d = decodeFunctionData({ abi: abi.abi, data: tx.data as `0x${string}` });
    functionName = d.functionName as string;
    args = (d.args ?? []) as readonly unknown[];
  } catch {
    // Unknown selector / malformed / truncated -> unknown. Never throws out.
    return allUnknown("unfetchable");
  }

  const touched = present<string[]>([norm(tx.to)], src);

  switch (functionName) {
    case "transfer": {
      // transfer(to, amount)
      const to = args[0];
      const amount = args[1];
      if (typeof to !== "string" || typeof amount !== "bigint") return allUnknown("unfetchable");
      return {
        tx_amount: present(amount, src),
        tx_recipient: present(norm(to), src),
        touched_set: touched,
        approval_bound: ABSENT,
      };
    }
    case "transferFrom": {
      // transferFrom(from, to, amount)
      const to = args[1];
      const amount = args[2];
      if (typeof to !== "string" || typeof amount !== "bigint") return allUnknown("unfetchable");
      return {
        tx_amount: present(amount, src),
        tx_recipient: present(norm(to), src),
        touched_set: touched,
        approval_bound: ABSENT,
      };
    }
    case "approve": {
      // approve(spender, amount) — max-uint256 allowance is an unbounded approval.
      const spender = args[0];
      const amount = args[1];
      if (typeof spender !== "string" || typeof amount !== "bigint") return allUnknown("unfetchable");
      const bound: ApprovalBound = amount === maxUint256 ? { bound: "unbounded" } : { bound: "finite", amount };
      return {
        tx_amount: present(amount, src),
        tx_recipient: present(norm(spender), src),
        touched_set: touched,
        approval_bound: present(bound, src),
      };
    }
    default:
      // A verified ABI method whose value/recipient semantics this adapter does
      // not map — unknown, not a guess.
      return allUnknown("unfetchable");
  }
}
