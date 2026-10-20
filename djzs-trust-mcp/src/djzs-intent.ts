import { hashTypedData, keccak256, encodePacked, type Hex } from "viem";

export const ACTIONS = ["pm_trade","perp_trade","swap","defi","transfer","contract_call","deploy"] as const;
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

/** A PM intent as the paid route receives it. */
export type PmIntentLike = {
  market: string; side: string; thesis: string; probability_basis?: string; size_usd?: number;
  bounds?: { max_loss_usd?: number; exit_condition?: string }; venue?: string;
};
/** A perp/spot intent as /x402/verify_perp_trade receives it (discovery block field names). */
export type PerpIntentLike = {
  instrument: string; side: string; thesis: string; leverage?: number; entry?: number; stop_loss?: number;
  take_profit?: number; invalidation?: string; size_usd?: number; venue?: string; data_sources?: string;
};

/** Level fields bound into params_hash for a perp intent, in this order, always all four. */
export const PERP_PARAM_FIELDS = ["leverage", "entry", "stop_loss", "take_profit"] as const;

/**
 * Canonical rendering of a perp intent's numeric levels, hashed into params_hash.
 * "leverage=5|entry=78900|stop_loss=76200|take_profit=83000"; an absent or non-finite
 * level renders empty ("take_profit="). Numbers render as JavaScript String(n). Exposed
 * so a verifier can print the preimage next to the hash.
 */
export function perpParamsPreimage(perp: PerpIntentLike): string {
  return PERP_PARAM_FIELDS.map((k) => {
    const v = perp[k];
    return `${k}=${typeof v === "number" && isFinite(v) ? String(v) : ""}`;
  }).join("|");
}

/** True when the object is shaped like a perp intent: `instrument` present, `market` absent. */
export function isPerpIntent(x: unknown): x is PerpIntentLike {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.instrument === "string" && typeof o.market !== "string";
}

/**
 * Wire intent -> v2 struct. Defaults are DOCUMENTED, never inferred: a third party
 * recomputing intent_hash must not have to guess.
 *
 * PM (action "pm_trade"): venue "" unless supplied; missing numbers 0; params_hash ZERO32.
 * Unchanged since v2 shipped; every existing intent_hash still recomputes.
 *
 * PERP (action "perp_trade", 2026-09-27): market = instrument; probability_basis =
 * data_sources or ""; max_loss_usd_cents = 0 (a perp intent states levels, not a loss
 * bound, and deriving one from entry/stop/size would be inference); exit_condition =
 * invalidation, else "stop_loss <n>" when a stop is given, else ""; params_hash =
 * keccak256(utf8(perpParamsPreimage(intent))) so the levels are bound into the key.
 * Before this branch existed a perp intent threw here (market undefined) AFTER
 * settlement, so a paying perp caller was charged and answered 503.
 */
export function toDJZSIntent(intent: PmIntentLike | PerpIntentLike): DJZSIntent {
  const cents = (x?: number) => BigInt(Math.round((typeof x === "number" && isFinite(x) ? x : 0) * 100));
  if (isPerpIntent(intent)) {
    const perp = intent;
    const exit = typeof perp.invalidation === "string" && perp.invalidation !== ""
      ? perp.invalidation
      : typeof perp.stop_loss === "number" && isFinite(perp.stop_loss) ? `stop_loss ${String(perp.stop_loss)}` : "";
    return {
      action: "perp_trade", venue: perp.venue ?? "", market: perp.instrument, side: perp.side, thesis: perp.thesis,
      probability_basis: perp.data_sources ?? "", size_usd_cents: cents(perp.size_usd),
      max_loss_usd_cents: 0n, exit_condition: exit,
      params_hash: keccak256(new TextEncoder().encode(perpParamsPreimage(perp))),
    };
  }
  const pm = intent;
  return {
    action: "pm_trade", venue: pm.venue ?? "", market: pm.market, side: pm.side, thesis: pm.thesis,
    probability_basis: pm.probability_basis ?? "", size_usd_cents: cents(pm.size_usd),
    max_loss_usd_cents: cents(pm.bounds?.max_loss_usd), exit_condition: pm.bounds?.exit_condition ?? "",
    params_hash: ZERO32,
  };
}
