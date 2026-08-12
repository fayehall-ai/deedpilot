/**
 * The Georgia adapter's date reading.
 * Run: npx tsx lib/ingest/georgia.test.ts
 *
 * The failure this guards against is specific and has already happened: the
 * adapter projected the next first Tuesday for every county, which put Cobb
 * under a 2026-09-01 sale that does not exist — Cobb's own page names May 5
 * and November 3. Only `saleDateConfirmed: false` kept 2,825 delinquent
 * taxpayers off the calendar. These tests pin the rules that let a date be
 * called confirmed.
 */
import * as cheerio from "cheerio";
import {
  GA_COUNTIES,
  NO_SALE_MARKER,
  isFirstTuesday,
  nextFirstTuesday,
  parseSaleDates,
} from "./adapters/georgia";
import { classifyListingLink, parseHtmlTable } from "./parse";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg}\n    expected ${e}\n    actual   ${a}`);
}

const TODAY = "2026-08-12";

// --- the statutory sale day --------------------------------------------------

// Verified against the calendar: each is a Tuesday falling on or before the
// 7th, so each is the first Tuesday of its month.
for (const d of ["2026-05-05", "2026-09-01", "2026-10-06", "2026-11-03", "2026-12-01"]) {
  assert(isFirstTuesday(d), `${d} is the statutory sale day`);
}
assert(!isFirstTuesday("2026-09-08"), "a second Tuesday is not the sale day");
assert(!isFirstTuesday("2026-09-02"), "the first Wednesday is not the sale day");
assert(!isFirstTuesday("2026-09-07"), "the first Monday is not the sale day");
assert(!isFirstTuesday("not-a-date"), "a malformed date is rejected, not thrown on");

// --- reading dates a county actually published -------------------------------

eq(
  parseSaleDates("The next tax sale will be held November 3, 2026 on the courthouse steps.", [], TODAY).upcoming,
  ["2026-11-03"],
  "reads a date named in the page text",
);

eq(
  parseSaleDates("Upcoming sales: October 6, 2026 and December 1, 2026.", [], TODAY).upcoming,
  ["2026-10-06", "2026-12-01"],
  "keeps every future sale a county names",
);

// Cobb's real page carries both 2026 dates; one has already passed.
eq(
  parseSaleDates("2026 tax sales: May 5, 2026 and November 3, 2026.", [], TODAY).upcoming,
  ["2026-11-03"],
  "drops a sale that has already happened",
);

// Registration deadlines and payment dates are named exactly like sale dates.
eq(
  parseSaleDates("Register by August 25, 2026. Payment is due September 15, 2026.", [], TODAY).upcoming,
  [],
  "drops dates that are not the statutory sale day",
);

// Hall County names the date nowhere but the filename, and omits the year.
eq(
  parseSaleDates("", ["September-1-Website-Tax-Sale-List-1.pdf"], TODAY).upcoming,
  ["2026-09-01"],
  "resolves a year-less filename against the statute",
);

// `Carroll-July-2026-Legals-3.pdf` must not read 2026 as the twentieth of July.
eq(
  parseSaleDates("", ["Carroll-July-2026-Legals-3.pdf"], TODAY).upcoming,
  [],
  "does not read a year as a day of the month",
);

eq(
  parseSaleDates("", ["Sheriffs-September-1-2026-Levy-Sale--1st-Posting.pdf"], TODAY).upcoming,
  ["2026-09-01"],
  "reads month, day and year out of a filename",
);

// "the first Tuesday in March" is a rule, not a scheduled sale.
eq(
  parseSaleDates("Sales are held the first Tuesday in March 3", [], TODAY).upcoming,
  [],
  "ignores a year-less month and day in prose",
);

eq(
  parseSaleDates("The September 1, 2026 sale", ["Tax-Sale-List-September-1-2026.pdf"], TODAY).upcoming,
  ["2026-09-01"],
  "de-duplicates a date named in both the page and the filename",
);

// --- a list left up after its sale -------------------------------------------

// Douglas still shows the June 2 list and Columbia the August 4 one. Both are
// over. The dates must be reported as past, not merely dropped, so the caller
// can tell "this county has no upcoming sale" from "this county names no
// dates at all" — the first must not get a projected window hung off it.
eq(
  parseSaleDates("the first Tuesday in June, 2026, the same being June 2, 2026", [], TODAY),
  { upcoming: [], past: ["2026-06-02"] },
  "reports Douglas's finished sale as past",
);
eq(
  parseSaleDates("Next Tax Sale for Columbia County scheduled for August 4, 2026 at 10:00am", [], TODAY),
  { upcoming: [], past: ["2026-08-04"] },
  "reports Columbia's finished sale as past",
);
// A county naming nothing at all is a different case: it still gets crawled.
eq(
  parseSaleDates("Tax sales are held on the courthouse steps.", [], TODAY),
  { upcoming: [], past: [] },
  "a county naming no dates yields neither upcoming nor past",
);
// A past date that is not a first Tuesday is not a sale at all.
eq(
  parseSaleDates("Applications closed January 5, 2024.", [], TODAY),
  { upcoming: [], past: [] },
  "a past non-sale-day date is not counted as a finished sale",
);

// --- the county saying the listing is empty ----------------------------------

assert(
  NO_SALE_MARKER.test("Tax Sale List August 2026 Tax Sale List (No Tax Sale)"),
  "catches Chatham's in-place annotation",
);
assert(
  NO_SALE_MARKER.test("Judicial Tax Sale List (No Sale Scheduled)"),
  "catches Chatham's judicial-sale annotation",
);
// A county explaining the rule still has a sale.
assert(
  !NO_SALE_MARKER.test("If there is no tax sale in a given month, check back later."),
  "does not fire on prose about there being no sale",
);

// --- the projected fallback --------------------------------------------------

assert(
  isFirstTuesday(nextFirstTuesday(new Date("2026-08-12T00:00:00Z"))),
  "the projected fallback still satisfies the statute",
);

// --- Georgia's link vocabulary -----------------------------------------------

// O.C.G.A. calls it a levy: the sheriff levies, then sells. Nothing in the
// vocabulary matched that, so Fulton's list classified only by the accident of
// a sibling anchor sharing its href.
eq(
  classifyListingLink("Sheriff's September 1, 2026, Levy Sale."),
  "sale_list",
  "reads a levy sale as a sale list",
);

// Cobb and Douglas both sorted their booklet first, and the adapter opens only
// three documents — a booklet at the top can crowd out the real list.
eq(classifyListingLink("Tax Sale Booklet_V1.gov.pdf"), "unknown", "demotes Cobb's booklet");
eq(classifyListingLink("Tax_Sale_Process_Booklet.pdf"), "unknown", "demotes Douglas's booklet");
eq(classifyListingLink("Tax-Sale-Flyer.pdf"), "unknown", "demotes DeKalb's flyer");
eq(
  classifyListingLink("2026 Tax Sale List Booklet.pdf"),
  "sale_list",
  "keeps a booklet that is also a list",
);
eq(
  classifyListingLink("Delinquent Levy List"),
  "delinquent_list",
  "still separates a levy list from a levy sale",
);

// --- a header row marked up with <td> ----------------------------------------

// Columbia County GA's shape, reduced. Twenty parcels were invisible because
// the header row is <td> and the reader required <th>.
const columbia = `<table>
  <tr><td>Parcel</td><td>CRH</td><td>DIF</td><td>Years</td><td>Amount Due</td></tr>
  <tr><td>006 176</td><td>Covington, Valerie M.</td><td>Covington, Valerie M.</td><td>2025, 2024</td><td>$2,564.03</td></tr>
  <tr><td>007 001</td><td>Smith, John</td><td>Smith, John</td><td>2025</td><td>$1,100.00</td></tr>
