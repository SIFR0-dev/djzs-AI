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
/**
 * A perp/spot intent as /x402/verify_perp_trade receives it (discovery block field names).
 * `instrument` is the documented key. `market` is read only as a fallback for the market field,
 * when `instrument` is not a string.
 */
export type PerpIntentLike = {
  instrument?: string; market?: string; side: string; thesis: string; leverage?: number; entry?: number; stop_loss?: number;
  take_profit?: number; invalidation?: string; size_usd?: number; venue?: string; data_sources?: string;
};

/**
 * The paid route that received an intent. THE ROUTE DECIDES THE RECEIPT'S ACTION CLASS, never the
 * body's fields (ruled 2026-10-21): /x402/verify_perp_trade always attests "perp_trade" and
 * /x402/verify_pm_trade always attests "pm_trade". Until then the body's shape chose (`instrument`
 * present and `market` absent => perp), so a caller picked the class of a PERMANENT attestation by
 * choosing which keys to send, and a body carrying `market` sent to the perp route was attested
 * as a prediction-market trade under the perp ruleset.
 */
export type IntentRoute = "pm" | "perp";

/** The three fields every route binds as plain text and cannot bind without. */
export const REQUIRED_TEXT_FIELDS = ["market", "side", "thesis"] as const;
export type RequiredTextField = typeof REQUIRED_TEXT_FIELDS[number];

/**
 * An intent that cannot be bound because a required field is missing (undefined or null) or empty
 * (""). A NAMED error, so the refusal does not depend on viem happening to throw on `undefined`
 * (it does not throw on ""), and so the cause in the Worker log says which field. The message is a
 * fixed vocabulary, field name plus reason, and never carries any of the body: the route logs it,
 * and the caller sees only the unchanged 400 intent_unbindable.
 *
 * Deliberately NOT checked: that the value is a string. A number or object in one of these fields
 * still binds today (a colliding hash; the 2026-10-20 "mistyped values bind" finding is a separate
 * ruling), and a whitespace-only string is not empty.
 */
export class IntentUnbindableError extends Error {
  readonly field: RequiredTextField;
  readonly problem: "missing" | "empty";
  constructor(field: RequiredTextField, problem: "missing" | "empty") {
    super(`intent_unbindable: ${field} is ${problem}`);
    this.name = "IntentUnbindableError";
    this.field = field;
    this.problem = problem;
  }
}

function requireText<T>(value: T, field: RequiredTextField): T {
  if (value === undefined || value === null) throw new IntentUnbindableError(field, "missing");
  if ((value as unknown) === "") throw new IntentUnbindableError(field, "empty");
  return value;
}

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

/**
 * Wire intent -> v2 struct. Defaults are DOCUMENTED, never inferred: a third party
 * recomputing intent_hash must not have to guess.
 *
 * PM (action "pm_trade"): venue "" unless supplied; missing numbers 0; params_hash ZERO32.
 * Unchanged since v2 shipped; every existing intent_hash still recomputes.
 *
 * The ROUTE chooses the branch (see IntentRoute); the body's fields never do.
 *
 * PERP (action "perp_trade", 2026-09-27): market = instrument, falling back to market when
 * instrument is not a string; probability_basis =
 * data_sources or ""; max_loss_usd_cents = 0 (a perp intent states levels, not a loss
 * bound, and deriving one from entry/stop/size would be inference); exit_condition =
 * invalidation, else "stop_loss <n>" when a stop is given, else ""; params_hash =
 * keccak256(utf8(perpParamsPreimage(intent))) so the levels are bound into the key.
 * Before this branch existed a perp intent threw here (market undefined) AFTER
 * settlement, so a paying perp caller was charged and answered 503.
 *
 * After the route's own market resolution, a missing or empty market, side or thesis throws
 * IntentUnbindableError (named, see above) on BOTH routes; the paid route reports it as 400
 * intent_unbindable, uncharged, before any money moves.
 *
 * `route` defaults to "pm" for exactly one reason: tests/q3/q3-log.ts hashes prediction-market
 * records and calls this with the intent alone. Every paid route passes its own.
 */
export function toDJZSIntent(intent: PmIntentLike | PerpIntentLike, route: IntentRoute = "pm"): DJZSIntent {
  // Fail loud: an unrecognised route must never fall through to a class by default.
  if (route !== "pm" && route !== "perp") throw new Error(`unknown route: ${String(route)}`);
  const cents = (x?: number) => BigInt(Math.round((typeof x === "number" && isFinite(x) ? x : 0) * 100));
  if (route === "perp") {
    const perp = intent as PerpIntentLike;
    const exit = typeof perp.invalidation === "string" && perp.invalidation !== ""
      ? perp.invalidation
      : typeof perp.stop_loss === "number" && isFinite(perp.stop_loss) ? `stop_loss ${String(perp.stop_loss)}` : "";
    return {
      action: "perp_trade", venue: perp.venue ?? "",
      market: requireText(typeof perp.instrument === "string" ? perp.instrument : perp.market, "market") as string,
      side: requireText(perp.side, "side"), thesis: requireText(perp.thesis, "thesis"),
      probability_basis: perp.data_sources ?? "", size_usd_cents: cents(perp.size_usd),
      max_loss_usd_cents: 0n, exit_condition: exit,
      params_hash: keccak256(new TextEncoder().encode(perpParamsPreimage(perp))),
    };
  }
  const pm = intent as PmIntentLike;
  return {
    action: "pm_trade", venue: pm.venue ?? "", market: requireText(pm.market, "market"),
    side: requireText(pm.side, "side"), thesis: requireText(pm.thesis, "thesis"),
    probability_basis: pm.probability_basis ?? "", size_usd_cents: cents(pm.size_usd),
    max_loss_usd_cents: cents(pm.bounds?.max_loss_usd), exit_condition: pm.bounds?.exit_condition ?? "",
    params_hash: ZERO32,
  };
}
