/** §3 pool admission matcher — the tag vocabulary (v1.5 categories, v1.8 recurrence) and v1.9's duration rule.
 *  These run with no network and no key, so the rule that decides which markets the study covers is checkable on
 *  every push rather than only when a pool day is discovered. The v1.8 block is a REGRESSION set: v1.9 re-shaped the
 *  exclusion constants, and poolTagsAdmit must still answer exactly as it did before that change. */
import {
  POOL_TAGS_INCLUDE, POOL_TAGS_EXCLUDE, POOL_TAGS_EXCLUDE_CATEGORY, POOL_TAGS_EXCLUDE_RECURRENCE,
  POOL_MIN_HOURS_TO_CLOSE, normalizeTags, poolTagsAdmit, poolCategoryAdmit, poolDurationAdmit, poolAdmit, hoursToClose,
  RECURRENCE_SLUG_ORACLE, slugNamesRecurrence, normEventKey, poolOnePerEvent,
} from "./lib";
import { readFileSync } from "node:fs";

let fails = 0, ran = 0, unexercised = 0;
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
eq(POOL_TAGS_EXCLUDE, ["Sports", "Esports", "Culture", "entertainment", "Weather", "Recurring", "Up or Down", "5M", "15M", "1H", "4H"], "exclude union matches PROTOCOL v1.8's literal text");
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
// THE CORRECTION, pinned in both directions. v1.8's text is "Recurring, Up or Down, or an interval tag" — one label,
// not two. Live vocabulary (2026-09-10, 600 events): "Up or Down" x12, standalone "Up"/"Down" ZERO. Implementing it
// as two tags meant the recurrence proxy could never fire on any real market.
eq(poolTagsAdmit(["Economy", "Up or Down"]), false, "v1.8 'Up or Down' — the single real tag — excludes");
eq(poolTagsAdmit(["Economy", "UP OR DOWN"]), false, "…case-normalized");
eq(poolTagsAdmit(["Economy", "Up"]), true, "bare 'Up' is NOT a venue tag and must not exclude on its own");
eq(poolTagsAdmit(["Economy", "Down"]), true, "…nor bare 'Down'");
eq(poolTagsAdmit(["Economy", "Finance Updown"]), true, "'Finance Updown' is a real, unrelated live tag — containment must not catch it");
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
eq(poolDurationAdmit(null, NOW, ["Crypto", "Up or Down"]), false, "no close, 'Up or Down' → proxy excludes (this is what the two-tag bug broke)");
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
eq(poolAdmit(["Crypto", "Up or Down"], null, NOW), false, "…same for the 'Up or Down' ladder tag");
eq(poolAdmit([], at(720), NOW), false, "no category tag, however long-dated");

