/**
 * Generic adapter and the shared parsers.
 *
 * No network: what must not drift is which tables count as inventory, which
 * links are decoys, and where the adapter gets its sale type and date from.
 * Run: npx tsx lib/ingest/generic-adapter.test.ts
 */
import * as cheerio from "cheerio";
import { __setRegistry, forThisSale, genericAdapter, looksLikeList, pickSource } from "./adapters/generic";
import { ADAPTERS, getAdapter } from "./adapters";
import {
  classifiedPdfLinks,
  classifyListingLink,
  documentLinks,
  parseDelimitedText,
  listPageLinks,
  parseHtmlTable,
  pdfLinks,
} from "./parse";
import type { SourceRegistry, VerifiedSource } from "../prospector/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- table parsing -----------------------------------------------------------

const parcelTable = cheerio.load(`
  <table>
    <tr><th>Parcel ID</th><th>Owner</th><th>Situs Address</th><th>Minimum Bid</th></tr>
    <tr><td>12-34-567</td><td>SMITH JOHN</td><td>1 Main St</td><td>$1,250.00</td></tr>
    <tr><td>12-34-568</td><td>DOE JANE</td><td>2 Oak Ave</td><td>$3,400</td></tr>
  </table>`);
const rows = parseHtmlTable(parcelTable, "https://co.gov/list");
assert(rows?.length === 2, `expected 2 rows, got ${rows?.length}`);
assert(rows![0].parcelNumber === "12-34-567", "parcel id mapped");
assert(rows![0].ownerName === "SMITH JOHN", "owner mapped");
assert(rows![0].addressLine === "1 Main St", "situs address mapped");
assert(rows![0].openingBid === 1250, `bid parsed, got ${rows![0].openingBid}`);

// Excess-funds tables are PAST sales and the surplus owed to former owners.
// Ingesting one publishes sold parcels as upcoming inventory.
const excess = cheerio.load(`
  <table>
    <tr><th>Parcel</th><th>Owner</th><th>Excess Funds</th><th>Sold Date</th></tr>
    <tr><td>99-99-999</td><td>PAST OWNER</td><td>$5,000</td><td>2025-01-07</td></tr>
  </table>`);
assert(parseHtmlTable(excess, "https://co.gov/x") === null, "excess-funds table must be refused");

// A page of unrelated tables yields nothing rather than junk.
const unrelated = cheerio.load(`<table><tr><th>Office</th><th>Hours</th></tr>
  <tr><td>Assessor</td><td>9-5</td></tr></table>`);
assert(parseHtmlTable(unrelated, "https://co.gov/x") === null, "unrelated table refused");

// The largest qualifying table wins — county pages often carry a small summary
// table above the real list.
const twoTables = cheerio.load(`
  <table><tr><th>Parcel</th><th>Owner</th></tr><tr><td>a</td><td>b</td></tr></table>
  <table><tr><th>Parcel</th><th>Owner</th></tr>
    <tr><td>c</td><td>d</td></tr><tr><td>e</td><td>f</td></tr><tr><td>g</td><td>h</td></tr></table>`);
assert(parseHtmlTable(twoTables, "https://co.gov/x")?.length === 3, "largest table wins");

// --- link filtering ----------------------------------------------------------

const links = cheerio.load(`
  <a href="/docs/tax-sale-list.pdf">2026 Tax Sale List</a>
  <a href="/docs/excess-funds.pdf">Excess Funds</a>
  <a href="/docs/brochure.pdf">Bidder Brochure</a>
  <a href="/docs/no-tax-sale.pdf">No tax sale at this time</a>
  <a href="/docs/results.pdf">Sale Results</a>`);
const pdfs = pdfLinks(links, "https://co.gov/page");
assert(pdfs.length === 1, `expected 1 pdf after filtering, got ${pdfs.length}: ${pdfs}`);
assert(pdfs[0].endsWith("tax-sale-list.pdf"), "kept the real list");

// --- sale list vs delinquent roll --------------------------------------------
//
// Regression: Cobb County GA links both from one tax-sale page. They scored
// alike, the delinquent roll sorted first, and 2,825 parcels that were not for
// sale entered inventory under a sale date the calendar had invented.

