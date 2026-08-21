// Verdict path + gate battery — offline, in-memory ledger.
//   node --experimental-strip-types --test test/gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, type Env, type D1Like, type D1Stmt } from "../src/index.ts";
import { decide, computeVerdictHash, type AuditInput } from "../src/verdict-core.ts";

// ---------- verdict-core decision table ----------

test("decide: frozen DJZS-M table", () => {
  assert.deepEqual(
    [decide([], []).verdict, decide([], []).action],
    ["PASS", "PROCEED"],
  );
  const soloM04 = decide(["M04"], []);
  assert.equal(soloM04.verdict, "PASS"); // advisory: residual PASS
  assert.equal(soloM04.advisory_only, true);
  assert.equal(soloM04.risk_score, 15);

  const stack = decide(["M03", "M04"], []);
  assert.equal(stack.verdict, "FAIL"); // 40 — advisory blocks only by stacking
  assert.equal(stack.risk_score, 40);

  assert.equal(decide(["M02"], []).verdict, "FAIL"); // CRITICAL
  assert.equal(decide(["M01", "M02"], []).risk_score, 60);
  assert.equal(decide([], ["engagement"]).verdict, "WAIT"); // unknowns block
  assert.equal(decide(["M04"], ["basis"]).verdict, "WAIT");
  assert.equal(decide(["M02"], []).action, "HALT");
  assert.throws(() => decide(["X99" as never], []));
});

test("verdict hash is deterministic and order-insensitive on flags", async () => {
  const input: AuditInput = {
    subject: "s", thesis: "t", market_ticker: "KXT", side: "yes",
    p_claim_e4: 6000, market_price_e4: 5800, fee_est_e4: 175,
    flags: ["M04", "M03"], unknowns: [],
  };
  const d1 = decide(input.flags, input.unknowns);
  const h1 = await computeVerdictHash(input, d1);
  const input2 = { ...input, flags: ["M03", "M04"] as AuditInput["flags"] };
  const d2 = decide(input2.flags, input2.unknowns);
  const h2 = await computeVerdictHash(input2, d2);
  assert.equal(h1, h2);
  const d3 = decide(input.flags, input.unknowns);
  const h3 = await computeVerdictHash({ ...input, thesis: "t2" }, d3);
  assert.notEqual(h1, h3);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
});

// ---------- in-memory ledger ----------

class MemoryLedger implements D1Like {
  rows = new Map<string, Record<string, unknown>>();
  prepare(sql: string): D1Stmt {
    const self = this;
    const make = (bound: unknown[]): D1Stmt => ({
      bind: (...values: unknown[]) => make(values),
      async first<T>() {
        if (sql.startsWith("SELECT 1")) return { ok: 1 } as T;
        if (sql.includes("FROM verdicts")) {
          return (self.rows.get(String(bound[0])) ?? null) as T | null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO verdicts")) {
          const [verdict_id, created_at, , , , , market_ticker, side, , , , , , , verdict] = bound as string[];
          self.rows.set(verdict_id, { verdict_id, created_at, market_ticker, side, verdict });
        }
        return {};
      },
    });
    return make([]);
  }
}

const env = (ledger: D1Like): Env => ({ LEDGER: ledger });
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, e: Env) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, e);

// ---------- POST /verdicts ----------

test("POST /verdicts writes a row and returns the computed hash", async () => {
  const ledger = new MemoryLedger();
  const app = createApp();
  const res = await post(app, "/verdicts", {
    source: "user", subject: "probe", thesis: "probe thesis", flags: ["M02"], unknowns: [],
  }, env(ledger));
  assert.equal(res.status, 201);
  const j = (await res.json()) as Record<string, unknown>;
  assert.equal(j.verdict, "FAIL");
  assert.equal(j.action, "HALT");
  assert.equal(j.risk_score, 30);
  assert.match(String(j.verdict_hash), /^0x[0-9a-f]{64}$/);
  assert.equal(ledger.rows.size, 1);
});

