// ds-trading-worker — deterministic-signal.trading v1, Kalshi lane.
// Increment 1 surface: health + read-only market routes. The verdict path
// and the order gate land only after ds_trading_schema_v0_1.sql is
// hash-verified and applied to the LEDGER binding (fork B).
import { Hono } from "hono";
import {
  KalshiPublicClient,
  KalshiApiError,
  KALSHI_DEMO_HOST,
} from "../../adapter/kalshi-rest.ts";
import { formatPriceE4, formatQtyE2 } from "../../adapter/fixed.ts";

// Minimal local D1 surface — keeps the checkpoint free of a types dep.
export interface D1Like {
  prepare(sql: string): {
    first<T = unknown>(): Promise<T | null>;
  };
}

export interface Env {
  LEDGER: D1Like;
  KALSHI_HOST?: string;
}

export interface AppDeps {
  /** Injectable for offline tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export const WORKER_NAME = "ds-trading-worker";
export const WORKER_VERSION = "0.1.0";

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  const client = (env: Env) =>
    new KalshiPublicClient(
      env.KALSHI_HOST ?? KALSHI_DEMO_HOST,
      deps.fetchImpl ?? fetch,
    );

  app.get("/", (c) => c.json({ name: WORKER_NAME, version: WORKER_VERSION }));

  app.get("/health", async (c) => {
    let ledger = "unreachable";
    try {
      const row = await c.env.LEDGER.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      ledger = row?.ok === 1 ? "connected" : "unexpected";
    } catch {
      // fall through as unreachable — health must answer, never throw
    }
    const healthy = ledger === "connected";
    return c.json(
      {
        status: healthy ? "healthy" : "degraded",
        ledger,
        worker: WORKER_VERSION,
        timestamp: new Date().toISOString(),
      },
      healthy ? 200 : 503,
    );
  });

  // Read-only market routes. No auth, no keys, no orders on any of these.
  app.get("/v1/markets", async (c) => {
    const q = c.req.query();
    const page = await client(c.env).getMarkets({
      limit: q.limit ? Number(q.limit) : 20,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.series_ticker ? { series_ticker: q.series_ticker } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    return c.json(page);
  });

  app.get("/v1/markets/:ticker/orderbook", async (c) => {
    const depth = c.req.query("depth");
    const ob = await client(c.env).getOrderbook(
      c.req.param("ticker"),
      depth ? Number(depth) : undefined,
    );
    // Serve exact decimal strings outward; e4/e2 ints stay internal.
    const out = (side: typeof ob.yes) =>
      side.map((l) => ({ price: formatPriceE4(l.priceE4), qty: formatQtyE2(l.qtyE2) }));
    return c.json({ yes: out(ob.yes), no: out(ob.no) });
  });

  app.get("/v1/trades", async (c) => {
    const q = c.req.query();
    const page = await client(c.env).getTrades({
      ...(q.ticker ? { ticker: q.ticker } : {}),
      limit: q.limit ? Number(q.limit) : 20,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    return c.json(page);
  });

  app.onError((err, c) => {
    if (err instanceof KalshiApiError) {
      // Upstream trouble is 502 here, never mistaken for our own 4xx/5xx.
      return c.json({ error: "upstream", status: err.status, path: err.path }, 502);
    }
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
};
