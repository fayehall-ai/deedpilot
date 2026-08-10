/**
 * Missouri collector notice parsing.
 * Run: npx tsx lib/ingest/mo-notice.test.ts
 *
 * Fixtures are verbatim from Franklin County's 2026 notice, captured
 * 2026-08-09. The two assertions that matter are the two things the generic
 * crawler got wrong on this exact document: the sale date, and how many
 * parcels are in it.
 */
import {
  findSaleListPdf,
  parseNotice,
  parseNoticeDate,
  parseNoticeHeader,
} from "./adapters/missouri";
import { judgeLots } from "./judge";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- dates -------------------------------------------------------------------

assert(parseNoticeDate("August 24, 2026") === "2026-08-24", "long date");
assert(parseNoticeDate("March 3, 2027") === "2027-03-03", "single-digit day padded");
assert(parseNoticeDate("Smarch 4, 2026") === null, "bad month rejected");
assert(parseNoticeDate("no date here") === null, "prose rejected");

// --- the header --------------------------------------------------------------

const HEADER = `Task# 236
08-01-2026
17:15:44
NOTICE OF TAX CERTIFICATE SALE
The following is a publication of land, lots, and mining rights in Franklin County upon which Tax Certificates
are to be offered for sale in the Commission Chambers of the County Government Center, 400 E Locust,
Union Mo. 63084. Beginning Monday August 24, 2026 at 10:00:00 and continuing from day to day as
indicated by the following publication by the undersigned according to the provisions of RSMo. 140.`;

const header = parseNoticeHeader(HEADER);

// The whole reason this adapter exists. `nextSaleWindows` projected 2026-08-16
// for this sale; the county says the 24th. Eight days is the difference between
// a bidder being there and not.
assert(header.saleDate === "2026-08-24", `sale date off the notice, got ${header.saleDate}`);
assert(header.saleDate !== "2026-08-16", "must not agree with the projection that was wrong");
assert(header.startTime === "10:00:00", `start time, got ${header.startTime}`);
assert(/Commission Chambers/.test(header.location ?? ""), `venue, got ${header.location}`);

// The collector's attestation carries the date too, and is the fallback.
const attested = parseNoticeHeader("I, Doug Trentmann, Collector of Revenue.\nDated this 24 day of August, 2026.");
assert(attested.saleDate === "2026-08-24", `attestation fallback, got ${attested.saleDate}`);

// A notice with no date yields none — the adapter then publishes no auction
// rather than inventing one.
assert(parseNoticeHeader("NOTICE OF TAX CERTIFICATE SALE\nSome prose.").saleDate === null, "no date, no guess");

// --- parcels -----------------------------------------------------------------

// Verbatim: a single-year parcel, a three-year parcel, and the page furniture
// that sits between them.
const NOTICE = `and mining rights to be offered are as follows:
03-1-02.0-3-000-019.100
KUENZEL PROPERTIES
Sec 02 Twn 45 Rng 4W
NONE
PT SE SW
Year Amount
2023 267.83
Total 267.83
I, Doug Trentmann, Collector of Revenue, County of Franklin, State of Missouri do hereby certify that the
foregoing is a true and correct list of lands or mining rights that will be offered for sale as above set forth.
Dated this 24 day of August, 2026.

Task# 236
08-01-2026
17:15:44
03-1-02.0-3-001-023.000
BARTON,NATHAN E
Sec 02 Twn 45 Rng 4W
ZEILMANN
LOT:1&10 ZEILMANN ADDITION
Year Amount
2023 1856.72
2024 1508.89
2025 1324.14
Total 4689.75`;

const lots = parseNotice(NOTICE, "https://example.gov/notice.pdf");
assert(lots.length === 2, `two parcels, got ${lots.length}`);

const kuenzel = lots[0];
assert(kuenzel.parcelNumber === "03-1-02.0-3-000-019.100", `parcel, got ${kuenzel.parcelNumber}`);
assert(kuenzel.ownerName === "KUENZEL PROPERTIES", `owner, got ${kuenzel.ownerName}`);
assert(kuenzel.openingBid === 267.83, `single-year total, got ${kuenzel.openingBid}`);
// "NONE" is a placeholder for an absent subdivision, not part of the legal.
assert(!/NONE/.test(kuenzel.legalDescription ?? ""), `NONE stripped, got ${kuenzel.legalDescription}`);
assert(/PT SE SW/.test(kuenzel.legalDescription ?? ""), "legal description kept");

const barton = lots[1];
// The bid is the Total, not the first year and not the sum of a partial read.
assert(barton.openingBid === 4689.75, `multi-year total, got ${barton.openingBid}`);
assert(barton.openingBid !== 1856.72, "must not take the first year as the bid");
const years = (barton.raw as { yearsOwed: Record<string, number> }).yearsOwed;
assert(Object.keys(years).length === 3, `three years recorded, got ${Object.keys(years).length}`);
assert(years["2024"] === 1508.89, "per-year breakdown kept");
// The parts must add up to the published total, or the read is wrong.
const summed = Object.values(years).reduce((a, b) => a + b, 0);
assert(Math.abs(summed - 4689.75) < 0.01, `years sum to the total, got ${summed}`);

// Page furniture between parcels must not be mistaken for owner or legal text.
assert(
  !lots.some((l) => /Doug Trentmann|Task#|foregoing/.test(`${l.ownerName} ${l.legalDescription}`)),
  "collector attestation and page headers never enter a parcel",
);

// --- what it refuses ---------------------------------------------------------

assert(parseNotice("", "u").length === 0, "empty notice yields nothing");
assert(parseNotice("Just some prose about taxes.", "u").length === 0, "prose yields nothing");
// A Total with no money table above it is not a parcel.
assert(parseNotice("Some heading\nTotal 100.00", "u").length === 0, "orphan total ignored");

// --- the judge accepts them --------------------------------------------------

const judged = judgeLots(lots);
assert(judged.accepted.length === 2, `both parcels survive judgment, got ${judged.accepted.length}`);
assert(judged.rejected.length === 0, `nothing rejected, got ${judged.rejected.length}`);

// --- finding the list on the collector's page --------------------------------

const PAGE = `<html><body>
  <a href="/collector/forms.pdf">Collector Forms</a>
  <a href="https://www.franklinmo.org/_files/ugd/395081_9ace.pdf">2026 Tax Sale List</a>
  <a href="/pay">Pay my Taxes On-Line</a>
</body></html>`;
const pdf = findSaleListPdf(PAGE, "https://www.franklinmo.org/collector");
assert(pdf === "https://www.franklinmo.org/_files/ugd/395081_9ace.pdf", `found the list, got ${pdf}`);

// A page with no sale list returns null, and the adapter publishes no auction.
assert(findSaleListPdf(`<a href="/x.pdf">Budget Report</a>`, "https://x.gov") === null, "no list, no guess");

console.log("mo notice: all assertions passed");
