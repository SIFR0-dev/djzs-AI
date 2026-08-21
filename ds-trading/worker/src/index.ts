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
import {
  decide,
  computeVerdictHash,
  type AuditInput,
  type FlagCode,
} from "./verdict-core.ts";

// Gate freshness window. "No order without a FRESH verdict row" (brief).
// 15 minutes is a conservative placeholder — OPERATOR RATIFICATION PENDING;
// reject-by-default means the placeholder can only ever refuse more.
export const VERDICT_TTL_MS = 15 * 60 * 1000;

// Minimal local D1 surface — keeps the checkpoint free of a types dep.
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
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

  // ---- VERDICT PATH ------------------------------------------------------
  // LLM detects (not in increment 1 — source='user' supplies flags),
  // verdict-core decides, the hash is computed never improvised.
  app.post("/verdicts", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return c.json({ error: "invalid_json" }, 400);
    const source = b.source === "signal_box" ? "signal_box" : b.source === "user" ? "user" : null;
    if (!source) return c.json({ error: "source must be 'user' or 'signal_box'" }, 400);
    if (typeof b.subject !== "string" || !b.subject.trim()) return c.json({ error: "subject required" }, 400);
    if (typeof b.thesis !== "string" || !b.thesis.trim()) return c.json({ error: "thesis required" }, 400);
    if (!Array.isArray(b.flags ?? [])) return c.json({ error: "flags must be an array" }, 400);
    if (!Array.isArray(b.unknowns ?? [])) return c.json({ error: "unknowns must be an array" }, 400);

    const input: AuditInput = {
      subject: b.subject,
      thesis: b.thesis,
      market_ticker: (b.market_ticker as string) ?? null,
      side: (b.side as "yes" | "no") ?? null,
      p_claim_e4: (b.p_claim_e4 as number) ?? null,
      market_price_e4: (b.market_price_e4 as number) ?? null,
      fee_est_e4: (b.fee_est_e4 as number) ?? null,
      flags: (b.flags as FlagCode[]) ?? [],
      unknowns: (b.unknowns as string[]) ?? [],
    };

    let d;
    try {
      d = decide(input.flags, input.unknowns);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
    const verdict_hash = await computeVerdictHash(input, d);
    const verdict_id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    await c.env.LEDGER.prepare(
      `INSERT INTO verdicts (verdict_id, created_at, source, signal_spec, subject, thesis,
         market_ticker, side, p_claim_e4, market_price_e4, fee_est_e4,
         taxonomy, flags, risk_score, verdict, verdict_hash)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
    )
      .bind(
        verdict_id, created_at, source, (b.signal_spec as string) ?? null,
        input.subject, input.thesis, input.market_ticker, input.side,
        input.p_claim_e4, input.market_price_e4, input.fee_est_e4,
        d.taxonomy, JSON.stringify(d.flags), d.risk_score, d.verdict, verdict_hash,
      )
      .run();

    return c.json(
      {
        verdict_id, created_at,
        verdict: d.verdict, action: d.action, risk_score: d.risk_score,
        flags: d.flags, unknowns: d.unknowns, advisory_only: d.advisory_only,
        taxonomy: d.taxonomy, verdict_hash,
      },
      201,
    );
  });

  // ---- THE GATE ----------------------------------------------------------
  // Structural: executions.verdict_id FK (proven live on the ledger).
  // App layer: every refusal below fires BEFORE any venue call could exist.
  // Increment 1 places NO orders: a fully-passed gate returns 501 and writes
  // nothing — the venue leg is a later, separately-ruled step.
  app.post("/v1/orders", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return c.json({ error: "invalid_json" }, 400);

    const verdict_id = b.verdict_id;
    if (typeof verdict_id !== "string" || !verdict_id) {
      return c.json({ error: "gate", reason: "verdict_id required — no order without a verdict" }, 400);
    }
    const v = await c.env.LEDGER.prepare(
      "SELECT verdict_id, created_at, market_ticker, side, verdict FROM verdicts WHERE verdict_id = ?1",
    )
      .bind(verdict_id)
      .first<{ verdict_id: string; created_at: string; market_ticker: string | null; side: string | null; verdict: string }>();
    if (!v) return c.json({ error: "gate", reason: "verdict not found", action: "HALT" }, 403);
    if (v.verdict !== "PASS") {
      return c.json({ error: "gate", reason: `verdict is ${v.verdict}`, action: "HALT" }, 403);
    }
    const age = Date.now() - Date.parse(v.created_at);
    if (!(age >= 0 && age <= VERDICT_TTL_MS)) {
      return c.json({ error: "gate", reason: "verdict stale — re-audit", action: "HALT" }, 403);
    }
    if (v.market_ticker && b.market_ticker !== v.market_ticker) {
      return c.json({ error: "gate", reason: "market_ticker differs from audited market", action: "HALT" }, 403);
    }
    if (v.side && b.side !== v.side) {
      return c.json({ error: "gate", reason: "side differs from audited side", action: "HALT" }, 403);
    }

    return c.json(
      { gate: "passed", venue: "not_implemented", note: "increment 1 places no orders" },
      501,
    );
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
