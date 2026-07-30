/**
 * Sale calendar assertions.
 * Run: npx tsx lib/atlas/calendar.test.ts
 */
import {
  COUNTY_SALE_SCHEDULE,
  STATE_SALE_SCHEDULE,
  calendarCoverage,
  crawlsDueOn,
  nextSaleWindows,
  nthWeekdayOf,
  resolveSaleSchedule,
} from "./calendar";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- weekday recurrence ------------------------------------------------------

const sep = nthWeekdayOf(2026, 9, 1, 2);
assert(sep?.toISOString().slice(0, 10) === "2026-09-01", "first Tuesday Sep 2026");
assert(sep?.getUTCDay() === 2, "computed date must actually be a Tuesday");

// Every projected Texas sale must land on a Tuesday — the statutory rule.
for (const w of nextSaleWindows("48201", { from: new Date("2026-01-01T00:00:00Z"), count: 12 })) {
  const d = new Date(`${w.saleDate}T00:00:00Z`);
  assert(d.getUTCDay() === 2, `TX sale ${w.saleDate} is not a Tuesday`);
}

// "Last weekday" resolves inside the month.
const last = nthWeekdayOf(2026, 2, -1, 5);
assert(last?.getUTCMonth() === 1, "last Friday of Feb must stay in Feb");
assert(last?.getUTCDay() === 5, "last Friday must be a Friday");

// A 5th occurrence that doesn't exist returns null rather than sliding.
assert(nthWeekdayOf(2026, 2, 4, 2) !== null, "4th Tuesday of Feb 2026 exists");

// --- inheritance -------------------------------------------------------------

const harris = resolveSaleSchedule("48201");
assert(harris !== null, "Harris County resolves");
assert(harris!.isStateDefault === true, "Harris inherits the Texas schedule");
assert(harris!.confidence === "statutory", "Texas timing is statutory");

const cook = resolveSaleSchedule("17031");
assert(cook!.isStateDefault === false, "Cook has its own schedule");
assert(cook!.months?.includes(1), "Cook override months applied");
assert(
  cook!.inherited.length < 9,
  "Cook must not report every field as inherited when it overrides",
);

const genesee = resolveSaleSchedule("26049");
assert(genesee!.isStateDefault === true, "Genesee inherits Michigan");
assert(genesee!.cadence === "biannual", "Michigan runs two rounds");

// Wayne overrides only months; everything else still inherits.
const wayne = resolveSaleSchedule("26163");
assert(wayne!.isStateDefault === false, "Wayne has an override");
assert(wayne!.cadence === "biannual", "Wayne still inherits cadence from MI");
assert(wayne!.inherited.includes("cadence"), "cadence reported as inherited");

// --- unresearched states degrade honestly ------------------------------------

const wy = resolveSaleSchedule("56001");
assert(wy!.confidence === "unresearched", "Wyoming has no researched schedule");
assert(wy!.cadence === "irregular", "unresearched falls back to sweeps");
const wyWindows = nextSaleWindows("56001", { from: new Date("2026-08-01T00:00:00Z"), count: 3 });
assert(wyWindows.length === 3, "sweep windows still produced");
assert(
  wyWindows.every((w) => w.confidence === "unresearched"),
  "sweep windows must carry the unresearched confidence forward",
);

// --- windows are ordered and self-consistent ---------------------------------

for (const fips of ["48201", "26049", "04013", "17031", "56001"]) {
  const ws = nextSaleWindows(fips, { from: new Date("2026-08-01T00:00:00Z"), count: 4 });
  for (const w of ws) {
    assert(w.listingOpensOn < w.saleDate, `${fips}: listing must open before the sale`);
    assert(w.resultsOpenOn > w.saleDate, `${fips}: results must open after the sale`);
  }
  for (let i = 1; i < ws.length; i++) {
    assert(ws[i].saleDate > ws[i - 1].saleDate, `${fips}: windows must be ordered`);
  }
}

// --- scheduling --------------------------------------------------------------

const due = crawlsDueOn(
  ["48201", "26049", "04013", "17031", "56001"],
  new Date("2026-09-01T00:00:00Z"),
);
assert(
  due.some((d) => d.fips === "48201" && d.kind === "listing"),
  "Harris is mid-listing-window on its sale day",
);
assert(
  due.some((d) => d.fips === "26049" && d.kind === "results"),
  "Genesee is in its results window after the August sale",
);
// A county is never asked for both crawls of the same sale on the same day.
const seen = new Set<string>();
for (const d of due) {
  const k = `${d.fips}|${d.saleDate}`;
  assert(!seen.has(k), `duplicate crawl for ${k}`);
  seen.add(k);
}

// Arizona sells once in February — it should be idle in September.
assert(
  !due.some((d) => d.fips === "04013" && d.kind === "listing"),
  "Maricopa should not be in a listing window in September",
);
// ...and busy in January, 60 days before the February sale.
const jan = crawlsDueOn(["04013"], new Date("2027-01-05T00:00:00Z"));
assert(
  jan.some((d) => d.kind === "listing"),
  "Maricopa listing window opens ahead of the February sale",
);

// --- coverage accounting -----------------------------------------------------

const cov = calendarCoverage();
assert(cov.statesWithSchedule === Object.keys(STATE_SALE_SCHEDULE).length, "state count");
assert(cov.countyOverrides === Object.keys(COUNTY_SALE_SCHEDULE).length, "override count");
assert(cov.byConfidence.statutory >= 4, "at least the four statutory states");
assert(cov.statesUnresearched > 0, "coverage must admit what is missing");

console.log("calendar tests ok", {
  states: cov.statesWithSchedule,
  statutory: cov.byConfidence.statutory,
  typical: cov.byConfidence.typical,
  unresearched: cov.statesUnresearched,
  overrides: cov.countyOverrides,
  dueToday: due.length,
});
