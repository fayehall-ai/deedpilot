/**
 * Row translation.
 * Run: npx tsx lib/import/auction-rows.test.ts
 *
 * Two properties dominate here. First, an unrecognised sale type is rejected
 * rather than defaulted — it selects the redemption model, so a wrong one
 * produces confident numbers under the wrong body of law. Second, nothing is
 * invented: a blank cell stays null so the enrichment worklist can see it.
 */
import { readRow, derivePlatform, parseSaleDate, type RowSource } from "./auction-rows";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

/** A row built from a plain object, matching what CsvTable hands over. */
function src(cells: Record<string, string>): RowSource {
  return { cell: (n) => cells[n] ?? "", all: () => cells };
}

const FULL = {
  State: "Mississippi",
  County: "Hinds County",
  "Sale Date": "2026-08-31",
  "Sale Time": "08:30 AM",
  "Auction Type": "Lien",
  "Online or Onsite": "Online",
  "Parcel Count": "16062",
  "Aggregate Sale Amount (USD)": "21728520.27",
  "Online Site (Lien)": "www.govease.com",
  "Additional Sale Notes": "District 1",
  "Auction ID": "98131",
  "Auction URL": "https://uls.ustla.com/research/auctions/98131",
};

// ---------------------------------------------------------------------------
// A complete row
// ---------------------------------------------------------------------------

const ok = readRow(src(FULL), 2);
assert(ok.ok, "a complete row translates");
if (ok.ok) {
  const a = ok.value;
  assert(a.externalId === "ustla:98131", "the id is namespaced so it cannot collide with an adapter's");
  assert(a.saleType === "Tax Lien", "Lien becomes Tax Lien");
  assert(a.platform === "govease", "the platform comes from the published sale site");
  assert(a.saleDate === "2026-08-31", "the date passes through as ISO");
  assert(a.announcedParcelCount === 16062, "the parcel count is read");
  assert(a.aggregateSaleAmount === "21728520.27", "money stays a string");
  assert(typeof a.aggregateSaleAmount === "string", "and is never a number");
  assert(a.title === "District 1", "the county's note becomes the title that separates same-day sales");
  assert(a.raw["Auction ID"] === "98131", "the source row is kept whole");
}

// ---------------------------------------------------------------------------
// Sale type is rejected, never defaulted
// ---------------------------------------------------------------------------

const types: [string, string][] = [
  ["Lien", "Tax Lien"],
  ["Deed", "Tax Deed"],
  ["Redeemable Deed", "Redeemable Deed"],
  ["  redeemable deed  ", "Redeemable Deed"],
  ["Hybrid", "Hybrid"],
];
for (const [input, expected] of types) {
  const r = readRow(src({ ...FULL, "Auction Type": input }), 2);
  assert(r.ok && r.value.saleType === expected, `"${input}" maps to ${expected}`);
}

const badType = readRow(src({ ...FULL, "Auction Type": "Sheriff Sale" }), 7);
assert(!badType.ok, "an unknown sale type is rejected");
assert(!badType.ok && badType.line === 7, "and the row's line number is reported");
assert(!badType.ok && badType.problem.includes("Sheriff Sale"), "and the offending value is quoted back");

// ---------------------------------------------------------------------------
// Required columns
// ---------------------------------------------------------------------------

for (const missing of ["Auction ID", "State", "County"]) {
  const r = readRow(src({ ...FULL, [missing]: "" }), 3);
  assert(!r.ok, `a row with no ${missing} is rejected`);
}
const badDate = readRow(src({ ...FULL, "Sale Date": "next Tuesday" }), 4);
assert(!badDate.ok, "an unreadable date is rejected rather than guessed");

// ---------------------------------------------------------------------------
// Blanks stay blank
// ---------------------------------------------------------------------------

