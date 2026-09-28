/**
 * RealEstateAPI Property Search mapping + failure classification.
 * Run: npx tsx lib/property/providers/realestateapi.test.ts
 *
 * No network: `globalThis.fetch` is stubbed. The fixture follows the documented
 * Property Search record — flat fields, `address` as an object, the sale amount
 * as a string — which is where careless coercions go wrong.
 */
import { apnCandidates, buildAddress, mapRecord, realestateapiProvider } from "./realestateapi";
import { ProviderUnavailableError } from "../types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const RECORD = {
  id: "253175355",
  apn: "13-0133-LL-230-7",
  address: {
    address: "2201 Crossrail Dr, Atlanta, GA 30318",
    street: "2201 Crossrail Dr",
    city: "Atlanta",
    county: "Fulton County",
    state: "GA",
    zip: "30318",
  },
  latitude: 33.78,
  longitude: -84.43,
  yearBuilt: 2004,
  squareFeet: 1650,
  lotSquareFeet: 4356,
  bedrooms: 3,
  bathrooms: 2,
  assessedValue: 98000,
  assessedLandValue: 30000,
  assessedImprovementValue: 68000,
  estimatedValue: 310000,
  estimatedEquity: 190000,
  equityPercent: 61,
  openMortgageBalance: 120000,
  lastSaleAmount: "185000",
  lastSaleDate: "2015-06-01",
  owner1FirstName: "Pat",
  owner1LastName: "Example",
  propertyType: "SFR",
  propertyUse: "Single Family Residence",
  landUse: "Residential",
  floodZone: true,
  floodZoneType: "AE",
};

function stubFetch(responder: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const seen: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push(body);
    const { status, json } = responder(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  }) as typeof fetch;
  return seen;
}

const found = (rec: unknown) => ({ status: 200, json: { statusCode: 200, data: [rec], resultCount: 1 } });
const none = { status: 200, json: { statusCode: 200, data: [], resultCount: 0 } };

const INPUT = {
  state: "GA",
  fips: "13121",
  countyName: "Fulton",
  parcelNumber: "13-0133-LL-230-7",
  addressLine: "2201 CROSSRAIL DR",
  city: "Atlanta",
  zip: null,
};

async function main() {
  const origFetch = globalThis.fetch;
  process.env.REALESTATEAPI_API_KEY = "test-key";

  // ---- mapping -----------------------------------------------------------
  const r = mapRecord(RECORD);
  eq(r.assessedValue, 98000, "assessedValue is the tax assessment");
  eq(r.marketValue, 310000, "marketValue is the AVM");
  eq(r.landValue, 30000, "land split kept");
  eq(r.improvementValue, 68000, "improvement split kept");
  eq(r.lastSaleAmount, 185000, "string sale amount parsed");
  eq(r.lastSaleDate, "2015-06-01", "sale date");
  eq(r.addressLine, "2201 Crossrail Dr", "street, not the full label");
  eq(r.county, "Fulton", "county suffix stripped");
  eq(r.ownerName, "Pat Example", "owner joined");
  eq(r.buildingSqft, 1650, "living area");
  eq(r.acreage, 0.1, "acreage from lot sqft");
  eq(r.floodZone, "AE", "flood zone letter, not the boolean");
  eq(r.propertyType, "Single Family Residence", "property use");
  eq((r.raw as Record<string, unknown>).openMortgageBalance, 120000, "mortgage kept in raw");

  const zeroed = mapRecord({ ...RECORD, assessedLandValue: 0, assessedImprovementValue: 0 });
  eq(zeroed.landValue, undefined, "zeroed split dropped");
  eq(zeroed.improvementValue, undefined, "zeroed split dropped");

  const vacant = mapRecord({ ...RECORD, squareFeet: 0, yearBuilt: 0, bedrooms: 0, lastSaleAmount: "0", estimatedValue: 0 });
  eq(vacant.buildingSqft, undefined, "0 sqft means no building");
  eq(vacant.yearBuilt, undefined, "0 year built dropped");
  eq(vacant.lastSaleAmount, undefined, "$0 sale is not a sale");
  eq(vacant.marketValue, undefined, "$0 AVM is not a value");

  const corp = mapRecord({ ...RECORD, companyName: "ACME HOLDINGS LLC" });
  eq(corp.ownerName, "ACME HOLDINGS LLC", "company name wins");

  // ---- helpers -------------------------------------------------------------
  eq(apnCandidates("13-0133-LL-230-7").join("|"), "13-0133-LL-230-7|130133LL2307", "two APN forms");
  eq(apnCandidates("130133").length, 1, "already bare: one attempt");
  eq(buildAddress({ ...INPUT, city: null, zip: null, state: "" }), null, "no locality, no address search");

  // ---- lookup --------------------------------------------------------------
  let seen = stubFetch(() => found(RECORD));
  let rec = await realestateapiProvider.lookup(INPUT);
  eq(rec?.marketValue, 310000, "APN hit");
  eq(seen.length, 1, "one billed call on a hit");
  eq(seen[0].apn, "13-0133-LL-230-7", "APN sent as published");
  eq(seen[0].fips, "13121", "fips sent");
  eq(seen[0].size, 1, "one record requested");

  // Punctuation differs, same parcel → accepted.
  seen = stubFetch(() => found({ ...RECORD, apn: "130133LL2307" }));
  rec = await realestateapiProvider.lookup(INPUT);
  assert(rec, "same APN without punctuation is a match");

  // Autocomplete returned a different parcel → not accepted, falls to address.
  seen = stubFetch((b) => (b.apn ? found({ ...RECORD, apn: "13-0133-LL-231-0" }) : found(RECORD)));
  rec = await realestateapiProvider.lookup(INPUT);
  eq(seen.length, 3, "two APN forms rejected, then address");
  assert(typeof seen[2].address === "string", "address search last");
  assert(rec, "address hit accepted");

  // Genuine miss everywhere → null, not a throw.
  stubFetch(() => none);
  eq(await realestateapiProvider.lookup(INPUT), null, "empty data is a miss");
  stubFetch(() => ({ status: 200, json: { statusCode: 404, statusMessage: "Not Found" } }));
  eq(await realestateapiProvider.lookup(INPUT), null, "body 404 is a miss");

  // Dead wallet / key → ProviderUnavailableError, which aborts a batch.
  for (const [status, json] of [
    [402, { statusCode: 402, message: "Insufficient wallet balance.", errorCode: "WALLET_INSUFFICIENT_BALANCE" }],
    [401, { message: "Unauthorized" }],
    [400, { message: "Insufficient wallet balance" }],
  ] as const) {
    stubFetch(() => ({ status, json }));
    let threw = false;
    try {
      await realestateapiProvider.lookup(INPUT);
    } catch (e) {
      threw = e instanceof ProviderUnavailableError;
    }
    assert(threw, `${status} must raise ProviderUnavailableError`);
  }

  // No key → not configured, no call.
  process.env.REALESTATEAPI_API_KEY = "";
  assert(!realestateapiProvider.configured(), "unconfigured without key");

  globalThis.fetch = origFetch;
  console.log("realestateapi: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
