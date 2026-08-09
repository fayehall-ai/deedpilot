/**
 * New Mexico PTD notice + index parsing.
 * Run: npx tsx lib/ingest/nm-notice.test.ts
 *
 * Every fixture below is verbatim from a live notice or the live index page,
 * captured 2026-08-09. The three that matter are the ones a plausible parser
 * gets wrong: the column-split item run, the REMOVED marker, and the parcel
 * number a spreadsheet rounded.
 */
import {
  parseIndex,
  parseLongDate,
  parseNotice,
  parseNoticeHeader,
  parseUsDate,
} from "./adapters/new-mexico";
import { judgeLots } from "./judge";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- dates -------------------------------------------------------------------

assert(parseUsDate("08/13/2026") === "2026-08-13", "index date");
assert(parseUsDate("9/2/2026") === "2026-09-02", "unpadded index date");
assert(parseUsDate("13/01/2026") === null, "month 13 rejected");
assert(parseUsDate("not a date") === null, "garbage rejected");
assert(parseLongDate("Thursday, August 13, 2026") === "2026-08-13", "notice date");
assert(parseLongDate("Wednesday, September 2, 2026") === "2026-09-02", "notice date, Sept");
assert(parseLongDate("Someday, Smarch 4, 2026") === null, "bad month name rejected");

// --- the index ---------------------------------------------------------------

// Verbatim from the live page: a Divi text module of <p> rows, not a <table>.
const INDEX_HTML = `
<div class="et_pb_text_inner">
<p><strong>County    Date of Sale    Downloadable PDFs</strong></p>
<p style="font-weight: 400;"><strong>Lincoln County         08/13/2026 @ 10:00AM
  <a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/08/AuctionAdvertisement-Lincoln.pdf" target="_blank" rel="noopener">Lincoln County</a>  </strong></p>
<p style="font-weight: 400;"><strong>San Juan County      08/17/2026 @ 10:00AM
  <a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/08/AuctionAdvertisement-San-Juan-8.17.26-2.pdf" target="_blank" rel="noopener">San Juan County</a>  </strong></p>
<p style="font-weight: 400;"><strong><span>Sierra County            08/25/2026 @ 10:00AM
  <a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/08/AuctionAdvertisement-8.25.26-Copy.pdf" target="_blank" rel="noopener">Sierra County</a>    </span></strong></p>
<p style="font-weight: 400;"><strong>Sandoval County      09/02/2026 @ 10:00AM
  <a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/08/AuctionAdvertisement-Sandoval-9.2.26-1.pdf" target="_blank" rel="noopener">Sandoval County</a>       </strong></p>
<p style="font-weight: 400;"><strong>Sandoval County      09/03/2026 @ 10:00AM
  <a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/08/AuctionAdvertisement-Sandoval-9.3.26.pdf" target="_blank" rel="noopener">Sandoval County</a>  </strong></p>
<p><a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2023/11/New-TERMS-OF-THE-PROPERTY-TAX-DIVISION-PUBLIC-AUCTION-SALES-online-11-16-2023.pdf">Terms of sale</a></p>
<p><a href="https://www.tax.newmexico.gov/businesses/wp-content/uploads/sites/4/2026/07/EXAMPLE-OF-LETTER-OF-GUARANTEE.pdf">EXAMPLE OF LETTER OF GUARANTEE</a></p>
</div>`;

const sales = parseIndex(INDEX_HTML, "https://www.tax.newmexico.gov/x/");
assert(sales.length === 5, `5 auction rows, got ${sales.length}`);

// Terms of sale and the guarantee letter are PDFs on the same page and are not
// auctions. A parser that takes every .pdf link invents two sales.
assert(
  !sales.some((s) => /TERMS|GUARANTEE/i.test(s.pdfUrl)),
  "non-auction PDFs must not become sales",
);

assert(sales[0].countyFips === "35027" && sales[0].saleDate === "2026-08-13", "Lincoln resolved");
assert(sales[0].startTime === "10:00AM", `start time, got ${sales[0].startTime}`);

// Two-word county names survive the "County" strip.
const sj = sales.find((s) => s.countyFips === "35045");
assert(sj?.countyName === "San Juan", `San Juan resolved, got ${sj?.countyName}`);

