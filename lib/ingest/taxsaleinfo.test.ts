/**
 * Michigan catalog description parsing.
 * Run: npx tsx lib/ingest/taxsaleinfo.test.ts
 *
 * Every fixture below is a verbatim `raw.description` from the live database,
 * captured 2026-08-14, including the ones the previous parser got wrong.
 *
 * The asymmetry this pins: `address_line` feeds property enrichment, which looks
 * a property up *by address*. A null is skipped; a wrong string is trusted and
 * returns another property's valuation. So a fragment that might not be a street
 * must be refused, and the second block below is the more important one.
 */
import { parseCatalogDescription, readCatalogLabel } from "./adapters/taxsaleinfo";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- real streets must still be found ---------------------------------------

const good: [string, string, string | undefined][] = [
  ["House On Humboldt Ave, Flint", "Humboldt Ave", "Flint"],
  ["House On Freeman Ave, Flint", "Freeman Ave", "Flint"],
  ["~0.13 Acre Vacant Parcel On W Meyers Ave, Hazel Park", "W Meyers Ave", "Hazel Park"],
  // A slash separates street from city on some cards.
  ["Single Story Home On High Street / Jackson", "High Street", undefined],
];

for (const [desc, street, city] of good) {
  const got = parseCatalogDescription(desc);
  assert(got.street === street, `"${desc}" -> street ${JSON.stringify(got.street)}, want ${street}`);
  assert(got.city === city, `"${desc}" -> city ${JSON.stringify(got.city)}, want ${city}`);
}

// --- everything the old parser wrote into address_line ----------------------

/*
 * These produced, respectively: '~4.25 ... Sold for $280' (x58),
 * 'Wells Ave In Benton Harbor Sold for $5' (x77), 'Washington Ave In Ka...',
 * 'Us 2 !', '~0.19 Acres; John ...' and 'S Pittsfor...'. 852 of 2,128 Michigan
 * addresses carried a truncation marker and 494 carried a sale price.
 */
const mustNotContain = [
  "Beautiful Two Story House On ~4.25 ... Sold for $280,250.00 Lot 4707 ~7.45 Acre Parcel",
  "Vacant Lot On Wells Ave In Benton Harbor Sold for $5,100.00",
  "~0.22 Acre Vacant Lot On Washington Ave In Ka...",
  "~Three Acres On Us 2 !",
  "Failing Cabin On ~0.19 Acres; John ...",
  "~0.35 Acre Vacant Lot On S Pittsfor...",
  "~0.15 Acre Vacant Lot On 4Th Street / Bay Cit...",
  "~0.11 Acre Vacant Lot On Baldwin And 23Rd St ...",
];

for (const desc of mustNotContain) {
  const { street, city } = parseCatalogDescription(desc);
  if (street !== undefined) {
    assert(!/sold for/i.test(street), `sale price leaked into address: ${JSON.stringify(street)}`);
    assert(!/\$/.test(street), `dollar sign leaked into address: ${JSON.stringify(street)}`);
    assert(!/\.\.\.|…/.test(street), `truncation leaked into address: ${JSON.stringify(street)}`);
    assert(!/^~?[\d.]+\s*acre/i.test(street), `acreage read as a street: ${JSON.stringify(street)}`);
  }
  if (city !== undefined) {
    assert(!/\.\.\.|…/.test(city), `truncated city kept: ${JSON.stringify(city)}`);
  }
}

// A truncated card can still yield the street it did print, but never the city
// that lost its letters — "Benton Harbor" is real, "Ka..." and "Bay Cit..." are not.
const trunc = parseCatalogDescription("~0.22 Acre Vacant Lot On Washington Ave In Ka...");
assert(trunc.street === "Washington Ave", `truncated card keeps the street it printed, got ${trunc.street}`);
assert(trunc.city === undefined, "a truncated city is not a city");

// The sale-price case must keep nothing at all: what follows "On" is an acreage.
const sold = parseCatalogDescription(
  "Beautiful Two Story House On ~4.25 ... Sold for $280,250.00 Lot 4707 ~7.45 Acre Parcel",
);
assert(sold.street === undefined, `acreage after "On" is not a street, got ${sold.street}`);

// --- nothing to find is a valid answer --------------------------------------

for (const desc of ["", "Vacant Parcel W/Access Issues", "Farmhouse And 18+ Acre Parcel."]) {
  const got = parseCatalogDescription(desc);
  assert(got.street === undefined, `"${desc}" has no street, got ${JSON.stringify(got.street)}`);
}

// Re-offer catalogs are the county's second sale, not an unknown county.
for (const [label, county, reoffer] of [
  ["Arenac", "Arenac", false],
  ["Arenac Re-Offer", "Arenac", true],
  ["Van Buren Reoffer", "Van Buren", true],
  ["St. Joseph Re-offer", "St. Joseph", true],
] as const) {
  const got = readCatalogLabel(label);
  assert(got.county === county && got.reoffer === reoffer, `${label} -> ${JSON.stringify(got)}`);
}

console.log("taxsaleinfo description tests ok");
