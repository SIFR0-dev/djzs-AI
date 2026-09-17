/**
 * Liveness probe for the public site: every page a visitor or crawler can reach answers 200, and /verify is
 * still showing the most recent anchor this repo has sealed.
 *
 *   node tests/q3/site-liveness.mjs                     # probe https://djzs.ai
 *   SITE_ORIGIN=https://djzs-site.<sub>.workers.dev node tests/q3/site-liveness.mjs
 *
 * WHY THIS EXISTS. site/ deploys by hand (§12.1), and a deploy from the wrong tree does not fail — it succeeds
 * and replaces the live site with whatever that tree holds. On 2026-09-16 that put every page on djzs.ai at 404
 * and nothing said so; the outage ended when the operator happened to look. This is the thing that looks.
 *
 * WHY IT PROBES, RATHER THAN CHECKING THE REPO. `render-anchors.ts --check` already proves site/verify.html
 * mirrors anchors.json in the tree. That is a statement about the tree. It says nothing about what is deployed,
 * and the 2026-09-16 outage was entirely a deploy fact — the tree was correct throughout. Two different claims,
 * two different checks.
 *
 * WHY /verify CARRIES THE ANCHOR ID EVEN THOUGH THE PAGE ELIDES IT. render-anchors prints the id as a shortened
 * label (`3w8hzn8mDr…nAKk9P`) but links it at its full gateway URL, so the complete id is in the href. A
 * substring test therefore distinguishes "the current /verify" from "a /verify deployed before the last anchor" —
 * which a 200 alone does not: a stale-but-serving site passes every status check.
 *
 * NO DEPENDENCIES, ON PURPOSE. A monitor that can go red because `npm ci` broke is a monitor that trains you to
 * ignore it. Node 22 built-ins only: no install step, nothing between the schedule and the probe.
 *
 * REPORT AND STOP. This never deploys, purges, opens anything, or otherwise touches the site. A failing run is a
 * red job and a printed reason; the remediation is the operator's, from the operator's shell (CLAUDE.md §5).
 */
import { readFileSync } from "node:fs";

const ORIGIN = (process.env.SITE_ORIGIN || "https://djzs.ai").replace(/\/+$/, "");
const SRC = "tests/q3/anchors.json";
const PATHS = ["/", "/verify", "/ruleset", "/build", "/builders", "/guide", "/favicon.svg"];
const TIMEOUT_MS = 20_000;

/** Latest = greatest date; anchored_at breaks a same-day tie. Sorted by hand rather than trusting file order,
 *  because the file's order is a convention and this check should not silently depend on one. */
function latestAnchor(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) throw new Error(`${SRC}: no anchors to check against`);
  return [...anchors].sort((a, b) => a.date.localeCompare(b.date) || String(a.anchored_at).localeCompare(String(b.anchored_at))).at(-1);
}

/** One retry, and only for a transport error or a 5xx — the cases where the failure may be the prober's network
 *  rather than the site's. A 404 is never retried: that is the exact signal this exists to catch, and retrying
 *  it would only delay the report. */
async function probe(url) {
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "djzs-gate-liveness/1 (+https://djzs.ai)" } });
      const body = await res.text();
      attempts.push(`HTTP ${res.status}`);
      if (res.status >= 500) continue;
      return { status: res.status, body, attempts };
    } catch (err) {
      attempts.push(`transport: ${err?.message || err}`);
    }
  }
  return { status: null, body: "", attempts };
}

const anchor = latestAnchor(JSON.parse(readFileSync(SRC, "utf8")));
console.log(`probing ${ORIGIN} · latest anchor ${anchor.date} → ${anchor.irys_id}\n`);

const failures = [];
for (const path of PATHS) {
  const url = `${ORIGIN}${path}`;
  const { status, body, attempts } = await probe(url);
  const tries = attempts.length > 1 ? `  (attempts: ${attempts.join(" · ")})` : "";

  if (status !== 200) { failures.push(`${path}: expected 200, got ${status ?? "no response"} — ${attempts.join(" · ")}`); console.error(`  FAIL ${path}  ${status ?? "no response"}${tries}`); continue; }
  if (body.length === 0) { failures.push(`${path}: 200 with an empty body`); console.error(`  FAIL ${path}  200 but empty`); continue; }

  // The anchor assertion rides on /verify only. Redundant elsewhere, and a page that is not meant to carry the
  // id would fail for the wrong reason.
  if (path === "/verify" && !body.includes(anchor.irys_id)) {
    failures.push(`/verify: 200, but it does not carry the latest anchor (${anchor.date}, ${anchor.irys_id}) — the deployed page predates the last anchor, or was deployed from a tree that does not have it`);
    console.error(`  FAIL /verify  200 but stale — missing ${anchor.irys_id}`);
    continue;
  }

  console.log(`  ok   ${path}  200${path === "/verify" ? `, carries ${anchor.irys_id}` : ""}${tries}`);
}

if (failures.length) {
  console.error(`\nSITE LIVENESS · FAILED (${failures.length} of ${PATHS.length} check(s))`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(`\nNot remediating. Check what is deployed before redeploying: a deploy from the wrong directory ships a Worker with no assets (SCAN_SPEC §12.1), and the edge can serve a stale copy of a good deploy for a few minutes (CLAUDE.md §13/§14) — probe the workers.dev alias to tell those two apart.`);
  process.exit(1);
}
console.log(`\nSITE LIVENESS · ${PATHS.length + 1} assertion(s) pass`);
