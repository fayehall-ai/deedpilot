/**
 * Calendar grid + filter-encoding assertions.
 * Run: npx tsx lib/calendar/grid.test.ts
 */
import {
  calendarHref,
  distinguishingLabels,
  groupSalesByCounty,
  gridRange,
  hasActiveFilters,
  monthBounds,
  monthGrid,
  monthLabel,
  parseCalendarFilters,
  parseMonth,
  shiftMonth,
  toggle,
  todayIso,
} from "./grid";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- month arithmetic --------------------------------------------------------

assert(shiftMonth("2026-08", 1) === "2026-09", "next month");
assert(shiftMonth("2026-12", 1) === "2027-01", "year rolls forward");
assert(shiftMonth("2026-01", -1) === "2025-12", "year rolls backward");
assert(shiftMonth("2026-08", -14) === "2025-06", "multi-year shift");
assert(shiftMonth("2026-08", 0) === "2026-08", "zero shift is identity");

assert(monthLabel("2026-09") === "September 2026", "month label");
assert(monthBounds("2026-02").last === "2026-02-28", "Feb 2026 ends on the 28th");
assert(monthBounds("2024-02").last === "2024-02-29", "leap February");
assert(monthBounds("2026-09").first === "2026-09-01", "month starts on the 1st");

// --- parsing is strict -------------------------------------------------------

assert(parseMonth("2026-09", "2026-08") === "2026-09", "valid month accepted");
assert(parseMonth("lol", "2026-08") === "2026-08", "garbage falls back");
assert(parseMonth("2026-13", "2026-08") === "2026-08", "month 13 rejected");
assert(parseMonth("2026-00", "2026-08") === "2026-08", "month 00 rejected");
assert(parseMonth("2026-9", "2026-08") === "2026-08", "unpadded month rejected");
assert(parseMonth(undefined, "2026-08") === "2026-08", "missing falls back");

// --- grid geometry -----------------------------------------------------------

// Aug 2026: the 1st is a Saturday, the 31st a Monday. The grid must therefore
// open on Sun Jul 26 and close on Sat Sep 5.
const augRange = gridRange("2026-08");
assert(augRange.start === "2026-07-26", `Aug grid starts Sun Jul 26, got ${augRange.start}`);
assert(augRange.end === "2026-09-05", `Aug grid ends Sat Sep 5, got ${augRange.end}`);

const aug = monthGrid("2026-08", "2026-08-09");
assert(aug.length === 6, `Aug 2026 needs 6 rows, got ${aug.length}`);
for (const week of aug) assert(week.length === 7, "every week has 7 days");

// Days are contiguous, ascending, and never skip or repeat.
const flat = aug.flat();
assert(flat.length === 42, "6 weeks = 42 cells");
for (let i = 1; i < flat.length; i++) {
  const prev = Date.parse(`${flat[i - 1].iso}T00:00:00Z`);
  const cur = Date.parse(`${flat[i].iso}T00:00:00Z`);
  assert(cur - prev === 86_400_000, `cells ${flat[i - 1].iso} → ${flat[i].iso} are not consecutive`);
}

// Every row starts on a Sunday.
for (const week of aug) {
  assert(new Date(`${week[0].iso}T00:00:00Z`).getUTCDay() === 0, `${week[0].iso} is not a Sunday`);
}

// inMonth marks exactly the 31 days of August.
assert(flat.filter((d) => d.inMonth).length === 31, "August has 31 in-month cells");
assert(flat.find((d) => d.iso === "2026-07-31")?.inMonth === false, "Jul 31 is spillover");
assert(flat.find((d) => d.iso === "2026-09-01")?.inMonth === false, "Sep 1 is spillover");

// Sep 1 2026 is the single busiest sale day in the data and is a spillover cell
// of the August grid — the reason spillover squares are queried at all.
assert(flat.some((d) => d.iso === "2026-09-01"), "August grid must reach Sep 1");

// The day-number label comes from the UTC date, not the viewer's zone.
assert(flat.find((d) => d.iso === "2026-08-11")?.dayOfMonth === 11, "Aug 11 renders as 11");

// Today, and only today, is flagged.
assert(flat.filter((d) => d.isToday).length === 1, "exactly one cell is today");
assert(flat.find((d) => d.isToday)?.iso === "2026-08-09", "today is the 9th");
// A month that does not contain today flags nothing.
assert(monthGrid("2027-03", "2026-08-09").flat().every((d) => !d.isToday), "no today elsewhere");

// Weekends: tax sales are weekday events, so the shading must be right.
assert(flat.find((d) => d.iso === "2026-08-11")?.isWeekend === false, "Tue Aug 11 is a weekday");
assert(flat.find((d) => d.iso === "2026-08-15")?.isWeekend === true, "Sat Aug 15 is a weekend");
assert(flat.find((d) => d.iso === "2026-08-16")?.isWeekend === true, "Sun Aug 16 is a weekend");

