// ws-pin — pin the Kalshi WS orderbook_delta wire shape with a DEMO key.
// Runs on the Operator's terminal; the key never leaves the machine and is
// never printed. Output is public market data + shape fingerprints only —
// safe to paste back to the build seat.
//
// Setup (once, inside ds-trading/adapter):
//   npm install ws
// Env (never inline, never chat):
//   KALSHI_KEY_ID           — API key id (uuid from the Kalshi console)
//   KALSHI_PRIVATE_KEY_PATH — path to the unencrypted PKCS#8 PEM
// Run:
//   npx tsx ws-pin.ts
//   npx tsx ws-pin.ts --ticker KXBTC-26AUG2023-T73299.99
//   npx tsx ws-pin.ts --host prod   (elections host; read-only, still no orders)
// Stops after 20 deltas or 60s, whichever first (--max-deltas / --seconds).

import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { importKalshiPrivateKey, signKalshiRequest } from "./kalshi-sign.ts";
import { KalshiPublicClient, KALSHI_DEMO_HOST, KALSHI_PROD_DATA_HOST } from "./kalshi-rest.ts";

// ---- args / env ------------------------------------------------------------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const HOST = arg("host") === "prod" ? KALSHI_PROD_DATA_HOST : KALSHI_DEMO_HOST;
const WS_URL = HOST.replace(/^https:/, "wss:").replace(/\/trade-api\/v2$/, "/trade-api/ws/v2");
const WS_PATH = "/trade-api/ws/v2";
const MAX_DELTAS = Number(arg("max-deltas") ?? 20);
const MAX_SECONDS = Number(arg("seconds") ?? 60);

const keyId = process.env.KALSHI_KEY_ID;
const pemPath = process.env.KALSHI_PRIVATE_KEY_PATH;
if (!keyId || !pemPath) {
  console.error("refuse: set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_PATH (see header). Never pass the key inline.");
  process.exit(2);
}

// ---- shape fingerprinting --------------------------------------------------

function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : ["(empty)"];
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = shapeOf((v as Record<string, unknown>)[k]);
    return o;
  }
  return typeof v;
}

const seenTypes = new Map<string, { count: number; fingerprint: string; sample: string }>();
const seqBySid = new Map<number, number>();
const gaps: string[] = [];
let deltaVerdict: string | null = null;
let deltas = 0;

function classifyDelta(msg: Record<string, unknown>): string {
  if (typeof msg.price_dollars === "string") return "NEW-DOLLARS (price_dollars / delta_fp strings)";
  if (typeof msg.price === "number") return "LEGACY-CENTS (price / delta integers)";
  return "UNKNOWN — paste the sample below back to the build seat";
}

function record(raw: string): void {
  let env: Record<string, unknown>;
  try { env = JSON.parse(raw); } catch { console.log("non-JSON frame:", raw.slice(0, 200)); return; }
  const t = String(env.type ?? "(untyped)");
  const entry = seenTypes.get(t);
  if (entry) entry.count += 1;
  else seenTypes.set(t, { count: 1, fingerprint: JSON.stringify(shapeOf(env), null, 2), sample: raw.slice(0, 600) });

  const sid = Number(env.sid ?? 0);
  const seq = env.seq;
  if (typeof seq === "number") {
    const last = seqBySid.get(sid);
    if (last !== undefined && seq !== last + 1 && t !== "orderbook_snapshot") {
      gaps.push(`sid=${sid} expected ${last + 1} got ${seq} (type=${t})`);
    }
    seqBySid.set(sid, seq);
  }
  if (t === "orderbook_delta" && env.msg && typeof env.msg === "object") {
    deltas += 1;
    deltaVerdict ??= classifyDelta(env.msg as Record<string, unknown>);
  }
}

function summarize(code: number): never {
  console.log("\n==== ws-pin summary ====");
  console.log(`host: ${WS_URL}`);
  for (const [t, e] of seenTypes) {
    console.log(`\n--- type "${t}" x${e.count} — shape:\n${e.fingerprint}`);
    console.log(`first sample: ${e.sample}`);
  }
  console.log(`\nDELTA SHAPE VERDICT: ${deltaVerdict ?? "no deltas observed — quiet market, rerun with a busier ticker"}`);
  console.log(`seq continuity: ${gaps.length === 0 ? "no gaps observed" : gaps.join("; ")}`);
  console.log("paste everything from '==== ws-pin summary ====' down — it contains no secrets.");
  process.exit(code);
}

// ---- main ------------------------------------------------------------------

const rest = new KalshiPublicClient(HOST);
let ticker = arg("ticker");
if (!ticker) {
  const { markets } = await rest.getMarkets({ limit: 50, status: "open", series_ticker: "KXBTC" });
  ticker = (markets.find((m) => m.yes_bid_dollars && m.yes_bid_dollars !== "0.0000") ?? markets[0])?.ticker;
  if (!ticker) { console.error("no open market found; pass --ticker"); process.exit(2); }
}
console.log(`pinning orderbook_delta on ${ticker} via ${WS_URL}`);

const key = await importKalshiPrivateKey(readFileSync(pemPath, "utf8"));
const headers = await signKalshiRequest(key, keyId, "GET", WS_PATH);

const ws = new WebSocket(WS_URL, { headers });
ws.on("open", () => {
  console.log("connected; subscribing…");
  ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: [ticker] } }));
});
ws.on("message", (data) => {
  record(String(data));
  if (deltas >= MAX_DELTAS) { ws.close(); summarize(0); }
});
ws.on("error", (err) => {
  console.error("ws error:", err.message);
  if (err.message.includes("401")) {
    console.error("401 = this key is not registered on this host. Demo keys come from the demo console (demo.kalshi.co); prod keys from the main console. Host and key must match.");
  }
  summarize(1);
});
ws.on("close", (code, reason) => {
  console.log(`closed: ${code} ${String(reason).slice(0, 200)}`);
  summarize(seenTypes.size > 0 ? 0 : 1);
});
setTimeout(() => { console.log(`time limit ${MAX_SECONDS}s reached`); try { ws.close(); } catch {} summarize(0); }, MAX_SECONDS * 1000);
