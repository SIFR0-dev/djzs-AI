// Kalshi WS v2 orderbook_delta subscriber with gap-halt discipline.
// Transport policy (brief step 3): on seq gap -> drop the socket, reconnect,
// resubscribe; Kalshi answers a fresh orderbook_snapshot which re-syncs the
// machine. Socket construction is injected so the core is testable offline
// and portable across Workers/Node WebSocket implementations.

import { OrderbookSync, type DeltaMsg, type SnapshotMsg, type Side } from "./orderbook-sync.ts";
import { parsePriceE4, parseQtyE2 } from "./fixed.ts";

// Wire normalization. REST is confirmed on the 2026 dollars/fp shape (live,
// both hosts); WS delta field names are UNVERIFIED until an authed socket
// runs — both shapes are accepted and the live run must pin which one.
// [WS-SHAPE-UNVERIFIED]
export function normalizeSnapshot(msg: Record<string, unknown>): SnapshotMsg {
  const dollars = (v: unknown): Array<[number, number]> =>
    ((v ?? []) as Array<[string, string]>).map(([p, q]) => [parsePriceE4(p), parseQtyE2(q)]);
  const cents = (v: unknown): Array<[number, number]> =>
    ((v ?? []) as Array<[number, number]>).map(([p, q]) => [p * 100, q * 100]);
  const hasDollars = "yes_dollars" in msg || "no_dollars" in msg;
  return {
    market_ticker: String(msg.market_ticker ?? ""),
    yes: hasDollars ? dollars(msg.yes_dollars) : cents(msg.yes),
    no: hasDollars ? dollars(msg.no_dollars) : cents(msg.no),
  };
}

export function normalizeDelta(msg: Record<string, unknown>): DeltaMsg {
  const side = msg.side as Side;
  if (typeof msg.price_dollars === "string") {
    return {
      market_ticker: String(msg.market_ticker ?? ""),
      priceE4: parsePriceE4(msg.price_dollars),
      deltaQtyE2: parseQtyE2(String(msg.delta_fp ?? msg.delta ?? "0")),
      side,
    };
  }
  return {
    market_ticker: String(msg.market_ticker ?? ""),
    priceE4: (msg.price as number) * 100,
    deltaQtyE2: (msg.delta as number) * 100,
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
  }
}
