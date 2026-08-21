// Offline test battery — no network, no key. Run:
//   node --experimental-strip-types --test adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { OrderbookSync } from "./orderbook-sync.ts";
import { KalshiOrderbookFeed, type WsLike } from "./kalshi-ws.ts";
import { KalshiPublicClient, KalshiApiError } from "./kalshi-rest.ts";
import { importKalshiPrivateKey, signKalshiRequest } from "./kalshi-sign.ts";
import { parseFixed, formatFixed, parsePriceE4, parseQtyE2 } from "./fixed.ts";
import { normalizeDelta, normalizeSnapshot } from "./kalshi-ws.ts";

// ---------- exact fixed point ----------

test("parseFixed is exact and refuses junk or lost precision", () => {
  assert.equal(parsePriceE4("0.6100"), 6100);
  assert.equal(parsePriceE4("0.9600"), 9600);
  assert.equal(parsePriceE4("1"), 10000);
  assert.equal(parseQtyE2("400.00"), 40000);
  assert.equal(parseQtyE2("1.99"), 199);
  assert.equal(parseFixed("-0.01", 2), -1);
  assert.equal(parseFixed("0.610000", 4), 6100); // trailing zeros beyond scale ok
  assert.throws(() => parseFixed("0.615", 2)); // real precision loss refused
  assert.throws(() => parseFixed("1e3", 4));
  assert.throws(() => parseFixed("", 4));
  assert.throws(() => parseFixed("0.61.0", 4));
  assert.equal(formatFixed(6100, 4), "0.6100");
  assert.equal(formatFixed(-199, 2), "-1.99");
});

// ---------- wire normalization (both shapes) ----------

test("normalize handles 2026 dollars shape and legacy cents shape", () => {
  const snapNew = normalizeSnapshot({
    market_ticker: "T",
    yes_dollars: [["0.6100", "400.00"]],
    no_dollars: [],
  });
  assert.deepEqual(snapNew.yes, [[6100, 40000]]);
  const snapOld = normalizeSnapshot({ market_ticker: "T", yes: [[61, 400]] });
  assert.deepEqual(snapOld.yes, [[6100, 40000]]);

  const dNew = normalizeDelta({ market_ticker: "T", price_dollars: "0.4500", delta_fp: "-2.50", side: "no" });
  assert.deepEqual(dNew, { market_ticker: "T", priceE4: 4500, deltaQtyE2: -250, side: "no" });
  const dOld = normalizeDelta({ market_ticker: "T", price: 45, delta: -2, side: "no" });
  assert.deepEqual(dOld, { market_ticker: "T", priceE4: 4500, deltaQtyE2: -200, side: "no" });
});

// ---------- orderbook-sync ----------

test("delta before snapshot is refused", () => {
  const s = new OrderbookSync();
  const r = s.applyDelta(1, { market_ticker: "T", priceE4: 4000, deltaQtyE2: 500, side: "yes" });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "not_synced");
  assert.equal(s.status, "AWAITING_SNAPSHOT");
});

test("snapshot then contiguous deltas mutate the ladder", () => {
  const s = new OrderbookSync();
  s.applySnapshot(10, { market_ticker: "T", yes: [[4000, 10000], [3900, 5000]], no: [[5500, 2000]] });
  assert.equal(s.status, "SYNCED");
  assert.equal(s.applyDelta(11, { market_ticker: "T", priceE4: 4000, deltaQtyE2: -3000, side: "yes" }).ok, true);
  assert.equal(s.applyDelta(12, { market_ticker: "T", priceE4: 4100, deltaQtyE2: 1000, side: "yes" }).ok, true);
  assert.deepEqual(s.levels("T", "yes"), [[4100, 1000], [4000, 7000], [3900, 5000]]);
});

test("delta draining a level to zero removes it", () => {
  const s = new OrderbookSync();
  s.applySnapshot(1, { market_ticker: "T", yes: [[3000, 500]] });
  s.applyDelta(2, { market_ticker: "T", priceE4: 3000, deltaQtyE2: -500, side: "yes" });
  assert.deepEqual(s.levels("T", "yes"), []);
});

test("seq gap halts and refuses everything until a fresh snapshot", () => {
  const s = new OrderbookSync();
  s.applySnapshot(1, { market_ticker: "T", yes: [[3000, 500]] });
  const gap = s.applyDelta(3, { market_ticker: "T", priceE4: 3000, deltaQtyE2: 100, side: "yes" });
  assert.equal(gap.ok, false);
  assert.equal(!gap.ok && gap.reason, "seq_gap");
  assert.equal(s.status, "HALTED");
  // even the "right" next seq is refused while halted
  const after = s.applyDelta(2, { market_ticker: "T", priceE4: 3000, deltaQtyE2: 100, side: "yes" });
  assert.equal(after.ok, false);
  assert.equal(!after.ok && after.reason, "not_synced");
  // book reads are empty while untrusted
  assert.deepEqual(s.levels("T", "yes"), []);
  // fresh snapshot re-syncs
  const re = s.applySnapshot(50, { market_ticker: "T", yes: [[3100, 700]] });
  assert.equal(re.ok, true);
  assert.deepEqual(s.levels("T", "yes"), [[3100, 700]]);
});

