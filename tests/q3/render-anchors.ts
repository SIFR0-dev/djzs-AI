/**
 * Render tests/q3/anchors.json into the generated block on site/verify.html, and — in --check mode — fail the
 * build if the page and the file have drifted apart.
 *
 * WHY THIS IS GENERATED RATHER THAN WRITTEN. /verify is a static page: it cannot import anchors.json, and the file
 * does not ship in the site asset bundle, so anything the page says about the study's anchors is necessarily a
 * SECOND COPY of facts that live somewhere else. Two copies of the same facts is the shape that drifts — the same
 * failure mode as the PASS/PROCEED vocabulary bug, the two WAIT counters, and the correction registry this mirrors.
 * The copy is therefore machine-written from the source of truth and machine-compared in CI, so drift is a failing
 * build rather than a discovery.
 *
 *   npx tsx tests/q3/render-anchors.ts            # write the block
 *   npx tsx tests/q3/render-anchors.ts --check    # assert it matches; exit 1 on drift (CI)
 *
 * THE INVARIANT, stated in the same terms as the corrections mirror: the page may never advertise an anchor the
 * file does not have, and may never omit one it does. A byte comparison of the generated block gives both
 * directions at once — a weaker check (does the page merely CONTAIN each id?) would pass a page that also listed a
 * day that was never anchored.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PAGE = "site/verify.html";
const SRC = "tests/q3/anchors.json";
const REC_DIR = "tests/q3/records";
const BEGIN = "<!-- BEGIN q3-anchors · generated from tests/q3/anchors.json by tests/q3/render-anchors.ts. Do not edit by hand -->";
const END = "<!-- END q3-anchors -->";
const check = process.argv.includes("--check");

interface Anchor { date: string; protocol_version: string; record_count: number; merkle_root: string; irys_id: string; gateway_url: string; anchored_at: string }

/** Escape before interpolation. Every value here is repo-controlled, but a renderer that only happens to be safe
 *  because of what it is fed today is a renderer that stops being safe the first time that changes. */
const esc = (v: unknown) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Irys ids and roots are long; show enough to recognise, never so little that two differ only past the ellipsis. */
const short = (s: string, head = 10, tail = 6) => s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

function render(anchors: Anchor[]): string {
  const rows = [...anchors].sort((a, b) => b.date.localeCompare(a.date)).map(a => `      <div class="row">
        <span class="d">${esc(a.date)}</span>
        <p class="m">${esc(a.record_count)} record${a.record_count === 1 ? "" : "s"}<span class="chip">protocol ${esc(a.protocol_version)}</span></p>
        <span class="ev"><b>root</b> ${esc(a.merkle_root)}
<b>irys</b> <a href="${esc(a.gateway_url)}" rel="noopener">${esc(short(a.irys_id))}</a>  <b>anchored</b> ${esc(a.anchored_at)}</span>
      </div>`).join("\n");
  const days = anchors.length, recs = anchors.reduce((n, a) => n + a.record_count, 0);
  return `${BEGIN}
${rows}
      <div class="row">
        <span class="d">total</span>
        <p class="m">${days} anchored day${days === 1 ? "" : "s"} · ${recs} record${recs === 1 ? "" : "s"}</p>
      </div>
${END}`;
}

const anchors = JSON.parse(readFileSync(SRC, "utf8")) as Anchor[];
const page = readFileSync(PAGE, "utf8");
const i = page.indexOf(BEGIN), j = page.indexOf(END);
if (i < 0 || j < 0) { console.error(`${PAGE}: generation markers not found — the block must be delimited by the BEGIN/END comments`); process.exit(1); }

// Cross-file check, independent of the page: anchors.json must agree with records/ about how many records each day
// sealed. The page prints record_count, so a wrong count there is a wrong public claim about the size of the book.
let crossFail = 0;
for (const a of anchors) {
  let sealed: number | null = null;
  try { sealed = (JSON.parse(readFileSync(`${REC_DIR}/${a.date}.json`, "utf8")) as { record_hash: string | null }[]).filter(r => r.record_hash).length; } catch { sealed = null; }
  if (sealed === null) { console.error(`  FAIL ${a.date}: anchored but tests/q3/records/${a.date}.json is missing or unreadable`); crossFail++; }
  else if (sealed !== a.record_count) { console.error(`  FAIL ${a.date}: anchors.json says ${a.record_count} record(s), records/ holds ${sealed} sealed`); crossFail++; }
  else console.log(`  ok  ${a.date}: record_count ${a.record_count} agrees with records/${a.date}.json`);
}

const next = page.slice(0, i) + render(anchors) + page.slice(j + END.length);
if (check) {
  const drifted = next !== page;
  if (drifted) console.error(`  FAIL site/verify.html: the generated anchors block does not match tests/q3/anchors.json — run: npx tsx tests/q3/render-anchors.ts`);
  else console.log(`  ok  site/verify.html mirrors anchors.json exactly (${anchors.length} day(s))`);
  if (drifted || crossFail) { console.error(`\nANCHOR MIRROR · FAILED`); process.exit(1); }
  console.log(`\nANCHOR MIRROR · ${anchors.length + 1} assertion(s) pass`);
} else {
  if (crossFail) { console.error(`\nrefusing to write: anchors.json disagrees with records/ (${crossFail} day(s)). Fix the source before mirroring it.`); process.exit(1); }
  writeFileSync(PAGE, next);
  console.log(`\nwrote ${anchors.length} anchored day(s) into ${PAGE}`);
}
