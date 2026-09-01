import { hashTypedData, keccak256, encodePacked, type Hex } from "viem";

export const ACTIONS = ["pm_trade","swap","defi","transfer","contract_call","deploy"] as const;
export type Action = typeof ACTIONS[number];
export const DJZS_DOMAIN = { name: "DJZS", version: "2", chainId: 8453 } as const;
export const DJZS_TYPES = {
  DJZSIntent: [
    { name: "action",             type: "string"  },
    { name: "venue",              type: "string"  },
    { name: "market",             type: "string"  },
    { name: "side",               type: "string"  },
    { name: "thesis",             type: "string"  },
    { name: "probability_basis",  type: "string"  },
    { name: "size_usd_cents",     type: "uint256" },
    { name: "max_loss_usd_cents", type: "uint256" },
    { name: "exit_condition",     type: "string"  },
    { name: "params_hash",        type: "bytes32" },
  ],
} as const;
export type DJZSIntent = {
  action: Action; venue: string; market: string; side: string;
  thesis: string; probability_basis: string;
  size_usd_cents: bigint; max_loss_usd_cents: bigint;
  exit_condition: string; params_hash: Hex;
};
export const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

export function intentHash(intent: DJZSIntent): Hex {
  if (!ACTIONS.includes(intent.action)) throw new Error(`unknown action: ${intent.action}`);
  return hashTypedData({ domain: DJZS_DOMAIN, types: DJZS_TYPES, primaryType: "DJZSIntent", message: intent });
}

export const EAS_SCHEMA = "bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion";
export const EAS_RESOLVER = "0x0000000000000000000000000000000000000000" as const;
export const EAS_REVOCABLE = false;
export function schemaUID(): Hex {
  return keccak256(encodePacked(["string","address","bool"], [EAS_SCHEMA, EAS_RESOLVER, EAS_REVOCABLE]));
}

export function selfTest(): boolean {
  const a: DJZSIntent = {
    action: "pm_trade", venue: "Kalshi", market: "KXBTCD-26SEP0117-T77999.99", side: "YES",
    thesis: "spot above strike; resolves YES absent a close below the line",
    probability_basis: "spot vs strike, Coinbase+Kraken 2026-08-31T23:17Z",
    size_usd_cents: 25000n, max_loss_usd_cents: 25000n,
    exit_condition: "hourly close below 78000", params_hash: ZERO32,
  };
  const b = { params_hash: a.params_hash, exit_condition: a.exit_condition, max_loss_usd_cents: a.max_loss_usd_cents,
    size_usd_cents: a.size_usd_cents, probability_basis: a.probability_basis, thesis: a.thesis, side: a.side,
    market: a.market, venue: a.venue, action: a.action } as DJZSIntent;
  const c: DJZSIntent = { ...a, thesis: a.thesis + "." };
  const ha = intentHash(a), hb = intentHash(b), hc = intentHash(c);
  const ok = ha === hb && ha !== hc;
  console.log("intentHash(a)          =", ha);
  console.log("intentHash(b, reorder) =", hb, ha === hb ? " OK  structural" : " FAIL");
  console.log("intentHash(c, +1 char) =", hc, ha !== hc ? " OK  sensitive" : " FAIL");
  console.log("EAS schema UID (pre-reg)=", schemaUID());
  console.log(ok ? "\nPASS" : "\nFAIL");
  return ok;
}
if (process.argv[1]?.endsWith("djzs-intent.ts")) selfTest();

/**
 * PM intent -> v2 struct. Defaults are DOCUMENTED, never inferred: a third party
 * recomputing intent_hash must not have to guess. venue "" unless supplied;
 * missing numbers 0; params_hash ZERO32.
 */
export function toDJZSIntent(pm: {
  market: string; side: string; thesis: string; probability_basis?: string; size_usd?: number;
  bounds?: { max_loss_usd?: number; exit_condition?: string }; venue?: string;
}): DJZSIntent {
  const cents = (x?: number) => BigInt(Math.round((typeof x === "number" && isFinite(x) ? x : 0) * 100));
  return {
    action: "pm_trade", venue: pm.venue ?? "", market: pm.market, side: pm.side, thesis: pm.thesis,
    probability_basis: pm.probability_basis ?? "", size_usd_cents: cents(pm.size_usd),
    max_loss_usd_cents: cents(pm.bounds?.max_loss_usd), exit_condition: pm.bounds?.exit_condition ?? "",
    params_hash: ZERO32,
  };
}