// ---------- ws feed: gap -> close -> reconnect -> resubscribe ----------

class FakeSocket implements WsLike {
  sent: string[] = [];
  closed = false;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  onopen: WsLike["onopen"] = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.({}); }
  open() { this.onopen?.({}); }
  push(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test("feed halts on gap, drops socket, resubscribes, re-syncs on snapshot", async () => {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const feed = new KalshiOrderbookFeed({
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    tickers: ["T"],
    reconnectDelayMs: 1,
    onEvent: (e) => events.push(e.kind),
  });
  await feed.start();
  const s1 = sockets[0]!;
  s1.open();
  assert.equal(s1.sent.length, 1);
  assert.match(s1.sent[0]!, /orderbook_delta/);

  s1.push({ type: "orderbook_snapshot", sid: 1, seq: 1, msg: { market_ticker: "T", yes: [[40, 10]] } });
  s1.push({ type: "orderbook_delta", sid: 1, seq: 2, msg: { market_ticker: "T", price: 40, delta: 5, side: "yes" } });
  assert.equal(feed.sync.status, "SYNCED");

  // gap: seq jumps 2 -> 4
  s1.push({ type: "orderbook_delta", sid: 1, seq: 4, msg: { market_ticker: "T", price: 40, delta: 1, side: "yes" } });
  assert.equal(s1.closed, true, "gap must drop the socket");

  // allow the reconnect timer to fire
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 2, "must reconnect after gap");
  const s2 = sockets[1]!;
  s2.open();
  assert.match(s2.sent[0]!, /subscribe/, "must resubscribe on the new socket");

  s2.push({ type: "orderbook_snapshot", sid: 2, seq: 1, msg: { market_ticker: "T", yes: [[41, 3]] } });
  assert.equal(feed.sync.status, "SYNCED");
  assert.deepEqual(feed.sync.levels("T", "yes"), [[4100, 300]]);
  assert.ok(events.includes("gap_halt"));
  feed.stop();
});

// ---------- rest client (stubbed fetch) ----------

test("rest client builds paths and unwraps envelopes", async () => {
  const calls: string[] = [];
  const stub = (async (url: string) => {
    calls.push(url);
    const body = url.includes("/orderbook")
      ? { orderbook_fp: { yes_dollars: [["0.4000", "1.00"]], no_dollars: null } }
      : url.includes("/trades")
        ? { trades: [], cursor: "" }
        : { markets: [], cursor: "" };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new KalshiPublicClient("https://example.test/trade-api/v2", stub);
  await c.getMarkets({ limit: 5 });
  const ob = await c.getOrderbook("KXTEST-26", 10);
  await c.getTrades({ ticker: "KXTEST-26", limit: 3 });
  assert.match(calls[0]!, /\/markets\?limit=5$/);
  assert.match(calls[1]!, /\/markets\/KXTEST-26\/orderbook\?depth=10$/);
  assert.match(calls[2]!, /\/markets\/trades\?ticker=KXTEST-26&limit=3$/);
  assert.deepEqual(ob.yes, [{ priceE4: 4000, qtyE2: 100 }]);
});

test("rest client surfaces non-200 as KalshiApiError", async () => {
  const stub = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const c = new KalshiPublicClient("https://example.test/trade-api/v2", stub);
  await assert.rejects(() => c.getMarkets(), (e: unknown) => e instanceof KalshiApiError && e.status === 503);
});

// ---------- signing (throwaway key, self-verify) ----------

test("PKCS#1 PEM (BEGIN RSA PRIVATE KEY) imports via the pkcs8 wrap and signs", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1Pem = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  assert.match(pkcs1Pem, /BEGIN RSA PRIVATE KEY/);

  const key = await importKalshiPrivateKey(pkcs1Pem);
  const ts = 1755740001000;
  const h = await signKalshiRequest(key, "ak_test", "GET", "/trade-api/ws/v2", ts);

  const spkiDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pub = await crypto.subtle.importKey(
    "spki", new Uint8Array(spkiDer).buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    pub,
    Uint8Array.from(atob(h["KALSHI-ACCESS-SIGNATURE"]), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`${ts}GET/trade-api/ws/v2`),
  );
  assert.equal(ok, true);
});

test("RSA-PSS signature verifies and binds ts+method+path", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(new Uint8Array(pkcs8)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

  const key = await importKalshiPrivateKey(pem);
  const ts = 1755740000000;
  const path = "/trade-api/v2/portfolio/balance";
  const h = await signKalshiRequest(key, "ak_test", "GET", path, ts);
  assert.equal(h["KALSHI-ACCESS-TIMESTAMP"], String(ts));

  const verify = async (msg: string) =>
    crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      pair.publicKey,
      Uint8Array.from(atob(h["KALSHI-ACCESS-SIGNATURE"]), (c) => c.charCodeAt(0)),
      new TextEncoder().encode(msg),
    );
  assert.equal(await verify(`${ts}GET${path}`), true);
  assert.equal(await verify(`${ts}POST${path}`), false, "method must be bound");
  assert.equal(await verify(`${ts + 1}GET${path}`), false, "timestamp must be bound");
});