test("POST /verdicts refuses junk", async () => {
  const app = createApp();
  const e = env(new MemoryLedger());
  assert.equal((await post(app, "/verdicts", { source: "user", thesis: "t", flags: [], unknowns: [] }, e)).status, 400); // no subject
  assert.equal((await post(app, "/verdicts", { source: "bot", subject: "s", thesis: "t" }, e)).status, 400); // bad source
  assert.equal((await post(app, "/verdicts", { source: "user", subject: "s", thesis: "t", flags: ["Z9"] }, e)).status, 400); // unknown code
});

// ---------- THE GATE: every refusal path, then the 501 ceiling ----------

async function passVerdict(app: ReturnType<typeof createApp>, e: Env): Promise<string> {
  const res = await post(app, "/verdicts", {
    source: "user", subject: "s", thesis: "t", market_ticker: "KXT", side: "yes",
    flags: [], unknowns: [],
  }, e);
  return ((await res.json()) as { verdict_id: string }).verdict_id;
}

test("gate: order without verdict_id is refused (the increment-1 failing test)", async () => {
  const app = createApp();
  const res = await post(app, "/v1/orders", { market_ticker: "KXT", side: "yes", count_e2: 100, entry_price_e4: 5000 }, env(new MemoryLedger()));
  assert.equal(res.status, 400);
  const j = (await res.json()) as { error: string };
  assert.equal(j.error, "gate");
});

test("gate: unknown verdict_id -> 403 HALT", async () => {
  const app = createApp();
  const res = await post(app, "/v1/orders", { verdict_id: "ghost", market_ticker: "KXT", side: "yes" }, env(new MemoryLedger()));
  assert.equal(res.status, 403);
});

test("gate: FAIL verdict -> 403 HALT", async () => {
  const ledger = new MemoryLedger();
  const app = createApp();
  const e = env(ledger);
  const res1 = await post(app, "/verdicts", { source: "user", subject: "s", thesis: "t", flags: ["M02"], unknowns: [] }, e);
  const { verdict_id } = (await res1.json()) as { verdict_id: string };
  const res = await post(app, "/v1/orders", { verdict_id, market_ticker: "KXT", side: "yes" }, e);
  assert.equal(res.status, 403);
  assert.match(JSON.stringify(await res.json()), /FAIL/);
});

test("gate: stale PASS verdict -> 403 HALT", async () => {
  const ledger = new MemoryLedger();
  const app = createApp();
  const e = env(ledger);
  const id = await passVerdict(app, e);
  const row = ledger.rows.get(id)!;
  row.created_at = new Date(Date.now() - 16 * 60 * 1000).toISOString(); // beyond TTL
  const res = await post(app, "/v1/orders", { verdict_id: id, market_ticker: "KXT", side: "yes" }, e);
  assert.equal(res.status, 403);
  assert.match(JSON.stringify(await res.json()), /stale/);
});

test("gate: market or side differing from the audited ones -> 403 HALT", async () => {
  const ledger = new MemoryLedger();
  const app = createApp();
  const e = env(ledger);
  const id = await passVerdict(app, e);
  assert.equal((await post(app, "/v1/orders", { verdict_id: id, market_ticker: "OTHER", side: "yes" }, e)).status, 403);
  assert.equal((await post(app, "/v1/orders", { verdict_id: id, market_ticker: "KXT", side: "no" }, e)).status, 403);
});

test("gate fully passed still places NO order in increment 1 (501, nothing written)", async () => {
  const ledger = new MemoryLedger();
  const app = createApp();
  const e = env(ledger);
  const id = await passVerdict(app, e);
  const res = await post(app, "/v1/orders", { verdict_id: id, market_ticker: "KXT", side: "yes", count_e2: 100, entry_price_e4: 5000 }, e);
  assert.equal(res.status, 501);
  const j = (await res.json()) as { gate: string; venue: string };
  assert.equal(j.gate, "passed");
  assert.equal(j.venue, "not_implemented");
  assert.equal(ledger.rows.size, 1, "no execution row, only the verdict");
});