// ── v1.15: the pool unit is the venue event ─────────────────────────────────────────────────────────────────────
// Hand-built rows first (every branch of the walk), then the one pool day that has been sealed, read from the
// committed discovery file: the numbers PROTOCOL v1.15's disclosure table states are reproduced here, not typed.
console.log("POOL MATCHER · v1.15 — one market per venue event");
type Row = { id: string; ev: unknown; vol: number };
const G = { id: (r: Row) => r.id, event: (r: Row) => r.ev, volume: (r: Row) => r.vol };
const ids = (rs: Row[]) => rs.map(r => r.id);
const ladder: Row[] = [
  { id: "FED-H0", ev: "FED-26SEP", vol: 900 }, { id: "FED-H25", ev: "FED-26SEP", vol: 700 }, { id: "SEN-ME-D", ev: "SENATEME-26", vol: 600 },
  { id: "FED-C25", ev: "FED-26SEP", vol: 500 }, { id: "SEN-ME-R", ev: "SENATEME-26", vol: 400 }, { id: "CLARITY", ev: "CLARITY-26", vol: 300 },
];
const w1 = poolOnePerEvent(ladder, G);
eq(ids(w1.taken), ["FED-H0", "SEN-ME-D", "CLARITY"], "a strike ladder collapses to its highest-volume market; events keep their rank order");
eq(w1.skipped.map(s => [s.candidate.id, s.reason, s.kept_id]), [["FED-H25", "same_event", "FED-H0"], ["FED-C25", "same_event", "FED-H0"], ["SEN-ME-R", "same_event", "SEN-ME-D"]], "every collapsed market is reported with the market that represents its event");
eq(ids(poolOnePerEvent([...ladder].reverse(), G).taken), ids(w1.taken), "the walk ranks for itself: input order does not matter");
eq(ids(poolOnePerEvent([{ id: "B", ev: "E2", vol: 5 }, { id: "A", ev: "E1", vol: 5 }], G).taken), ["A", "B"], "equal volumes are ordered by market id, ascending");
eq(ids(poolOnePerEvent([{ id: "A2", ev: "E", vol: 5 }, { id: "A1", ev: "E", vol: 5 }], G).taken), ["A1"], "…including inside one event");
eq(ids(poolOnePerEvent([{ id: "X", ev: null, vol: 9 }, { id: "Y", ev: null, vol: 8 }, { id: "Z", ev: "", vol: 7 }, { id: "W", ev: undefined, vol: 6 }], G).taken), ["X", "Y", "Z", "W"], "no published event id = its own event: never collapsed into another");
eq(ids(poolOnePerEvent([{ id: "a", ev: "KXFED-26SEP", vol: 9 }, { id: "b", ev: " kxfed-26sep ", vol: 8 }], G).taken), ["a"], "event ids compare trimmed and case-insensitively");
eq(ids(poolOnePerEvent([{ id: "a", ev: 762, vol: 9 }, { id: "b", ev: 762, vol: 8 }], G).taken), ["a", "b"], "a non-string event id is not an identifier: both stand alone, nothing is guessed");
const w2 = poolOnePerEvent(ladder, G, ["fed-26sep"]);
eq(ids(w2.taken), ["SEN-ME-D", "CLARITY"], "rule 2: an event already in the book is out, every strike of it");
eq(w2.skipped.filter(s => s.reason === "event_in_book").map(s => s.candidate.id), ["FED-H0", "FED-H25", "FED-C25"], "…and each skipped strike says why");
eq(ids(poolOnePerEvent([{ id: "X", ev: null, vol: 9 }], G, [null, "", undefined]).taken), ["X"], "a null in the book excludes nothing: a record sealed with venue_event_key null blocks only its own market (v1.6)");
eq(ids(poolOnePerEvent(ladder, G).taken.slice(0, 2)), ["FED-H0", "SEN-ME-D"], "the caller takes the first N of the walk");
eq(poolOnePerEvent([], G), { taken: [], skipped: [] }, "an empty candidate list is an empty pool, not an error");
{ let threw = ""; try { poolOnePerEvent([{ id: "bad", ev: "E", vol: NaN }], G); } catch (e) { threw = (e as Error).message; }
  eq(threw.includes("bad") && threw.includes("cannot be ranked"), true, "a candidate with no finite volume throws, naming itself: it is never ranked as zero"); }
eq([normEventKey("  KXFEDDECISION-26SEP "), normEventKey(""), normEventKey("   "), normEventKey(null), normEventKey(undefined), normEventKey(0)], ["kxfeddecision-26sep", null, null, null, null, null], "normEventKey: trimmed, lower-cased, and null for anything that is not a non-empty string");

