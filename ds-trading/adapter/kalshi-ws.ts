// Kalshi WS v2 orderbook_delta subscriber with gap-halt discipline.
// Transport policy (brief step 3): on seq gap -> drop the socket, reconnect,
// resubscribe; Kalshi answers a fresh orderbook_snapshot which re-syncs the
// machine. Socket construction is injected so the core is testable offline
// and portable across Workers/Node WebSocket implementations.

import { OrderbookSync, type DeltaMsg, type SnapshotMsg, type Side } from "./orderbook-sync.ts";
import { parsePriceE4, parseQtyE2 } from "./fixed.ts";

// Wire normalization — SHAPE PINNED from a live authed demo socket
// 2026-08-21 (ws-pin, 20 markets, 20 deltas, 0 seq gaps):
//   snapshot: msg.{yes_dollars_fp,no_dollars_fp} = [[price_dollars, qty_fp]…]
//             (EMPTY books omit the arrays entirely; market_id uuid present)
//   delta:    msg.{price_dollars, delta_fp, side, market_ticker, market_id, ts, ts_ms}
//   seq:      one global counter per sid across ALL subscribed markets.
// Anything off-shape THROWS — the feed halts and resyncs rather than guess.
export function normalizeSnapshot(msg: Record<string, unknown>): SnapshotMsg {
  const dollars = (v: unknown): Array<[number, number]> =>
    ((v ?? []) as Array<[string, string]>).map(([p, q]) => [parsePriceE4(p), parseQtyE2(q)]);
  return {
    market_ticker: String(msg.market_ticker ?? ""),
    yes: dollars(msg.yes_dollars_fp),
    no: dollars(msg.no_dollars_fp),
  };
}

export function normalizeDelta(msg: Record<string, unknown>): DeltaMsg {
  if (typeof msg.price_dollars !== "string" || typeof msg.delta_fp !== "string") {
    throw new Error("orderbook_delta off pinned shape (expected price_dollars/delta_fp strings)");
  }
  const side = msg.side;
  if (side !== "yes" && side !== "no") throw new Error(`orderbook_delta bad side: ${String(side)}`);
  return {
    market_ticker: String(msg.market_ticker ?? ""),
    priceE4: parsePriceE4(msg.price_dollars),
    deltaQtyE2: parseQtyE2(msg.delta_fp),
    side,
  };
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export type SocketFactory = () => Promise<WsLike> | WsLike;

export interface KalshiWsOptions {
  socketFactory: SocketFactory;
  tickers: string[];
  /** Called after each applied message; also on halt/resync transitions. */
  onEvent?: (ev:
    | { kind: "synced"; ticker?: string }
    | { kind: "delta_applied"; seq: number }
    | { kind: "gap_halt"; expectedSeq?: number; gotSeq?: number }
    | { kind: "reconnecting"; attempt: number }
    | { kind: "closed" }) => void;
  /** Backoff between reconnects, ms. */
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

interface Envelope {
  type: string;
  sid?: number;
  seq?: number;
  msg?: Record<string, unknown>;
}

export class KalshiOrderbookFeed {
  readonly sync = new OrderbookSync();
  private ws: WsLike | null = null;
  private cmdId = 0;
  private attempts = 0;
  private stopped = false;

  private readonly opts: KalshiWsOptions;

  constructor(opts: KalshiWsOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    const ws = await this.opts.socketFactory();
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      ws.send(
        JSON.stringify({
          id: ++this.cmdId,
          cmd: "subscribe",
          params: { channels: ["orderbook_delta"], market_tickers: this.opts.tickers },
        }),
      );
    };
    ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    ws.onclose = () => {
      this.opts.onEvent?.({ kind: "closed" });
      if (!this.stopped) void this.reconnect();
    };
    ws.onerror = () => {
      // close handler owns the reconnect; error alone is not a state change
    };
  }

  private async reconnect(): Promise<void> {
    const max = this.opts.maxReconnectAttempts ?? 10;
    if (this.attempts >= max) return;
    this.attempts += 1;
    this.opts.onEvent?.({ kind: "reconnecting", attempt: this.attempts });
    const delay = (this.opts.reconnectDelayMs ?? 1000) * this.attempts;
    await new Promise((r) => setTimeout(r, delay));
    if (!this.stopped) await this.connect();
  }

  private handleMessage(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return; // non-JSON frames are ignored, never trusted
    }
    try {
      if (env.type === "orderbook_snapshot" && env.seq !== undefined && env.msg) {
        const snap = normalizeSnapshot(env.msg);
        this.sync.applySnapshot(env.seq, snap);
        this.opts.onEvent?.({ kind: "synced", ticker: snap.market_ticker });
        return;
      }
      if (env.type === "orderbook_delta" && env.seq !== undefined && env.msg) {
        const res = this.sync.applyDelta(env.seq, normalizeDelta(env.msg));
        if (!res.ok && res.reason === "seq_gap") {
          this.opts.onEvent?.({ kind: "gap_halt", expectedSeq: res.expectedSeq, gotSeq: res.gotSeq });
          // Halt discipline: this exact socket is now untrusted.
          this.ws?.close(); // onclose triggers reconnect -> resubscribe -> fresh snapshot
          return;
        }
        if (res.ok) this.opts.onEvent?.({ kind: "delta_applied", seq: env.seq });
      }
    } catch {
      // Off-pinned-shape wire data is a desync, same class as a seq gap:
      // never guess a book from it — drop the socket and resync.
      this.opts.onEvent?.({ kind: "gap_halt" });
      this.ws?.close();
    }
  }
}
