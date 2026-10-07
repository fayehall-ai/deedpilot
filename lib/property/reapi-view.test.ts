/**
 * Standalone: `npx tsx lib/property/reapi-view.test.ts`. Throws on failure.
 *
 * Fixture follows the PropStream reference record (5076 Momenti St, Las Vegas)
 * in RealEstateAPI's PropertyDetail shape.
 */
import { buildPropertyView, ownershipLength, usDate } from "./reapi-view";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const raw = {
  estimatedValue: 592000,
  estimatedEquity: 477556,
  equityPercent: 81,
  openMortgageBalance: 114444,
  ownerOccupied: true,
  preForeclosure: true,
  vacant: false,
  taxLien: false,
  judgment: false,
  lastSale: {
    saleDate: "2022-04-25T00:00:00.000Z",
    saleAmount: 618000,
    purchaseMethod: "Financed",
    documentType: "Bargain and Sale Deed",
  },
  saleHistory: [
    {
      saleDate: "2015-11-12T00:00:00.000Z",
      recordingDate: "2015-12-28T00:00:00.000Z",
      armsLength: false,
      documentType: "Intrafamily Transfer & Dissolution",
      documentNumber: "20151228-0001082",
      buyerNames: "The Wallace Family Revocable Living Trus",
      sellerNames: "Wallace William B, Wallace Kentha",
    },
    {
      saleDate: "2022-04-25T00:00:00.000Z",
      recordingDate: "2022-05-06T00:00:00.000Z",
      armsLength: true,
      saleAmount: 618000,
      purchaseMethod: "Financed",
      documentType: "Bargain and Sale Deed",
      documentNumber: "2022.1923",
      buyerNames: "Mitchell Regene L",
      sellerNames: "Donald K Zevchek And Laura D Colver Trus",
    },
  ],
  currentMortgages: [
    {
      amount: 525300,
      loanType: "New Conventional",
      lenderName: "JPMORGAN CHASE BANK NA",
      interestRate: 4.42,
      term: 360,
      maturityDate: "2052-06-01T00:00:00.000Z",
      recordingDate: "2022-05-06T00:00:00.000Z",
      open: true,
    },
  ],
  ownerInfo: {
    owner1FullName: "Mitchell Regene L",
    owner1Type: "Individual",
    ownershipLength: 53,
    mailAddress: { label: "5076 Momenti St, Las Vegas, NV 89135" },
  },
  propertyInfo: {
    bedrooms: 2,
    bathrooms: 2,
    livingSquareFeet: 1782,
    buildingSquareFeet: 2255,
    garageSquareFeet: 473,
    yearBuilt: 2004,
    garageType: "Attached Garage",
    hoa: [
      { name: "Sienna Community Association", type: "Home Owner Association", fee: 240, feeFrequency: "Monthly" },
    ],
  },
  lotInfo: { apn: "164-25-516-036", lotSquareFeet: 6098, zoning: "R-2", subdivision: "Sun Colony At Summerlin-Unit 15B" },
  taxInfo: { assessedValue: 158472, assessedLandValue: 71750, assessedImprovementValue: 86722, marketValue: 327714, year: 2026 },
  demographics: { fmrTwoBedroom: "1626" },
};

const v = buildPropertyView(raw, { countyName: "Clark" });

eq(v.enriched, true, "enriched");
eq(v.facts.map((f) => f.label), ["Beds", "Baths", "SqFt", "Lot Size", "Year Built", "APN"], "fact order");
eq(v.facts.find((f) => f.label === "APN")?.value, "164-25-516-036", "apn");
eq(v.status.find((f) => f.label === "Distressed")?.value, "Pre-Foreclosure", "distress");
eq(v.status.find((f) => f.label === "HOA/COA")?.value, "Yes", "hoa flag");
eq(v.status.find((f) => f.label === "Length of Ownership")?.value, "4 Years 5 Months", "ownership");
eq(v.status.find((f) => f.label === "Owner Status")?.value, "Owner Occupied", "occupancy");
eq(v.debt.find((s) => s.label === "Open Mortgages")?.value, "1", "open mortgages");
eq(v.opportunity.find((s) => s.label === "Monthly Rent")?.value, "$1,626", "rent from FMR by beds");
eq(v.opportunity.find((s) => s.label === "Gross Yield")?.value, "3.30%", "yield = rent*12/value");