// Sandoval sells on consecutive days from two separate notices. Keying on the
// county alone silently drops one whole sale.
const sandoval = sales.filter((s) => s.countyFips === "35043");
assert(sandoval.length === 2, `Sandoval has 2 sales, got ${sandoval.length}`);
assert(
  sandoval[0].saleDate !== sandoval[1].saleDate && sandoval[0].pdfUrl !== sandoval[1].pdfUrl,
  "the two Sandoval sales are distinct",
);

// --- the notice header -------------------------------------------------------

const HEADER = `NOTICE OF PUBLIC AUCTION SALE OF REAL PROPERTY FOR DELINQUENT PROPERTY TAXES
STATE OF NEW MEXICO TAXATION AND REVENUE DEPARTMENT PROPERTY TAX DIVISION (505) 827-0883
Notice is hereby given that, pursuant to provisions of Section 7-38-65 NMSA 1978, the Property Tax Division of the Taxation and
Revenue Department will offer for sale at public auction, in Grant County, beginning at:
TIME: 10:00 AM
DATE: Wednesday, August 26, 2026
LOCATION: GRANT COUNTY, 1400 Highway 180 East, SILVER CITY NM 88062`;

const header = parseNoticeHeader(HEADER);
assert(header.saleDate === "2026-08-26", `notice date, got ${header.saleDate}`);
assert(header.startTime === "10:00 AM", `notice time, got ${header.startTime}`);
assert(header.county === "Grant", `notice county, got ${header.county}`);
assert(/SILVER CITY/.test(header.location ?? ""), "notice venue");

// --- parcels: the column-split run -------------------------------------------

// Verbatim from the Lincoln notice. The PDF lays out in columns, so headers for
// items 4-7 are emitted together and only then their four parcel blocks.
// Segmenting on "Item #" attributes 17201's data to item 4 and loses the rest.
const COLUMN_SPLIT = `-- 2 of 10 --

Item #4
Bidder #_____
Amount $_________
Item #5
Bidder #_____
Amount $_________
Item #6
Bidder #_____
Amount $_________
Item #7
Bidder #_____
Amount $_________
Case: 17201 REMOVED
UPC: 4072066224455000000
Account: 0001904
Delinquent Owner: GALLEGOS TRUST, GALLEGOS TRUST C/O GAIM-KO INC
Simple Description: ON CARRIZO CANYON RD
Minimum Bid: $4,300.00
Property Description: Township 11 S Range 13 E Section 34 A TRACT OF LAND LOCATED IN THE
SE4SW4, CONT'G 24.421 ACRES, MORE OR LESS.
Case: 17216
UPC: 4073062326401000000
Account: 0021637
Delinquent Owner: DENNIS PYLE, PYLE, R R PYLE, DENNIS
Simple Description: ON TIMBERLINE DR
Minimum Bid: $81,800.00
Property Description: MOUNTAIN VIEW ESTATES SD. UNIT 1 BLOCK 2 LOT 24 25
Case: 17237
UPC: 4074060289032000000
Account: 0254726
Delinquent Owner: DON L GARCIA, GARCIA, DON L
Simple Description: Off Twin Tree Loop
Minimum Bid: $1,400.00
Property Description: HIGH MESA SD. UNIT 1 BLOCK 4 LOT 20
Case: 17275
UPC: 4072060029266000000
Account: 0323600
Delinquent Owner: DON L GARCIA
Simple Description: On Brentwood dr
Minimum Bid: $1,400.00
Property Description: SIERRA BLANCA SD. UNIT 2 BLOCK 3 LOT 2`;

const split = parseNotice(COLUMN_SPLIT, "https://example.gov/lincoln.pdf");
assert(split.length === 4, `four parcels in the split run, got ${split.length}`);
assert(
  split.map((p) => p.caseNumber).join(",") === "17201,17216,17237,17275",
  `cases in order, got ${split.map((p) => p.caseNumber)}`,
);

// The $81,800 parcel is the most valuable in the notice; losing it to a
// mis-segmentation is losing the reason to read the notice at all.
const pyle = split.find((p) => p.caseNumber === "17216")!;
assert(pyle.openingBid === 81800, `bid parsed, got ${pyle.openingBid}`);
assert(pyle.ownerName === "DENNIS PYLE, PYLE, R R PYLE, DENNIS", "owner parsed");
assert(pyle.parcelNumber === "4073062326401000000", "UPC parsed");
assert(pyle.legalDescription === "MOUNTAIN VIEW ESTATES SD. UNIT 1 BLOCK 2 LOT 24 25", "legal");

