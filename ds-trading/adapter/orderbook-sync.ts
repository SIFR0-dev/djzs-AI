// Orderbook sequence-sync state machine — pure logic, no I/O.
// Invariant (brief step 3): on any seq gap, HALT; the book is untrusted until
// a fresh snapshot arrives. The transport layer owns reconnecting; this
// machine refuses deltas while halted no matter what the transport does.

export type Side = "yes" | "no";

// Units are normalized BEFORE this machine: priceE4 = $0.0001 steps,
// qtyE2 = 0.01-contract steps. Wire parsing lives in the transport layer.
export interface SnapshotMsg {
  market_ticker: string;
  yes?: Array<[number, number]>; // [priceE4, qtyE2]
  no?: Array<[number, number]>;
}

export interface DeltaMsg {
  market_ticker: string;
  priceE4: number;
  deltaQtyE2: number;
  side: Side;
}

export type SyncState = "AWAITING_SNAPSHOT" | "SYNCED" | "HALTED";

export type ApplyResult =
  | { ok: true; state: SyncState }
  | { ok: false; state: SyncState; reason: "seq_gap" | "not_synced"; expectedSeq?: number; gotSeq?: number };

/**
 * One machine per subscription (per sid). Kalshi numbers messages with a
 * per-sid `seq`; a delta is applicable iff seq === lastSeq + 1.
 */
export class OrderbookSync {
  private state: SyncState = "AWAITING_SNAPSHOT";
  private lastSeq = 0;
  private book = new Map<string, { yes: Map<number, number>; no: Map<number, number> }>();

  get status(): SyncState {
    return this.state;
  }

  /** A snapshot always re-syncs, from any state. */
  applySnapshot(seq: number, msg: SnapshotMsg): ApplyResult {
    const yes = new Map(msg.yes ?? []);
    const no = new Map(msg.no ?? []);
    this.book.set(msg.market_ticker, { yes, no });
    this.lastSeq = seq;
    this.state = "SYNCED";
    return { ok: true, state: this.state };
  }

  applyDelta(seq: number, msg: DeltaMsg): ApplyResult {
    if (this.state !== "SYNCED") {
      return { ok: false, state: this.state, reason: "not_synced" };
    }
    if (seq !== this.lastSeq + 1) {
      this.state = "HALTED";
      return {
        ok: false,
        state: this.state,
        reason: "seq_gap",
        expectedSeq: this.lastSeq + 1,
        gotSeq: seq,
      };
    }
    this.lastSeq = seq;
    const entry = this.book.get(msg.market_ticker) ?? {
      yes: new Map<number, number>(),
      no: new Map<number, number>(),
    };
    this.book.set(msg.market_ticker, entry);
    const ladder = entry[msg.side];
    const next = (ladder.get(msg.priceE4) ?? 0) + msg.deltaQtyE2;
    if (next <= 0) {
      ladder.delete(msg.priceE4);
    } else {
      ladder.set(msg.priceE4, next);
    }
    return { ok: true, state: this.state };
  }

  /** Sorted [priceE4, qtyE2], best (highest resting bid) first. Empty when unknown. */
  levels(ticker: string, side: Side): Array<[number, number]> {
    const entry = this.book.get(ticker);
    if (!entry || this.state !== "SYNCED") return [];
    return [...entry[side].entries()].sort((a, b) => b[0] - a[0]);
  }
}
