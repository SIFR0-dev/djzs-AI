// Offline worker-route battery — no network, no key, no wrangler.
//   node --experimental-strip-types --test test/worker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, type Env, type D1Like } from "../src/index.ts";

const okLedger: D1Like = {
  prepare: () => ({ first: async <T,>() => ({ ok: 1 }) as T }),
};
const deadLedger: D1Like = {
  prepare: () => ({ first: async () => { throw new Error("no such table"); } }),
};

function kalshiStub(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("/orderbook")
      ? { orderbook_fp: { yes_dollars: [["0.6100", "400.00"]], no_dollars: [] } }
      : u.includes("/trades")
        ? { trades: [{ trade_id: "t1", ticker: "KXT", count_fp: "1.99", yes_price_dollars: "0.5800", no_price_dollars: "0.4200", taker_side: "yes", created_time: "2026-08-21T00:00:00Z" }], cursor: "" }
        : { markets: [{ ticker: "KXT", yes_bid_dollars: "0.6100" }], cursor: "" };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const env = (ledger: D1Like): Env => ({ LEDGER: ledger });

test("root serves name/version", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/", {}, env(okLedger));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: "ds-trading-worker", version: "0.1.0" });
});

test("/health is healthy when the ledger answers", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/health", {}, env(okLedger));
  assert.equal(res.status, 200);
  const j = (await res.json()) as { status: string; ledger: string };
  assert.equal(j.status, "healthy");
  assert.equal(j.ledger, "connected");
});

test("/health degrades (503) but never throws when the ledger is dead", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/health", {}, env(deadLedger));
  assert.equal(res.status, 503);
  const j = (await res.json()) as { status: string; ledger: string };
  assert.equal(j.status, "degraded");
  assert.equal(j.ledger, "unreachable");
});

test("/v1/markets proxies read-only", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/v1/markets?limit=5", {}, env(okLedger));
  assert.equal(res.status, 200);
  const j = (await res.json()) as { markets: Array<{ ticker: string }> };
  assert.equal(j.markets[0]!.ticker, "KXT");
});

test("/v1/markets/:ticker/orderbook serves exact decimal strings", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/v1/markets/KXT/orderbook?depth=3", {}, env(okLedger));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    yes: [{ price: "0.6100", qty: "400.00" }],
    no: [],
  });
});

test("/v1/trades proxies read-only", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  const res = await app.request("/v1/trades?limit=1", {}, env(okLedger));
  assert.equal(res.status, 200);
  const j = (await res.json()) as { trades: Array<{ taker_side: string }> };
  assert.equal(j.trades[0]!.taker_side, "yes");
});

test("upstream failure surfaces as 502, not our error", async () => {
  const failing = (async () => new Response("kalshi down", { status: 503 })) as unknown as typeof fetch;
  const app = createApp({ fetchImpl: failing });
  const res = await app.request("/v1/markets", {}, env(okLedger));
  assert.equal(res.status, 502);
  const j = (await res.json()) as { error: string; status: number };
  assert.equal(j.error, "upstream");
  assert.equal(j.status, 503);
});

test("no order route exists on this surface", async () => {
  const app = createApp({ fetchImpl: kalshiStub() });
  for (const path of ["/v1/orders", "/v1/order"]) {
    const res = await app.request(path, { method: "POST" }, env(okLedger));
    assert.equal(res.status, 404, `${path} must not exist in increment 1`);
  }
});