</table>`;
const rows = parseHtmlTable(cheerio.load(columbia), "https://example.gov/list");
assert(rows !== null && rows.length === 2, `reads the parcels (got ${rows?.length ?? "null"})`);
assert(
  !rows!.some((r) => r.parcelNumber === "Parcel"),
  "does not ingest the header row as a parcel",
);
eq(rows![0].parcelNumber, "006 176", "reads the parcel number");
eq(rows![0].ownerName, "Covington, Valerie M.", "maps Georgia's CRH abbreviation to the owner");

// Douglas County's shape. "Defendant in Fi-Fa" reads "SAME AS CRH(S)" on most
// rows, so matching `defendant` before `record holder` filled the owner field
// with that string for 172 parcels.
const douglas = `<table>
  <tr><th>Map and Parcel</th><th>Current Record Holder</th><th>Defendant in Fi-Fa</th><th>Amount Due</th></tr>
  <tr><td>00300250045</td><td>ABDUL-HAQQ NAJIB &amp; AISHAH</td><td>SAME AS CRH(S)</td><td>$3,488.66</td></tr>
</table>`;
const dRows = parseHtmlTable(cheerio.load(douglas), "https://example.gov/list");
eq(dRows![0].ownerName, "ABDUL-HAQQ NAJIB & AISHAH", "prefers the record holder over the fi-fa defendant");

const withTh = `<table>
  <tr><th>Parcel</th><th>Owner</th></tr>
  <tr><td>111</td><td>Alice</td></tr>
</table>`;
const thRows = parseHtmlTable(cheerio.load(withTh), "https://example.gov/list");
assert(thRows !== null && thRows.length === 1, "still prefers <th> when a table has it");
eq(thRows![0].ownerName, "Alice", "<th> path is unchanged");

// --- registry invariants -----------------------------------------------------

const names = GA_COUNTIES.map((c) => c.name);
eq(new Set(names).size, names.length, "no duplicate counties in GA_COUNTIES");

// A `listPdf` without a `listKind` is the Cobb failure waiting to recur: a
// delinquent roll served as bidding inventory.
for (const c of GA_COUNTIES) {
  if (c.listPdf) assert(c.listKind !== undefined, `${c.name} declares what its listPdf is`);
}

console.log(`georgia.test.ts — ${passed} assertions passed`);