// The degenerate month: Feb 2026 starts on a Sunday and ends on a Saturday, so
// it is exactly 4 rows with no spillover at all. A grid hardcoded to 5 or 6
// rows renders a week of March here and calls it February.
const feb = monthGrid("2026-02", "2026-08-09");
assert(feb[0][0].iso === "2026-02-01", "Feb 2026 grid opens on the 1st");
assert(feb.length === 4, `Feb 2026 fits exactly 4 rows, got ${feb.length}`);
assert(feb.flat().every((d) => d.inMonth), "Feb 2026 has no spillover cells");

// And the opposite extreme: a 31-day month starting Saturday needs 6 rows.
assert(monthGrid("2026-08", "2026-08-09").length === 6, "Aug 2026 needs 6 rows");

// --- filter parsing ----------------------------------------------------------

const today = "2026-08-09";
const empty = parseCalendarFilters({}, today);
assert(empty.month === "2026-08", "defaults to the current month");
assert(empty.currentMonth === "2026-08", "current month recorded");
assert(!hasActiveFilters(empty), "no filters by default");
assert(empty.includeLeads === false, "leads are off unless asked for");

const f = parseCalendarFilters(
  { m: "2026-09", state: "mi,tx", type: "deed,redeemable", platform: "lgbs", leads: "1" },
  today,
);
assert(f.states.join(",") === "MI,TX", `states uppercased+sorted, got ${f.states}`);
assert(f.saleTypes.join("|") === "Tax Deed|Redeemable Deed", `type slugs decoded, got ${f.saleTypes}`);
assert(f.platforms.join(",") === "lgbs", "platform kept");
assert(f.includeLeads === true, "leads=1 turns leads on");
assert(hasActiveFilters(f), "filters detected as active");

// Junk in the query string must not reach SQL as a state or a platform.
const junk = parseCalendarFilters(
  { state: "MI,XXX,1,,'; drop table auctions--", type: "nonsense", platform: "DROP TABLE" },
  today,
);
assert(junk.states.join(",") === "MI", `only real 2-letter codes survive, got ${junk.states}`);
assert(junk.saleTypes.length === 0, "unknown type slug dropped");
assert(junk.platforms.length === 0, "platform with spaces/caps dropped");

// Repeated params (?state=MI&state=TX) and duplicates collapse.
const repeated = parseCalendarFilters({ state: ["MI", "TX,MI"] }, today);
assert(repeated.states.join(",") === "MI,TX", `repeats dedupe, got ${repeated.states}`);

// `leads` only accepts the exact opt-in.
assert(parseCalendarFilters({ leads: "0" }, today).includeLeads === false, "leads=0 is off");
assert(parseCalendarFilters({ leads: "true" }, today).includeLeads === false, "leads=true is off");

// --- href round-tripping -----------------------------------------------------

assert(calendarHref(empty) === "/calendar", "clean URL when nothing is set");
assert(
  calendarHref(empty, { month: "2026-09" }) === "/calendar?m=2026-09",
  `month added, got ${calendarHref(empty, { month: "2026-09" })}`,
);

// The whole point of the filter encoding: changing month keeps the filters.
const nextMonth = calendarHref(f, { month: shiftMonth(f.month, 1) });
const reparsed = parseCalendarFilters(
  Object.fromEntries(new URLSearchParams(nextMonth.split("?")[1] ?? "")),
  today,
);
assert(reparsed.month === "2026-10", "month advanced");
assert(reparsed.states.join(",") === "MI,TX", "states survived the month change");
assert(reparsed.saleTypes.length === 2, "sale types survived the month change");
assert(reparsed.platforms.join(",") === "lgbs", "platform survived the month change");
assert(reparsed.includeLeads === true, "leads survived the month change");

// Toggling a chip off and back on returns to the same URL — no drift from
// ordering, which would otherwise make "active" highlighting wrong.
const withoutMi = calendarHref(f, { states: toggle(f.states, "MI") });
const backAgain = calendarHref(f, { states: toggle(toggle(f.states, "MI"), "MI") });
assert(!withoutMi.includes("MI"), "toggling MI off removes it");
assert(backAgain === calendarHref(f), `toggle round-trip is stable, got ${backAgain}`);

// Returning to the current month drops `m` rather than pinning it, so a URL
// shared today still opens on "now" when someone follows it next month.
const backToNow = new URLSearchParams(
  calendarHref(f, { month: "2026-08" }).split("?")[1] ?? "",
);
assert(!backToNow.has("m"), "current month is implicit in the URL");
assert(backToNow.get("platform") === "lgbs", "…while the other filters stay");

// --- distinguishing labels ---------------------------------------------------

// The real case: Harris County TX sells through eight constable precincts.
const harrisTitles = [1, 2, 3, 4, 5, 6, 7, 8].map((p) => `HARRIS COUNTY tax sale — precinct ${p}`);
const harrisLabels = distinguishingLabels(harrisTitles);
assert(harrisLabels[0] === "precinct 1", `expected "precinct 1", got ${harrisLabels[0]}`);
assert(harrisLabels[7] === "precinct 8", `expected "precinct 8", got ${harrisLabels[7]}`);