assert(
  classifyListingLink("2026 Tax Sale List") === "sale_list",
  "a sale list is a sale list",
);
assert(
  classifyListingLink("Cobb County Tax Commissioner Delinquent Tax List 07.01.2026.pdf") ===
    "delinquent_list",
  "a delinquent roll is not a sale list",
);
assert(
  classifyListingLink("Lands Available for Taxes") === "lands_available",
  "struck inventory is its own kind",
);
assert(
  classifyListingLink("Delinquent Tax Sale List") === "sale_list",
  "sale vocabulary wins when a heading carries both words",
);
assert(
  classifyListingLink("https://www.fayettecountypa.org/DocumentCenter/View/16552/Upset-2026-Final-list-09-18-2026") ===
    "sale_list",
  "a Pennsylvania upset sale list is a sale list",
);
assert(
  classifyListingLink("2026 Repository Sale List") === "sale_list",
  "a Pennsylvania repository list is a sale list",
);

// A workbook as documentToText renders it: a sheet marker, a title row, then the table.
{
  const sheet = [
    "# DL_RC_REG",
    "FLC - RICHLAND COUNTY OWNED PROPERTY\t\t\t",
    "TAX MAP#\tOWNER NAME\tLOCATION\tOPENING BID",
    "01000-03-38-\tRICHLAND CO FORFEITED LAND COMM\tN/S HUBERT SIMPSON RD\t1300",
    "09403-04-05-\tRICHLAND CO FORFEITED LAND COMM\t123 MAIN ST\t2,450.00",
  ].join("\n");
  const lots = parseDelimitedText(sheet, "https://example.gov/flc.xlsx") ?? [];
  assert(lots.length === 2, `a sheet with a title row reads its two rows (got ${lots.length})`);
  assert(lots[0].parcelNumber === "01000-03-38-", "the parcel column is found under a title row");
  assert(lots[1].openingBid === 2450, "the bid column is read as money");
}
{
  const csv = [
    "Parcel ID,Owner,Address,Minimum Bid",
    '12-345-678,"SMITH, JOHN",1 Oak St,"$1,000.00"',
    '12-345-679,"DOE, JANE",2 Elm St,$500.00',
  ].join("\n");
  const lots = parseDelimitedText(csv, "https://example.gov/list.csv") ?? [];
  assert(lots.length === 2 && lots[0].ownerName === "SMITH, JOHN", "a quoted comma stays inside its CSV cell");
}
assert(parseDelimitedText("Notice of tax sale\nAll parcels will be sold\nat the courthouse", "x") === null, "prose is not a table");

const cobbStyle = cheerio.load(`
  <a href="/Delinquent%20Tax%20List%2007.01.2026.pdf">Delinquent Tax List</a>
  <a href="/nov-3-2026-tax-sale-list.pdf">November 3rd, 2026 Tax Sale List</a>
  <a href="/excess-funds.pdf">Excess Funds List</a>`);
const cobbPdfs = classifiedPdfLinks(cobbStyle, "https://www.cobbtax.gov/property/tax_sale/");
assert(cobbPdfs.length === 2, `excess funds dropped, got ${cobbPdfs.length}`);
assert(
  cobbPdfs[0].url.includes("tax-sale-list"),
  `sale list must be opened first, got ${cobbPdfs[0].url}`,
);
assert(cobbPdfs[0].kind === "sale_list", "and it must be labelled a sale list");
assert(
  cobbPdfs[1].kind === "delinquent_list",
  "the roll is kept as a lead, tagged for what it is",
);

const navLinks = cheerio.load(`
  <a href="/current-tax-sale">Current Tax Sale List</a>
  <a href="/excess">Excess Funds</a>
  <a href="/contact">Contact Us</a>
  <a href="/upcoming-auction">Upcoming Auction</a>`);
const followed = listPageLinks(navLinks, "https://co.gov/page");
assert(followed.length === 2, `expected 2 followable links, got ${followed.length}`);
assert(!followed.some((l) => l.includes("excess")), "excess link not followed");
assert(!followed.some((l) => l.includes("contact")), "unrelated nav not followed");

// --- registry-driven discovery -----------------------------------------------

const src = (over: Partial<VerifiedSource>): VerifiedSource => ({
  fips: "39035", state: "OH", url: "https://x", host: "x", origin: "atlas",
  kind: "listing", isGovernment: false, confidence: 0.5, signals: [],
  verifiedOn: "2026-07-30", httpStatus: 200, ...over,
});