const sparse = readRow(
  src({
    State: "Missouri",
    County: "Adair County",
    "Sale Date": "2026-09-14",
    "Auction Type": "Deed",
    "Auction ID": "12345",
  }),
  5,
);
assert(sparse.ok, "a row with only the required columns still imports");
if (sparse.ok) {
  const a = sparse.value;
  assert(a.startTime === null, "an absent start time is null, not a default");
  assert(a.announcedParcelCount === null, "an absent parcel count is null, not 0");
  assert(a.aggregateSaleAmount === null, "an absent amount is null, not \"0\"");
  assert(a.title === null, "an absent note is null");
  assert(
    a.sourceUrl === "https://uls.ustla.com/research/auctions/12345",
    "a missing URL is reconstructed from the id, since the column is NOT NULL",
  );
  assert(a.platform === "in_person", "with no site and no venue, the floor is in_person");
}

// ---------------------------------------------------------------------------
// A title has to work as a label
//
// New Jersey publishes a form dump in the notes column on every row — sixty-nine
// characters identical down the whole state, which distinguishes nothing and
// pushes the municipality out of a calendar cell. A short note is a label; a
// long one is prose, and prose belongs on the detail page.
// ---------------------------------------------------------------------------

const shortNote = readRow(src({ ...FULL, "Additional Sale Notes": "District 2" }), 8);
assert(shortNote.ok && shortNote.value.title === "District 2", "a short note is a title");

const NJ_BOILERPLATE =
  "Sale Type: Standard Year Type: Calendar YEP: Yes Additional Comments:";
const longNote = readRow(src({ ...FULL, "Additional Sale Notes": NJ_BOILERPLATE }), 9);
assert(longNote.ok && longNote.value.title === null, "a form dump is not a title");
assert(
  longNote.ok && longNote.value.raw["Additional Sale Notes"] === NJ_BOILERPLATE,
  "and is not lost — it stays in the source row for the auction page to show",
);

const exactly60 = "x".repeat(60);
assert(
  readRow(src({ ...FULL, "Additional Sale Notes": exactly60 }), 10).ok &&
    (readRow(src({ ...FULL, "Additional Sale Notes": exactly60 }), 10) as { value: { title: string | null } }).value
      .title === exactly60,
  "the cap is inclusive",
);

// ---------------------------------------------------------------------------
// Platform derivation
// ---------------------------------------------------------------------------

assert(derivePlatform("www.govease.com", "Online") === "govease", "govease by host");
assert(derivePlatform("https://miami.realtaxdeed.com", "Online") === "realtaxdeed", "realtaxdeed by host");
assert(
  derivePlatform("https://x.realforeclose.com", "Online") === "realforeclose",
  "realforeclose is a different product from realtaxdeed and must not collapse into it",
);
assert(derivePlatform("bid4assets.com/x", "Online") === "bid4assets", "bid4assets by host");
assert(
  derivePlatform("https://county-of-nowhere.gov/sales", "Online") === "county_site",
  "an unrecognised online host is the county's own portal, not a guessed vendor",
);
assert(derivePlatform(null, "Live") === "in_person", "a live sale with no site is in person");
assert(derivePlatform(null, "Simulcast") === "county_site", "simulcast counts as online");
assert(derivePlatform(null, "Sealed Bid") === "county_site", "so does sealed bid");

/*
 * A deed sale must read the deed column even when a lien column is also
 * present: a county running both lists a different host for each, and reading
 * the wrong one files the sale against the wrong platform.
 */
const deedRow = readRow(
  src({
    ...FULL,
    "Auction Type": "Deed",
    "Online Site (Lien)": "www.govease.com",
    "Online Site (Deed)": "www.bid4assets.com",
  }),
  6,
);
assert(deedRow.ok && deedRow.value.platform === "bid4assets", "a deed sale reads the deed site");

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

assert(parseSaleDate("2026-08-31") === "2026-08-31", "ISO passes through");
assert(parseSaleDate("8/31/2026") === "2026-08-31", "a spreadsheet round-trip is read");
assert(parseSaleDate("08/05/2026") === "2026-08-05", "zero-padded US format too");
assert(parseSaleDate("2026-02-30") === null, "a date that does not exist is rejected, not rolled forward");
assert(parseSaleDate("") === null, "blank is null");
assert(parseSaleDate("31/08/2026") === null, "an out-of-range month is rejected");

console.log(`auction-rows.test.ts — ${passed} assertions passed`);