// A wrapped legal description must be rejoined, and must stop before the next
// case rather than swallowing it.
const gallegos = split.find((p) => p.caseNumber === "17201")!;
assert(
  gallegos.legalDescription ===
    "Township 11 S Range 13 E Section 34 A TRACT OF LAND LOCATED IN THE SE4SW4, CONT'G 24.421 ACRES, MORE OR LESS.",
  `wrapped legal rejoined, got ${gallegos.legalDescription}`,
);
assert(!/17216|MOUNTAIN VIEW/.test(gallegos.legalDescription ?? ""), "legal stops at next case");

// REMOVED: published, but not for sale.
assert(gallegos.status === "withdrawn", `REMOVED → withdrawn, got ${gallegos.status}`);
assert(gallegos.removalMarker === "REMOVED", "marker retained verbatim");
assert(split.filter((p) => p.status === "pending").length === 3, "3 of 4 are biddable");

// The location hint is not an address and must not be presented as one — a
// geocoder given "ON CARRIZO CANYON RD" returns nothing or the wrong parcel.
assert(gallegos.addressLine === undefined, "simple description never becomes addressLine");
assert(
  (gallegos.raw as Record<string, unknown>).simpleDescription === "ON CARRIZO CANYON RD",
  "simple description kept in raw",
);

// Identity never rests on the parcel number alone.
assert(gallegos.externalId === "case-17201", "externalId from case number");

// --- parcels: the rounded parcel number --------------------------------------

// Verbatim from the Grant notice. Excel turned a 13-digit UPC into a float.
const ROUNDED = `Case: 57911
UPC: 3.0771E+12
Account: R074114
Delinquent Owner: ESTATE OF FERNANDO GARCIA, FRANKS JUANITA GARCIA FERNANDO C/O
Simple Description: VACANT LAND OFF OF HIGHWAY 15
Minimum Bid: $11,500.00
Property Description: Quarter: SE S: 05 T: 17S R: 13W NEQSEQ 40 AC`;

const rounded = parseNotice(ROUNDED, "https://example.gov/grant.pdf");
assert(rounded.length === 1, "one parcel");
// The adapter reports what the notice says; the judge decides what is usable.
assert(rounded[0].parcelNumber === "3.0771E+12", "adapter passes the value through verbatim");

const judged = judgeLots(rounded);
assert(judged.accepted.length === 1, "the parcel survives — it is real and biddable");
assert(judged.rejected.length === 0, "a bad identifier is not grounds to discard a parcel");
assert(
  judged.accepted[0].parcelNumber === undefined,
  `rounded UPC must be nulled, got ${judged.accepted[0].parcelNumber}`,
);
assert(
  judged.accepted[0].externalId === "case-57911",
  "identity falls through to the case number",
);
assert(
  judged.repairs.some((r) => r.field === "parcelNumber"),
  "the repair is counted, not silent",
);
// The money is untouched — $11,500 is a real opening bid on a real parcel.
assert(judged.accepted[0].openingBid === 11500, "opening bid preserved");

// Genuine UPCs in both published shapes must survive untouched.
for (const upc of ["4072065226040000000", "2068168476119", "4072066325079CM0001"]) {
  const ok = judgeLots([{ externalId: "x", parcelNumber: upc }]);
  assert(ok.accepted[0].parcelNumber === upc, `real UPC ${upc} must not be repaired`);
}

// --- money -------------------------------------------------------------------

const MONEY = `Case: 1
UPC: 1234567890123
Minimum Bid: $100.00
Property Description: A
Case: 2
UPC: 1234567890124
Minimum Bid: $1,234,567.89
Property Description: B
Case: 3
UPC: 1234567890125
Property Description: C`;
const money = parseNotice(MONEY, "u");
assert(money[0].openingBid === 100, "plain dollars");
assert(money[1].openingBid === 1234567.89, "thousands separators and cents");
// A missing bid stays missing. $0 and "unknown" lead to different decisions.
assert(money[2].openingBid === undefined, "absent bid is undefined, never 0");

assert(parseNotice("", "u").length === 0, "empty notice yields nothing");
assert(parseNotice("no parcels here at all", "u").length === 0, "prose yields nothing");

console.log("nm notice: all assertions passed");