__setRegistry({
  builtAt: "", nCounties: 3, nVerified: 4, nGaps: 1,
  counties: {
    // Cuyahoga OH — a government listing must beat a higher-confidence vendor.
    "39035": {
      state: "OH", county: "Cuyahoga", isGap: false,
      sources: [
        src({ url: "https://vendor.com/l", confidence: 0.99, isGovernment: false }),
        src({ url: "https://cuyahoga.gov/list", isGovernment: true, kind: "listing" }),
      ],
    },
    // Cook IL — present so we can check sale type and date come from the atlas.
    "17031": {
      state: "IL", county: "Cook", isGap: false,
      sources: [src({ fips: "17031", state: "IL", url: "https://cookcountytreasurer.gov/x", isGovernment: true })],
    },
    // A gap county contributes no binding at all.
    "56001": { state: "WY", county: "Albany", isGap: true, sources: [] },
  },
});

async function main() {
const bindings = await genericAdapter.discoverCounties();
assert(bindings.length === 2, `gap county excluded, got ${bindings.length} bindings`);

const cuyahoga = bindings.find((b) => b.countyFips === "39035")!;
assert(
  (cuyahoga.config as { url: string }).url === "https://cuyahoga.gov/list",
  "government listing outranks the higher-confidence vendor",
);

// --- sale type and date come from the atlas and calendar, not a literal ------

const cookAuctions = await genericAdapter.listAuctions(
  bindings.find((b) => b.countyFips === "17031")!,
);
assert(cookAuctions.length === 1, "one upcoming window per county");
const a = cookAuctions[0];
assert(a.saleType === "Tax Lien", `Illinois sells liens, got ${a.saleType}`);
assert(/^\d{4}-\d{2}-\d{2}$/.test(a.saleDate), "sale date from the calendar");
assert(a.externalId === `17031|${a.saleDate}`, "stable dedupe key");
assert(
  (a.raw as { saleDateEstimated: boolean }).saleDateEstimated === true,
  "projected dates are flagged as estimates",
);
assert(
  (a.raw as { scheduleConfidence: string }).scheduleConfidence !== undefined,
  "schedule confidence is carried through to the auction record",
);

const ohAuctions = await genericAdapter.listAuctions(cuyahoga);
assert(ohAuctions[0].saleType !== undefined, "Ohio resolves a sale type from the atlas");

// --- registration order is precedence ----------------------------------------

const names = ADAPTERS.map((x) => x.name);

// The invariant is precedence, not headcount: the generic adapter matches
// almost any county page, so a bespoke adapter registered after it would never
// be reached. A hardcoded length assertion tested nothing about that and went
// stale the first time a state was added — it read "expected 5, got 9" for
// four adapters before this was noticed.
assert(names.at(-1) === "generic-county", "generic adapter must be registered last");
assert(
  names.filter((n) => n === "generic-county").length === 1,
  "generic-county registered exactly once",
);
assert(new Set(names).size === names.length, `adapter names must be unique: ${names.join(", ")}`);
assert(
  names.every((n) => getAdapter(n)?.name === n),
  "every registered adapter resolves by name",
);

  // No registry means no bindings, not a crash. The explicit override matters:
  // merely clearing the cache would fall through to a disk read and make this
  // pass or fail depending on whether a registry file happens to exist.
  __setRegistry(null);
  assert(
    (await genericAdapter.discoverCounties()).length === 0,
    "missing registry degrades quietly",
  );

  return {
    bindings: bindings.length,
    cookSaleType: a.saleType,
    cookSaleDate: a.saleDate,
    adapters: names.join(","),
  };
}

main()
  .then((summary) => console.log("generic adapter tests ok", summary))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// --- department ranking ------------------------------------------------------
