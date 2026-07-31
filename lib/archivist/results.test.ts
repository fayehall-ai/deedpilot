/**
 * Results-crawler parsing. No network.
 *
 * The rule that matters: a table of *minimum* bids is an upcoming listing, not
 * a result. Ingesting one as history would teach the price model that auctions
 * clear at their reserve, which is both wrong and self-confirming — the bid
 * search would then recommend bidding the reserve.
 *
 * Run: npx tsx lib/archivist/results.test.ts
 */
import * as cheerio from "cheerio";
import { parseResultsTable } from "./results";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- a real results table ----------------------------------------------------

const sold = cheerio.load(`
  <table>
    <tr><th>Parcel</th><th>Sale Date</th><th>Minimum Bid</th><th>Sold Price</th></tr>
    <tr><td>12-34-567</td><td>08/04/2026</td><td>$1,200.00</td><td>$8,500.00</td></tr>
    <tr><td>12-34-568</td><td>08/04/2026</td><td>$900</td><td>$3,250</td></tr>
  </table>`);
const rows = parseResultsTable(sold, "https://co.gov/results");
assert(rows.length === 2, `expected 2 sold rows, got ${rows.length}`);
assert(rows[0].winning === 8500, `winning price, got ${rows[0].winning}`);
assert(rows[0].opening === 1200, `opening price, got ${rows[0].opening}`);
assert(rows[0].date === "2026-08-04", `US date normalised, got ${rows[0].date}`);
assert(rows[0].parcel === "12-34-567", "parcel captured");

// ISO dates pass through unchanged.
const iso = cheerio.load(`
  <table><tr><th>Parcel</th><th>Date</th><th>Winning Bid</th></tr>
  <tr><td>a-1</td><td>2026-08-04</td><td>$500</td></tr></table>`);
assert(parseResultsTable(iso, "u")[0].date === "2026-08-04", "ISO date preserved");

// --- an upcoming listing must NOT be read as results -------------------------

const upcoming = cheerio.load(`
  <table>
    <tr><th>Parcel</th><th>Owner</th><th>Minimum Bid</th></tr>
    <tr><td>99-1</td><td>SMITH</td><td>$1,000</td></tr>
    <tr><td>99-2</td><td>DOE</td><td>$2,000</td></tr>
  </table>`);
assert(
  parseResultsTable(upcoming, "https://co.gov/upcoming").length === 0,
  "a minimum-bid table has no sold column and must yield nothing",
);

// --- excess funds carry a sold price but are not a clearing price ------------

const excess = cheerio.load(`
  <table>
    <tr><th>Parcel</th><th>Excess Funds</th><th>Claim Deadline</th></tr>
    <tr><td>77-1</td><td>$4,000</td><td>2026-12-01</td></tr>
  </table>`);
assert(parseResultsTable(excess, "u").length === 0, "excess-funds table refused");

// --- rows without a usable price are dropped, not defaulted ------------------

const messy = cheerio.load(`
  <table>
    <tr><th>Parcel</th><th>Sold Price</th></tr>
    <tr><td>a</td><td>Withdrawn</td></tr>
    <tr><td>b</td><td>$0.00</td></tr>
    <tr><td>c</td><td>N/A</td></tr>
    <tr><td>d</td><td>$12,000</td></tr>
  </table>`);
const cleaned = parseResultsTable(messy, "u");
assert(cleaned.length === 1, `only the priced row survives, got ${cleaned.length}`);
assert(cleaned[0].winning === 12000, "and it is the right one");

// A withdrawn parcel must not become a $0 sale — that would drag every county
// median toward zero and make the clearing-price model recommend absurd bids.
assert(!cleaned.some((r) => r.winning === 0), "zero-price rows are dropped, not recorded");

// --- a table with no sold column at all --------------------------------------

const noPrice = cheerio.load(`
  <table><tr><th>Office</th><th>Phone</th></tr><tr><td>Treasurer</td><td>555</td></tr></table>`);
assert(parseResultsTable(noPrice, "u").length === 0, "unrelated table yields nothing");

console.log("results crawler tests ok", {
  soldRows: rows.length,
  firstWinning: rows[0].winning,
  firstOpening: rows[0].opening,
});