const details = v.tabs[0];
eq(
  details.sections.map((s) => s.title),
  [
    "Ownership Information",
    "Property Characteristics",
    "Building Size",
    "Land/Location Information",
    "Tax Assessment Information",
    "HOA Information",
    "Last Non-Arm's Length Ownership Transfer",
    "Last Arm's Length Sale Information",
  ],
  "PropStream section order (legal description absent → omitted)",
);
const arms = details.sections.at(-1)!;
const mortgage = arms.groups.find((g) => g.title === "First Mortgage Information");
eq(mortgage?.fields.find((f) => f.label === "Lender Name")?.value, "JPMORGAN CHASE BANK NA", "mortgage joined on recording date");
eq(mortgage?.fields.find((f) => f.label === "Rate (Est.)")?.value, "4.42%", "rate");
const nonArms = details.sections.at(-2)!;
eq(nonArms.groups.some((g) => g.title === "First Mortgage Information"), false, "no mortgage on a non-arm's transfer");
eq(
  nonArms.groups.find((g) => g.title === "Recording Information")?.fields.map((f) => f.value),
  ["12/28/2015", "Intrafamily Transfer & Dissolution", "20151228-0001082"],
  "recording info",
);

// Sale-list facts outrank the provider.
const listed = buildPropertyView(raw, { countyName: "Clark", ownerName: "LISTED OWNER", buildingSqft: 1700 });
eq(details.sections[0].groups[0].fields[0].value, "Mitchell Regene L", "provider owner when list has none");
eq(listed.tabs[0].sections[0].groups[0].fields[0].value, "LISTED OWNER", "list owner leads");
eq(listed.facts.find((f) => f.label === "SqFt")?.value, "1,700", "list sqft leads");

// No provider record: facts and details only, no invented distress or debt.
const bare = buildPropertyView(null, { countyName: "Clark", parcelNumber: "123", legalDescription: "LOT 1" });
eq(bare.enriched, false, "bare enriched");
eq(bare.tabs.map((t) => t.id), ["details"], "bare tabs");
eq(bare.debt, [], "no debt claims without a record");
eq(bare.status.some((f) => f.label === "Distressed"), false, "no distress claim without a record");
eq(bare.tabs[0].sections.map((s) => s.title), ["Land/Location Information", "Legal Description"], "bare sections");

// The assessment is one set: a list total never meets a provider split.
const mixed = buildPropertyView(raw, { countyName: "Clark", assessedValue: 1154, assessedImprovement: 5 });
const taxFields = mixed.tabs[0].sections.find((x) => x.title === "Tax Assessment Information")!.groups[0].fields;
eq(taxFields.find((f) => f.label === "Total Assessed Value")?.value, "$158,472", "provider total with provider split");
eq(taxFields.find((f) => f.label === "Improvement to Tax Value")?.value, "54.724%", "PropStream's ratio");

// Opportunity leads with the auction's own numbers.
const bid = buildPropertyView(raw, { countyName: "Clark", openingBid: 1154, taxesOwed: 980 });
eq(bid.opportunity.slice(0, 3).map((x) => [x.label, x.value]), [
  ["Opening Bid", "$1,154"],
  ["Bid / Value", "0.19%"],
  ["Taxes Owed", "$980"],
], "auction figures first");

eq(usDate("2022-04-25T00:00:00.000Z"), "04/25/2022", "usDate");
eq(ownershipLength(12), "1 Year", "1 year");
eq(ownershipLength(0), null, "zero months");

console.log("reapi-view: ok");