// Regression: Boulder County's homepage offers five assessor links before the
// treasurer. Following document order spent the entire crawl budget in the
// wrong office and found nothing; the assessor values property, the treasurer
// sells it.
{
  const { discoveryLinks } = require("./parse") as typeof import("./parse");
  const county = cheerio.load(`
    <a href="/departments/assessor/">Assessor</a>
    <a href="/property-and-land/assessor/appeals/">Assessor Appeals</a>
    <a href="/property-and-land/assessor/assessment/">Assessment</a>
    <a href="/departments/clerk/">Clerk and Recorder</a>
    <a href="/property-and-land/treasurer/">Treasurer</a>`);
  const { department } = discoveryLinks(county, "https://bouldercounty.gov/");
  assert(
    department[0].includes("treasurer"),
    `treasurer must rank first, got ${department[0]}`,
  );
  assert(
    department.at(-1)!.includes("assessor"),
    "assessor ranks last — it values property, it does not sell it",
  );

  // A direct sale link outranks every department link.
  const direct = cheerio.load(`
    <a href="/treasurer/">Treasurer</a>
    <a href="/treasurer/tax-lien-sale/">Tax Lien Sale</a>`);
  const d2 = discoveryLinks(direct, "https://x.gov/");
  assert(d2.direct.length === 1 && d2.direct[0].includes("tax-lien-sale"), "direct link found");

  // Off-site links are not followed — those are vendors and social media.
  const offsite = cheerio.load(`<a href="https://facebook.com/treasurer">Treasurer</a>`);
  assert(discoveryLinks(offsite, "https://x.gov/").department.length === 0, "stays on-site");
}

// --- two months' lists on one page -----------------------------------------------
{
  const docs = [
    { url: "https://x.gov/content/PDF/NOVEMBER%20TAX%20SALE%20LISTING%209-8-26.pdf", kind: "sale_list" as const },
    { url: "https://x.gov/content/PDF/OfficialClaimforExcessFund.pdf", kind: "unknown" as const },
    { url: "https://x.gov/content/PDF/OCTOBER%20TAX%20SALE%20LISTING%209-8-26.pdf", kind: "sale_list" as const },
  ];
  const oct = forThisSale(docs, "2026-10-06").map((d) => d.url.split("/").pop());
  if (oct[0] !== "OCTOBER%20TAX%20SALE%20LISTING%209-8-26.pdf") throw new Error(`October's sale should read October's list first, got ${oct[0]}`);
  if (oct[oct.length - 1] !== "NOVEMBER%20TAX%20SALE%20LISTING%209-8-26.pdf") throw new Error("another month's list should go last");
  const nov = forThisSale(docs, "2026-11-03").map((d) => d.url.split("/").pop());
  if (nov[0] !== "NOVEMBER%20TAX%20SALE%20LISTING%209-8-26.pdf") throw new Error("November's sale should read November's list first");
  console.log("forThisSale: a sale reads its own month's list first");
}

// A list somebody chose beats the registry's .gov page, even off .gov; a workbook link does not.
{
  const gov = { url: "https://county.gov/", signals: ["atlas"], isGovernment: true, kind: "homepage" };
  const chosen = { url: "https://www.fayettecountypa.org/273/Upset-Sale", signals: ["operator"], isGovernment: false, kind: "listing" };
  const workbook = { url: "https://www.govdeals.com/MontCoJudicialSale2022", signals: ["auction-scout-workbook"], isGovernment: false, kind: "listing" };
  assert(pickSource([gov, chosen])?.url === chosen.url, "an operator's list wins over a .gov homepage");
  assert(pickSource([workbook, gov])?.url === gov.url, "a link the workbook recorded does not outrank the registry");
}

// Documents with no extension (Liferay) and documents shown only in a viewer frame.
{
  const $ = cheerio.load(`
    <a href="/documents/d/egov/october-2026-tax-sale-web-list?download=true">October 2026 Tax Sale List</a>
    <iframe src="https://docs.google.com/viewer?url=https://newtoncountytax.com/wp-content/uploads/2026/09/Newton-October-2026-Tax-Sale.pdf&embedded=true"></iframe>`);
  const urls = documentLinks($, "https://www.gwinnetttaxcommissioner.com/property-tax/delinquent_tax/tax-liens-tax-sales").map((l) => l.url);
  assert(urls.some((u) => u.includes("/documents/d/egov/october-2026")), "a Liferay document route is a document");
  assert(urls.includes("https://newtoncountytax.com/wp-content/uploads/2026/09/Newton-October-2026-Tax-Sale.pdf"), "a PDF inside a Google viewer frame is found");
}

// A notice page that prints its parcels is read; a department landing page is not.
{
  const notice = Array.from({ length: 8 }, (_, i) => `Map ${10 + i}-${200 + i}, owner SMITH ${i}, amount due $${1000 + i}.00`).join("\n");
  assert(looksLikeList(notice), "a legal notice listing parcels with amounts looks like a list");
  assert(!looksLikeList("Tax Commissioner. Call 770-555-1234. Office hours 8-5. Pay online."), "a landing page does not");
}