// The prefix is cut at the separator, not at the last shared space — otherwise
// the labels degrade to bare digits and stop meaning anything.
assert(
  !harrisLabels.some((l) => l && /^\d+$/.test(l)),
  `labels must stay phrases, got ${JSON.stringify(harrisLabels)}`,
);

// No separator: fall back to a word boundary.
assert(distinguishingLabels(["Sale North", "Sale South"])[1] === "South", "word-boundary fallback");

// Nothing distinguishing → nulls, so the caller shows something else.
assert(distinguishingLabels(["Same", "Same"]).every((l) => l === null), "identical titles → null");
assert(distinguishingLabels([null, null]).every((l) => l === null), "missing titles → null");
assert(distinguishingLabels(["Only one"]).every((l) => l === null), "single title → null");
assert(distinguishingLabels(["", "  "]).every((l) => l === null), "blank titles → null");
// A mix: the untitled member gets null, the others still get labels.
const mixed = distinguishingLabels(["County sale — east", null, "County sale — west"]);
assert(mixed[0] === "east" && mixed[1] === null && mixed[2] === "west", `mixed: ${mixed}`);

// --- grouping ----------------------------------------------------------------

const sale = (o: Partial<Parameters<typeof groupSalesByCounty>[0][number]> = {}) => ({
  countyFips: "48201",
  saleType: "Redeemable Deed",
  listingKind: "sale_list",
  saleDateConfirmed: true,
  lotCount: 10,
  status: "scheduled",
  title: null as string | null,
  ...o,
});

// Harris Aug 4 2026: 8 precinct sales, 135 lots, one of them cancelled.
const harris = harrisTitles.map((title, i) =>
  sale({ title, lotCount: [82, 7, 8, 4, 17, 2, 13, 2][i], status: i === 3 ? "cancelled" : "scheduled" }),
);
const grouped = groupSalesByCounty(harris);
assert(grouped.length === 1, `8 precinct sales collapse to 1 group, got ${grouped.length}`);
assert(grouped[0].sales.length === 8, "the group still holds all 8 sales");
assert(grouped[0].lotTotal === 135, `lot total ${grouped[0].lotTotal}`);
assert(grouped[0].labels[0] === "precinct 1", "group carries precinct labels");
// A cancellation inside a group must survive collapsing — this is the whole
// risk of grouping, and the reason the count is exposed rather than inferred.
assert(grouped[0].cancelledCount === 1, `cancelled count ${grouped[0].cancelledCount}`);
assert(grouped[0].allCancelled === false, "not every precinct is cancelled");

// A single sale is a group of one, so callers have one shape to render.
const single = groupSalesByCounty([sale({ countyFips: "26091", lotCount: 30 })]);
assert(single.length === 1 && single[0].sales.length === 1, "single sale → group of one");
assert(single[0].labels[0] === null, "a lone sale has nothing to distinguish");

// Different counties never merge.
assert(
  groupSalesByCounty([sale({ countyFips: "48201" }), sale({ countyFips: "26091" })]).length === 2,
  "different counties stay separate",
);

// Sale type is part of the key: a group wears one colour dot, so a county
// holding both a deed and a lien sale that day must produce two rows.
assert(
  groupSalesByCounty([sale({ saleType: "Tax Deed" }), sale({ saleType: "Tax Lien" })]).length === 2,
  "different sale types stay separate",
);

// The load-bearing one: a projected or delinquent-roll sale carries a warning
// tag. Folding it into a group of confirmed sales would erase that tag.
assert(
  groupSalesByCounty([sale(), sale({ saleDateConfirmed: false })]).length === 2,
  "a projected sale never merges into a confirmed group",
);
assert(
  groupSalesByCounty([sale(), sale({ listingKind: "delinquent_list" })]).length === 2,
  "a delinquent roll never merges into a sale-list group",
);

// Groups sort by lots, not by member count — seven tiny precinct sales must not
// outrank one big county just by being numerous.
const ranked = groupSalesByCounty([
  ...Array.from({ length: 7 }, () => sale({ countyFips: "48201", lotCount: 2 })),
  sale({ countyFips: "26091", lotCount: 400 }),
]);
assert(ranked[0].lotTotal === 400, `biggest group first, got ${ranked[0].lotTotal}`);
assert(ranked[1].lotTotal === 14, `then the 7×2 group, got ${ranked[1].lotTotal}`);

// Every input sale appears exactly once across the groups — grouping must never
// drop a sale list.
const all = [...harris, sale({ countyFips: "26091" }), sale({ saleType: "Tax Deed" })];
const out = groupSalesByCounty(all).flatMap((g) => g.sales);
assert(out.length === all.length, `${all.length} in, ${out.length} out`);

assert(groupSalesByCounty([]).length === 0, "empty input → no groups");

// --- todayIso ---------------------------------------------------------------

assert(todayIso(new Date("2026-08-09T23:30:00Z")) === "2026-08-09", "UTC day, not local");
assert(/^\d{4}-\d{2}-\d{2}$/.test(todayIso()), "todayIso shape");

console.log("calendar grid: all assertions passed");