{ // The sealed pool day. top + next are the ten highest-volume admitted markets per venue, already past the book as it then stood.
  type Disc = { id: string; venue_event_key: string | null; volume_1d: number };
  const day = JSON.parse(readFileSync("tests/q3/discovery/2026-09-14.json", "utf8")) as { pool: Record<string, { top: Disc[]; next: Disc[] }> };
  const D = { id: (r: Disc) => r.id, event: (r: Disc) => r.venue_event_key, volume: (r: Disc) => r.volume_1d };
  const distinct = (rs: Disc[]) => new Set(rs.map(r => normEventKey(r.venue_event_key))).size;
  const expect: Record<string, { events: string[]; collapsed: number }> = {
    kalshi: { events: ["KXFEDDECISION-26SEP", "KXBALANCEPOWERCOMBO-27FEB", "CONTROLS-2026", "KXCRYPTOSTRUCTURE-26JAN", "SENATETX-26"], collapsed: 5 },
    polymarket: { events: ["fed-decision-in-september-762", "clarity-act-signed-into-law-in-2026", "will-the-us-invade-iran-before-2027", "which-party-will-gain-most-seats-in-russian-parliamentary-election", "what-price-will-wti-hit-in-september-2026"], collapsed: 4 },
  };
  for (const venue of ["kalshi", "polymarket"]) {
    const ten = [...day.pool[venue].top, ...day.pool[venue].next];
    eq([day.pool[venue].top.length, day.pool[venue].next.length, ten.every(r => typeof r.venue_event_key === "string" && r.venue_event_key !== "")], [5, 5, true], `2026-09-14 ${venue}: the file holds a top five and a next five, each with the venue's event id`);
    eq(ids(ten as unknown as Row[]), ids([...ten].sort((a, b) => b.volume_1d - a.volume_1d) as unknown as Row[]), `2026-09-14 ${venue}: the saved order is the volume ranking`);
    eq(distinct(day.pool[venue].top), 2, `2026-09-14 ${venue}: as selected (top five markets) the pool covered 2 venue events`);
    const w = poolOnePerEvent(ten, D);
    eq(w.taken.slice(0, 5).map(r => ten.indexOf(r) + 1), [1, 5, 7, 8, 9], `2026-09-14 ${venue}: under v1.15 the pool is ranks 1, 5, 7, 8, 9`);
    eq(w.taken.slice(0, 5).map(r => r.venue_event_key), expect[venue].events, `2026-09-14 ${venue}: …five venue events, these five`);
    eq([w.skipped.length, w.skipped.every(s => s.reason === "same_event")], [expect[venue].collapsed, true], `2026-09-14 ${venue}: ${expect[venue].collapsed} of the ten are lower-ranked strikes of an event already taken`);
  }
  // Rule 2 against the book as it stands: both of each venue's sealed events leave the list, every strike of them.
  const book = (JSON.parse(readFileSync("tests/q3/records/2026-09-14.json", "utf8")) as { deviated?: unknown; market: { venue: string }; venue_event_key: string | null }[]).filter(r => r.deviated !== true);
  const booked = (venue: string) => [...new Set(book.filter(r => r.market.venue === venue).map(r => r.venue_event_key))];
  eq([booked("kalshi"), booked("polymarket")], [["KXFEDDECISION-26SEP", "KXBALANCEPOWERCOMBO-27FEB"], ["fed-decision-in-september-762", "clarity-act-signed-into-law-in-2026"]], "the ten sealed pool records carry two venue events per venue");
  const k = poolOnePerEvent([...day.pool.kalshi.top, ...day.pool.kalshi.next], D, booked("kalshi"));
  eq(k.taken.map(r => r.id), ["CONTROLS-2026-D", "KXCRYPTOSTRUCTURE-26JAN-27", "SENATETX-26-D"], "rule 2 on that list today: only events with no record remain, one market each");
  eq(k.skipped.filter(s => s.reason === "event_in_book").length, 6, "…and the six markets of the two booked Kalshi events are each skipped as event_in_book");
}

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
  if (!oracle) {
    // Not a pass, and deliberately NOT counted as one: the oracle found nothing to judge. Counting it would inflate
    // the pass total with an assertion that never ran, which is the very thing this block exists to prevent.
    unexercised++;
    console.log(`  NOT EXERCISED  ${markets} live markets over ${pages} page(s), 0 matched ${RECURRENCE_SLUG_ORACLE} — the oracle is`);
    console.log(`                 empty on this venue read, so this assertion proved nothing. It is exercised against`);
    console.log(`                 market_details.polymarket_link at republish, where the pattern's rows actually live.`);
    console.log(`                 These ladders are short-lived by nature — 3 matched at 04:29Z on 2026-09-10 and none`);
    console.log(`                 3h later — so an empty read here is expected, not a defect.`);
    return;
  }
  ran++;
  if (violations) { fails++; console.log(`  FAIL ${violations}/${oracle} oracle market(s) survived the duration rule`); }
  else console.log(`  ok  ${oracle}/${oracle} oracle market(s) of ${markets} live excluded by the duration rule`);
}

live().then(() => {
  const tail = unexercised ? ` · ${unexercised} NOT EXERCISED (see above — not counted as passing)` : "";
  console.log(fails ? `POOL MATCHER · ${fails}/${ran} FAILED${tail}` : `POOL MATCHER · ${ran}/${ran} assertions pass${tail}`);
  process.exit(fails ? 1 : 0);
});
