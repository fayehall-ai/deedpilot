/**
 * RealEstateAPI mapping + failure-classification assertions.
 * Run: npx tsx lib/property/providers/realestateapi.test.ts
 *
 * No network: `globalThis.fetch` is stubbed. No db import either — the
 * provider only pulls in `../types` and `../retry`, so this runs in a few ms.
 *
 * The fixture is a trimmed copy of a real PropertyDetail response for a
 * Maitland FL parcel, kept verbatim in the parts that matter: the three
 * disagreeing valuations, the zeroed land/improvement split, the stringified
 * `lotAcres` and `lastSalePrice`, and the ISO-datetime sale date. Every one of
 * those is a coercion this mapping gets wrong if written carelessly.
 */
import {
  mapRecord,
  apnCandidates,
  buildAddress,
  extraApnCandidates,
  inCounty,
  addressParts,
  realestateapiProvider,
} from "./realestateapi";
import { ProviderUnavailableError } from "../types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Trimmed real response — Maitland FL, APN 29-21-30-3578-06-040. */
const FIXTURE = {
  propertyType: "SFR",
  estimatedValue: 560000,
  lastSalePrice: "549000",
  lastSaleDate: "2026-02-19",
  floodZone: false,
  floodZoneType: null,
  floodZoneDescription: null,
  taxInfo: {
    assessedValue: 180577,
    assessedLandValue: 0,
    assessedImprovementValue: 0,
    marketValue: 585520,
    estimatedValue: null,
    assessmentYear: 2025,
    year: 2025,
    taxAmount: "2117.35",
    taxDelinquentYear: null,
  },
  lotInfo: {
    apn: "29-21-30-3578-06-040",
    apnUnformatted: "292130357806040",
    lotAcres: "0.23",
    lotSquareFeet: 10011,
    zoning: "RSF-2",
    landUse: "Residential",
    propertyUse: "Single Family Residence",
  },
  propertyInfo: {
    address: {
      address: "2121 Thunderbird Trl",
      city: "Maitland",
      state: "FL",
      zip: "32751",
      county: "Orange County",
      fips: "12095",
    },
    bedrooms: 3,
    bathrooms: 2,
    partialBathrooms: 0,
    buildingSquareFeet: 2813,
    livingSquareFeet: 2080,
    yearBuilt: 1963,
    taxExemptionHomeownerFlag: true,
    latitude: 28.637657000103346,
    longitude: -81.3384212514644,
  },
  ownerInfo: { owner1FullName: "TEST OWNER", owner1Type: "Individual" },
  lastSale: { saleAmount: 549000, saleDate: "2026-02-19T00:00:00.000Z", armsLength: true },
};

/** Install a fetch stub; returns the recorded request bodies. */
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

