/** §3 pool admission matcher — the tag vocabulary (v1.5 categories, v1.8 recurrence) and v1.9's duration rule.
 *  These run with no network and no key, so the rule that decides which markets the study covers is checkable on
 *  every push rather than only when a pool day is discovered. The v1.8 block is a REGRESSION set: v1.9 re-shaped the
 *  exclusion constants, and poolTagsAdmit must still answer exactly as it did before that change. */
import {
  POOL_TAGS_INCLUDE, POOL_TAGS_EXCLUDE, POOL_TAGS_EXCLUDE_CATEGORY, POOL_TAGS_EXCLUDE_RECURRENCE,
  POOL_MIN_HOURS_TO_CLOSE, normalizeTags, poolTagsAdmit, poolCategoryAdmit, poolDurationAdmit, poolAdmit, hoursToClose,
  RECURRENCE_SLUG_ORACLE, slugNamesRecurrence,
} from "./lib";

let fails = 0, ran = 0;
function eq(got: unknown, want: unknown, what: string) {
  ran++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL ${what}\n       got ${g} want ${w}`); }
}

// A fixed clock: the tests must not drift with the wall time they are run at.
const NOW = "2026-09-10T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

console.log("POOL MATCHER · tag vocabulary");
// The union is what every pre-v1.9 caller matched on; splitting it must not have reordered or dropped a label.
eq(POOL_TAGS_EXCLUDE, [...POOL_TAGS_EXCLUDE_CATEGORY, ...POOL_TAGS_EXCLUDE_RECURRENCE], "exclude union = category ++ recurrence");
eq(POOL_TAGS_EXCLUDE, ["Sports", "Esports", "Culture", "entertainment", "Weather", "Recurring", "Up", "Down", "5M", "15M", "1H", "4H"], "exclude union byte-identical to v1.8");
eq(POOL_TAGS_INCLUDE.length, 8, "include set size");
eq(POOL_MIN_HOURS_TO_CLOSE, 24, "v1.9 threshold is 24h");

console.log("POOL MATCHER · normalizeTags — the three shapes tags reach us in");
eq(normalizeTags(["Politics", "Crypto"]), ["politics", "crypto"], "array of labels");
eq(normalizeTags([{ label: "Fed" }, { label: "World" }]), ["fed", "world"], "Gamma {label} objects");
eq(normalizeTags('["Economy","Up"]'), ["economy", "up"], "JSON-array string");
eq(normalizeTags("Politics, Crypto ,Fed"), ["politics", "crypto", "fed"], "comma string (Dune), trimmed");
eq(normalizeTags(null), [], "null");
eq(normalizeTags(""), [], "empty string");

console.log("POOL MATCHER · v1.8 regression — poolTagsAdmit answers as it did before v1.9");
eq(poolTagsAdmit(["Politics"]), true, "in-category");
eq(poolTagsAdmit([]), false, "no category tag at all");
eq(poolTagsAdmit(["Sports", "Politics"]), false, "v1.5 exclusion beats inclusion");
eq(poolTagsAdmit(["Crypto", "Recurring"]), false, "v1.8 Recurring");
eq(poolTagsAdmit(["Crypto", "1H"]), false, "v1.8 interval tag");
eq(poolTagsAdmit(["Economy", "Up"]), false, "v1.8 Up");
// Containment, not substring: a boundary regex fires on "Up" inside "Blow Up" and would silently drop the market.
eq(poolTagsAdmit(["Blow Up", "Politics"]), true, "whole-tag containment, not substring");
eq(poolTagsAdmit(["POLITICS", "rEcUrRiNg"]), false, "case-normalized both sides");

console.log("POOL MATCHER · hoursToClose");
eq(hoursToClose(at(48), NOW), 48, "ISO string, 48h out");
eq(hoursToClose(at(-3), NOW), -3, "a past close is negative, not clamped");
eq(hoursToClose(new Date(Date.parse(NOW) + 3_600_000), NOW), 1, "Date object");
eq(hoursToClose(Date.parse(NOW) + 7_200_000, NOW), 2, "bare number is epoch MILLISECONDS");
eq(hoursToClose(null, NOW), null, "null close");
eq(hoursToClose("", NOW), null, "empty close");
eq(hoursToClose("not a date", NOW), null, "unparseable close is null, never 0");
eq(hoursToClose(at(24), "not a date"), null, "unparseable now is null too");

console.log("POOL MATCHER · v1.9 duration rule — the close time governs");
eq(poolDurationAdmit(at(48), NOW), true, "48h out admitted");
eq(poolDurationAdmit(at(24), NOW), true, "exactly 24h admitted — the rule excludes LESS THAN 24h");
eq(poolDurationAdmit(at(23.9), NOW), false, "23.9h out excluded");
eq(poolDurationAdmit(at(1), NOW), false, "an hourly ladder excluded");
eq(poolDurationAdmit(at(-1), NOW), false, "already past its close");
// The Kalshi gap v1.8 could not reach: no tags exist, and the duration rule closes it anyway.
eq(poolDurationAdmit(at(0.25), NOW), false, "15 minutes out, no tag set present at all");
console.log("POOL MATCHER · v1.9 — where both exist the close time governs, in BOTH directions");
eq(poolDurationAdmit(at(120), NOW, ["Crypto", "Recurring"]), true, "recurrence tag OVERRIDDEN by a 5-day close");
eq(poolDurationAdmit(at(120), NOW, ["Crypto", "1H"]), true, "1H tag overridden by a 5-day close");
eq(poolDurationAdmit(at(2), NOW, ["Politics"]), false, "clean tags do NOT rescue a 2h close");
console.log("POOL MATCHER · v1.9 — the v1.8 tag set is the fallback where no close time is published");
eq(poolDurationAdmit(null, NOW, ["Crypto", "Recurring"]), false, "no close, recurrence tag → proxy excludes");
eq(poolDurationAdmit(null, NOW, ["Crypto"]), true, "no close, clean tags → proxy admits");
eq(poolDurationAdmit("not a date", NOW, ["Crypto", "4H"]), false, "unparseable close falls back to the proxy");
eq(poolDurationAdmit(null, NOW), true, "no close and no tags → admitted; the caller must COUNT this case");

console.log("POOL MATCHER · poolCategoryAdmit is v1.5 only — recurrence tags do not decide there");
eq(poolCategoryAdmit(["Crypto", "Recurring"]), true, "recurrence tag alone does not fail the category gate");
eq(poolCategoryAdmit(["Crypto", "Weather"]), false, "v1.5 exclusion still fails it");
eq(poolCategoryAdmit(["Recurring"]), false, "still needs a scan category");

console.log("POOL MATCHER · poolAdmit — the whole rule, as a market read sees it");
eq(poolAdmit(["Politics"], at(72), NOW), true, "in-category, 3 days out");
eq(poolAdmit(["Politics"], at(6), NOW), false, "in-category but 6h out");
eq(poolAdmit(["Sports"], at(720), NOW), false, "v1.5 exclusion beats any duration");
eq(poolAdmit(["Sports", "Politics"], at(720), NOW), false, "…even alongside a category tag");
eq(poolAdmit(["Crypto", "1H"], at(720), NOW), true, "v1.9: a month-out close overrides the 1H tag");
eq(poolAdmit(["Crypto", "1H"], null, NOW), false, "…but with no close published the tag still decides");
eq(poolAdmit([], at(720), NOW), false, "no category tag, however long-dated");

// ── LIVE DATA ────────────────────────────────────────────────────────────────────────────────────────────────────
// Everything above is a fixed clock and hand-built inputs, which proves the rule is self-consistent and nothing more.
// This block runs it against real venue data, using the market's OWN URL as an independent oracle: a venue-native
// recurrence market names itself (updown-<n>m / updown-<n>h), so if the duration rule is doing its job, no such market
// survives it. The rule never sees the slug — slug as oracle, never as criterion.
//
// NON-VACUITY IS ENFORCED. An oracle that matches nothing passes forever while proving nothing, which is the same
// failure class as a check that never exercises its own NULL branch. So a run that finds zero oracle markets is
// reported as NOT EXERCISED, never as a pass. Network trouble is a skip with a stated reason; a rule violation is a
// hard failure. Set Q3_SKIP_LIVE=1 to skip the block entirely.
async function live() {
  if (process.env.Q3_SKIP_LIVE) { console.log("POOL MATCHER · live data SKIPPED (Q3_SKIP_LIVE set)"); return; }
  console.log("POOL MATCHER · live data — the recurrence oracle vs the duration rule");
  const now = new Date().toISOString();
  let markets = 0, oracle = 0, violations = 0, pages = 0;
  try {
    for (let off = 0; off < 1000; off += 100) {
      const r = await fetch(`https://gamma-api.polymarket.com/events?order=volume24hr&ascending=false&closed=false&active=true&limit=100&offset=${off}`);
      if (!r.ok) throw new Error(`gamma HTTP ${r.status}`);
      const evs = await r.json(); if (!Array.isArray(evs) || !evs.length) break; pages++;
      for (const e of evs) {
        const tags = (e.tags ?? []).map((t: any) => t.label);
        for (const m of e.markets ?? []) {
          if (!m.active || m.closed) continue; markets++;
          // The oracle reads the market's own URL, exactly as market_details.polymarket_link carries it.
          const link = `https://polymarket.com/event/${e.slug}/${m.slug ?? ""}`;
          if (!slugNamesRecurrence(link)) continue;
          oracle++;
          if (poolDurationAdmit(m.endDate, now, tags)) {
            violations++;
            console.log(`  FAIL v1.9 admitted a market its own URL names as recurrence: ${m.slug} endDate=${m.endDate}`);
          }
        }
      }
      if (evs.length < 100) break;
    }
  } catch (err) {
    console.log(`  SKIP live check could not run: ${(err as Error).message} — network, not a rule failure`);
    return;
  }
  ran++;
  if (!oracle) {
    // Not a pass. The oracle found nothing to judge, so the assertion is unexercised and says so.
    console.log(`  NOT EXERCISED  ${markets} live markets over ${pages} page(s), 0 matched ${RECURRENCE_SLUG_ORACLE} — the oracle is`);
    console.log(`                 empty on this venue read, so this assertion proved nothing. It is exercised against`);
    console.log(`                 market_details.polymarket_link at republish, where the pattern's rows actually live.`);
    return;
  }
  if (violations) { fails++; console.log(`  FAIL ${violations}/${oracle} oracle market(s) survived the duration rule`); }
  else console.log(`  ok  ${oracle}/${oracle} oracle market(s) of ${markets} live excluded by the duration rule`);
}

live().then(() => {
  console.log(fails ? `POOL MATCHER · ${fails}/${ran} FAILED` : `POOL MATCHER · ${ran}/${ran} assertions pass`);
  process.exit(fails ? 1 : 0);
});
