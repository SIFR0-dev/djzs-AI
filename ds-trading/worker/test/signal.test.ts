// Shadow signal box battery — offline, in-memory ledger.
//   node --experimental-strip-types --test test/signal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, type Env, type D1Like, type D1Stmt } from "../src/index.ts";
import { stableStringify, computeSpecHash } from "../src/signal-core.ts";

// ---------- canonicalization / hash ----------

test("stableStringify sorts keys recursively; hash is key-order-insensitive", async () => {
  assert.equal(stableStringify({ b: 1, a: { d: [2, { z: 0, y: 1 }], c: null } }),
    '{"a":{"c":null,"d":[2,{"y":1,"z":0}]},"b":1}');
  const h1 = await computeSpecHash({ spec_id: "SC-03", version: "v1", params: { a: 1, b: 2 }, kill_criteria: { max_dd: 5 } });
  const h2 = await computeSpecHash({ spec_id: "SC-03", version: "v1", params: { b: 2, a: 1 }, kill_criteria: { max_dd: 5 } });
  const h3 = await computeSpecHash({ spec_id: "SC-03", version: "v1", params: { a: 1, b: 3 }, kill_criteria: { max_dd: 5 } });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
});

// ---------- in-memory ledger covering verdicts + signal_specs ----------

class MemoryLedger implements D1Like {
  verdicts = new Map<string, Record<string, unknown>>();
  specs = new Map<string, Record<string, unknown>>();
  prepare(sql: string): D1Stmt {
    const self = this;
    const make = (bound: unknown[]): D1Stmt => ({
      bind: (...values: unknown[]) => make(values),
      async first<T>() {
        if (sql.startsWith("SELECT 1")) return { ok: 1 } as T;
        if (sql.includes("FROM signal_specs")) return (self.specs.get(String(bound[0])) ?? null) as T | null;
        if (sql.includes("FROM verdicts")) return (self.verdicts.get(String(bound[0])) ?? null) as T | null;
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO signal_specs")) {
          const [spec_id, version, spec_hash, registered_at, params, kill_criteria] = bound as string[];
          self.specs.set(spec_id, { spec_id, version, spec_hash, registered_at, status: "draft", params, kill_criteria });
        } else if (sql.includes("UPDATE signal_specs")) {
          const row = self.specs.get(String(bound[0]));
          if (row && row.status === "draft") row.status = "shadow";
        } else if (sql.includes("INSERT INTO verdicts")) {
          const [verdict_id, created_at, source, signal_spec, , , market_ticker, side, , , , , , , verdict] = bound as string[];
          self.verdicts.set(verdict_id, { verdict_id, created_at, source, signal_spec, market_ticker, side, verdict });
        }
        return {};
      },
    });
    return make([]);
  }
}

const env = (l: D1Like): Env => ({ LEDGER: l });
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, e: Env) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, e);

const SC03 = {
  spec_id: "SC-03",
  version: "v1",
  params: { band_low_e4: 2000, band_high_e4: 6000 },
  kill_criteria: { max_consecutive_losses: 5 },
};

// ---------- registration ----------

test("register computes hash pre-signal and returns draft", async () => {
  const app = createApp();
  const e = env(new MemoryLedger());
  const res = await post(app, "/signal-specs", SC03, e);
  assert.equal(res.status, 201);
  const j = (await res.json()) as Record<string, string>;
  assert.equal(j.status, "draft");
  assert.equal(j.spec_hash, await computeSpecHash(SC03));
});

test("registration refuses: bad id, empty kill_criteria, duplicates", async () => {
  const app = createApp();
  const e = env(new MemoryLedger());
  assert.equal((await post(app, "/signal-specs", { ...SC03, spec_id: "SC3" }, e)).status, 400);
  assert.equal((await post(app, "/signal-specs", { ...SC03, kill_criteria: {} }, e)).status, 400);
  assert.equal((await post(app, "/signal-specs", SC03, e)).status, 201);
  assert.equal((await post(app, "/signal-specs", SC03, e)).status, 409, "specs are immutable — no re-registration");
});

test("promote arms draft -> shadow exactly once", async () => {
  const app = createApp();
  const e = env(new MemoryLedger());
  await post(app, "/signal-specs", SC03, e);
  const p1 = await post(app, "/signal-specs/SC-03/promote", {}, e);
  assert.equal(p1.status, 200);
  assert.equal(((await p1.json()) as { status: string }).status, "shadow");
  assert.equal((await post(app, "/signal-specs/SC-03/promote", {}, e)).status, 409);
  assert.equal((await post(app, "/signal-specs/SC-99/promote", {}, e)).status, 404);
});

// ---------- shadow verdicts gated on armed specs ----------

const shadowVerdict = {
  source: "signal_box", signal_spec: "SC-03",
  subject: "SC-03 shadow", thesis: "shadow thesis", flags: ["M04"], unknowns: [],
};

test("signal_box verdict refused without spec, with unregistered spec, with draft spec", async () => {
  const app = createApp();
  const ledger = new MemoryLedger();
  const e = env(ledger);
  assert.equal((await post(app, "/verdicts", { ...shadowVerdict, signal_spec: undefined }, e)).status, 400);
  assert.equal((await post(app, "/verdicts", shadowVerdict, e)).status, 403, "unregistered spec");
  await post(app, "/signal-specs", SC03, e);
  assert.equal((await post(app, "/verdicts", shadowVerdict, e)).status, 403, "draft spec is not armed");
  assert.equal(ledger.verdicts.size, 0, "nothing may land before arming");
});

test("armed spec: shadow verdict lands with signal_spec stamped; user verdicts unaffected", async () => {
  const app = createApp();
  const ledger = new MemoryLedger();
  const e = env(ledger);
  await post(app, "/signal-specs", SC03, e);
  await post(app, "/signal-specs/SC-03/promote", {}, e);
  const res = await post(app, "/verdicts", shadowVerdict, e);
  assert.equal(res.status, 201);
  const j = (await res.json()) as { verdict_id: string; verdict: string; advisory_only: boolean };
  assert.equal(j.verdict, "PASS"); // solo M04 residual
  assert.equal(j.advisory_only, true);
  assert.equal(ledger.verdicts.get(j.verdict_id)!.signal_spec, "SC-03");

  const user = await post(app, "/verdicts", { source: "user", subject: "s", thesis: "t", flags: [], unknowns: [] }, e);
  assert.equal(user.status, 201);
  assert.equal(ledger.verdicts.size, 2);
});