async function main() {
  const origFetch = globalThis.fetch;
  process.env.REALESTATEAPI_API_KEY = "test-key";

  // ---- mapping -----------------------------------------------------------
  const r = mapRecord(FIXTURE as unknown as Record<string, unknown>);

  /*
   * The one that costs money if it is wrong. maxbid divides assessedValue by
   * the assessment ratio, so the AVM must never reach it.
   */
  eq(r.assessedValue, 180577, "assessedValue must be the tax assessment");
  eq(r.marketValue, 560000, "marketValue must be the AVM");
  assert(r.assessedValue !== 560000, "AVM leaked into assessedValue");
  assert(r.assessedValue !== 585520, "county market value leaked into assessedValue");

  // AVM absent → fall back to the county's full-market figure, still not assessed.
  const noAvm = mapRecord({ ...FIXTURE, estimatedValue: null } as unknown as Record<
    string,
    unknown
  >);
  eq(noAvm.marketValue, 585520, "marketValue should fall back to taxInfo.marketValue");
  eq(noAvm.assessedValue, 180577, "fallback must not disturb assessedValue");

  // Zeroed split dropped rather than published as "land worth nothing".
  eq(r.landValue, undefined, "zeroed assessedLandValue should be dropped");
  eq(r.improvementValue, undefined, "zeroed assessedImprovementValue should be dropped");

  // A genuine breakdown is kept.
  const split = mapRecord({
    ...FIXTURE,
    taxInfo: { ...FIXTURE.taxInfo, assessedLandValue: 40000, assessedImprovementValue: 140577 },
  } as unknown as Record<string, unknown>);
  eq(split.landValue, 40000, "real land value should survive");
  eq(split.improvementValue, 140577, "real improvement value should survive");

  // Coercions.
  eq(r.acreage, 0.23, "lotAcres arrives as a string and must be numeric");
  eq(r.lotSqft, 10011, "lotSqft");
  eq(r.buildingSqft, 2080, "buildingSqft must prefer living area, not total building");
  eq(r.yearBuilt, 1963, "yearBuilt");
  eq(r.beds, 3, "beds");
  eq(r.baths, 2, "baths must not double-count partialBathrooms");
  eq(r.taxYear, 2025, "taxYear from assessmentYear");
  eq(r.lastSaleAmount, 549000, "lastSaleAmount should prefer the numeric lastSale.saleAmount");
  eq(r.lastSaleDate, "2026-02-19", "ISO datetime should narrow to YYYY-MM-DD");
  eq(r.county, "Orange", '"Orange County" should reduce to the bare county name');
  eq(r.homestead, true, "homestead from taxExemptionHomeownerFlag");
  eq(r.zoning, "RSF-2", "zoning");
  eq(r.propertyType, "SFR", "propertyType");
  eq(r.landUse, "Residential", "landUse");
  eq(r.parcelNumber, "29-21-30-3578-06-040", "formatted APN preferred");
  eq(r.latitude, 28.637657000103346, "latitude");
  eq(r.source, "realestateapi", "source");

  // A never-traded parcel reports "0"; that is not a comp.
  const untraded = mapRecord({
    ...FIXTURE,
    lastSalePrice: "0",
    lastSale: {},
  } as unknown as Record<string, unknown>);
  eq(untraded.lastSaleAmount, undefined, 'lastSalePrice "0" must not become a $0 sale');

  /*
   * floodZone: false with no description stays undefined. The column is text
   * and cannot distinguish "not in a flood zone" from "no flood data", so
   * writing "none" would assert something unverified.
   */
  eq(r.floodZone, undefined, "absent flood description must not become a value");
  const flooded = mapRecord({
    ...FIXTURE,
    floodZone: true,
    floodZoneDescription: "AE",
  } as unknown as Record<string, unknown>);
  eq(flooded.floodZone, "AE", "flood zone description should be stored");

  // ---- identifier helpers ------------------------------------------------
  const cands = apnCandidates("29-21-30-3578-06-040");
  eq(cands.length, 2, "at most two APN candidates, to protect billed lookups");
  eq(cands[0], "29-21-30-3578-06-040", "clerk value first");
  eq(cands[1], "292130357806040", "stripped variant second");
  eq(apnCandidates("292130357806040").length, 1, "no separators means no second attempt");
  eq(apnCandidates("   ").length, 0, "blank parcel yields nothing");

  // Another county's parcel is refused, whatever matched it.
  const orange = { state: "FL", fips: "12095", countyName: "Orange" };
  eq(inCounty(FIXTURE as unknown as Record<string, unknown>, orange), true, "same fips accepted");
  eq(inCounty(FIXTURE as unknown as Record<string, unknown>, { ...orange, fips: "12117", countyName: "Seminole" }), false, "other fips refused");
  eq(
    buildAddress({ state: "NY", fips: "36007", countyName: "Broome", addressLine: "1 Irving Ave" }),
    null,
    "street + state alone is not an address: it matched Fulton for a Binghamton parcel",
  );
  eq(
    apnCandidates("43-036-009-000-0000").join("|"),
    "43-036-009-000-0000|43-036-009|430360090000000",
    "zero-padded PA parcel: as printed, then trimmed, then stripped",
  );
  eq(apnCandidates("01-035-034").length, 2, "no zero tail, no trimmed attempt");

  // County-specific shapes.
  const base = { state: "OR", countyName: "Klamath" };
  eq(
    extraApnCandidates({ ...base, fips: "41035", parcelNumber: "3610001D002600" }).join("|"),
    "R-3610-001D0-02600-000",
    "Klamath map tax lot reformatted to its assessor's account form",
  );
  eq(extraApnCandidates({ ...base, fips: "41047", parcelNumber: "3610001D002600" }).length, 0, "Klamath rule is Klamath-only");
  eq(
    extraApnCandidates({ ...base, fips: "41047", countyName: "Marion", parcelNumber: "592058", addressLine: "073W27CD07200" }).join("|"),
    "073W27CD07200",
    "Marion tax lot in the address column tried as the APN",
  );
  eq(extraApnCandidates({ ...base, fips: "41047", addressLine: "1201 Commercial St SE" }).length, 0, "a real address is not a tax lot");

  eq(JSON.stringify(addressParts("7093 STATE RD 70")), JSON.stringify({ house: "7093", street: "STATE RD 70" }), "house + street");
  eq(addressParts("2025"), null, "a bare number is not an address");
  eq(
    JSON.stringify(addressParts("2025 27175 ENGEBRETSON RD")),
    JSON.stringify({ house: "27175", street: "ENGEBRETSON RD" }),
    "leaked tax year dropped",
  );
  eq(addressParts("125 BENSON AVE W ; 137 BENSON AVE W"), null, "two addresses are not one");

  eq(
    buildAddress({ state: "FL", fips: "12095", countyName: "Orange", addressLine: "2121 Thunderbird Trl", city: "Maitland", zip: "32751" }),
    "2121 Thunderbird Trl, Maitland FL 32751",
    "address string shape",
  );
  eq(
    buildAddress({ state: "FL", fips: "12095", countyName: "Orange", addressLine: null }),
    null,
    "no street means no address lookup",
  );

  // ---- request ordering --------------------------------------------------
  {
    const seen = stubFetch(() => ({ status: 200, json: { statusCode: 200, data: FIXTURE } }));
    const rec = await realestateapiProvider.lookup({
      state: "FL",
      fips: "12095",
      countyName: "Orange",
      parcelNumber: "29-21-30-3578-06-040",
      addressLine: "2121 Thunderbird Trl",
      city: "Maitland",
      zip: "32751",
    });
    eq(seen.length, 1, "a first-try match must not spend a second lookup");
    eq(seen[0].apn, "29-21-30-3578-06-040", "APN is asked before address");
    eq(seen[0].fips, "12095", "fips accompanies the APN");
    eq(rec?.marketValue, 560000, "record returned from the APN path");
  }

  // ---- no-match is HTTP 200 with a 404 body ------------------------------
  {
    const seen = stubFetch(() => ({
      status: 200,
      json: { statusCode: 404, statusMessage: "Not Found", data: {} },
    }));
    const rec = await realestateapiProvider.lookup({
      state: "FL",
      fips: "12095",
      countyName: "Orange",
      parcelNumber: "99-99-99-9999-99-999",
    });
    eq(rec, null, "a body-level 404 is a genuine miss, not an outage");
    eq(seen.length, 2, "both APN candidates should be tried before conceding");
  }

  // Falls through APN misses to the address attempt.
  {
    const seen = stubFetch((body) =>
      body.address
        ? { status: 200, json: { statusCode: 200, data: FIXTURE } }
        : { status: 200, json: { statusCode: 404, data: {} } },
    );
    const rec = await realestateapiProvider.lookup({
      state: "FL",
      fips: "12095",
      countyName: "Orange",
      parcelNumber: "29-21-30-3578-06-040",
      addressLine: "2121 Thunderbird Trl",
      city: "Maitland",
      zip: "32751",
    });
    eq(seen.length, 3, "two APN candidates then the address");
    eq(rec?.assessedValue, 180577, "address attempt recovered the record");
  }

  // Last resort: county-scoped search by house + street, one id only, then detail by id.
  const BURNETT = {
    ...FIXTURE,
    propertyInfo: {
      ...FIXTURE.propertyInfo,
      address: { ...FIXTURE.propertyInfo.address, county: "Burnett County", fips: "55013" },
    },
  };
  {
    const seen = stubFetch((body) =>
      body.ids_only
        ? { status: 200, json: { statusCode: 200, data: [309561666] } }
        : body.id
          ? { status: 200, json: { statusCode: 200, data: BURNETT } }
          : { status: 200, json: { statusCode: 404, data: {} } },
    );
    const rec = await realestateapiProvider.lookup({
      state: "WI",
      fips: "55013",
      countyName: "Burnett",
      parcelNumber: "19734",
      addressLine: "7093 STATE RD 70",
    });
    const search = seen.find((b) => b.ids_only);
    eq(search?.county, "Burnett", "search scoped to the county");
    eq(search?.house, "7093", "house number sent");
    eq(seen[seen.length - 1].id, "309561666", "detail fetched by the one id");
    assert(rec, "record returned via search");

    stubFetch((body) =>
      body.ids_only
        ? { status: 200, json: { statusCode: 200, data: [1, 2] } }
        : { status: 200, json: { statusCode: 404, data: {} } },
    );
    const amb = await realestateapiProvider.lookup({
      state: "WI",
      fips: "55013",
      countyName: "Burnett",
      parcelNumber: "19734",
      addressLine: "7093 STATE RD 70",
    });
    eq(amb, null, "two candidates is a guess, not a match");
  }

  // ---- provider-level failures throw, so the batch aborts ----------------
  const unavailable = async (
    status: number,
    json: unknown,
    label: string,
  ) => {
    stubFetch(() => ({ status, json }));
    let threw: unknown = null;
    try {
      await realestateapiProvider.lookup({
        state: "FL",
        fips: "12095",
        countyName: "Orange",
        parcelNumber: "29-21-30-3578-06-040",
      });
    } catch (e) {
      threw = e;
    }
    assert(
      threw instanceof ProviderUnavailableError,
      `${label} must raise ProviderUnavailableError, got ${threw}`,
    );
  };

  await unavailable(
    401,
    { statusCode: 401, error: "Unauthorized", errorCode: "AUTH_KEY_NOT_FOUND" },
    "a rejected key",
  );
  await unavailable(403, { statusCode: 403, message: "Forbidden" }, "a forbidden key");
  await unavailable(402, { statusCode: 402, message: "Payment Required" }, "payment required");
  await unavailable(
    400,
    { statusCode: 400, message: "Your plan limit has been exceeded" },
    "an exhausted plan",
  );
  await unavailable(
    429,
    { statusCode: 429, message: "Too Many Requests" },
    "sustained rate limiting",
  );

  // A plain bad-request must NOT be treated as an outage — it is our input.
  {
    stubFetch(() => ({ status: 400, json: { statusCode: 400, message: "Invalid zip format" } }));
    const rec = await realestateapiProvider.lookup({
      state: "FL",
      fips: "12095",
      countyName: "Orange",
      parcelNumber: "29-21-30-3578-06-040",
    });
    eq(rec, null, "a malformed-identifier 400 is a miss, not a dead provider");
  }

  // Unconfigured provider answers null without touching the network.
  {
    const saved = process.env.REALESTATEAPI_API_KEY;
    delete process.env.REALESTATEAPI_API_KEY;
    eq(realestateapiProvider.configured(), false, "no key means not configured");
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch;
    const rec = await realestateapiProvider.lookup({
      state: "FL",
      fips: "12095",
      countyName: "Orange",
      parcelNumber: "1",
    });
    eq(rec, null, "unconfigured lookup returns null");
    eq(called, false, "unconfigured lookup must not hit the network");
    process.env.REALESTATEAPI_API_KEY = saved;
  }

  globalThis.fetch = origFetch;
  console.log("realestateapi: all assertions passed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
