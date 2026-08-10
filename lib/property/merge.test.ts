/**
 * Cross-provider merge assertions.
 * Run: npx tsx lib/property/merge.test.ts
 *
 * This file exists because the bug it pins shipped: the lot page rendered
 * `valuations[0]`, so a parcel enriched by ATTOM in June and RentCast in
 * August showed the August row — and the assessment ATTOM had already been
 * paid for disappeared from the page as an em dash.
 */
import { mergeValuations, provenanceLabel } from "./merge";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

type Row = Parameters<typeof mergeValuations>[0][number];

const row = (o: Partial<Row> & { source: string; fetchedAt: Date }) =>
  ({
    id: `id-${o.source}`,
    lotId: "lot-1",
    taxYear: null,
    assessedLand: null,
    assessedImprovement: null,
    assessedTotal: null,
    marketValue: null,
    lastSaleAmount: null,
    lastSaleDate: null,
    homestead: null,
    zoning: null,
    floodZone: null,
    beds: null,
    baths: null,
    lotSqft: null,
    buildingSqft: null,
    yearBuilt: null,
    propertyType: null,
    raw: null,
    ...o,
  }) as Row;

const JUNE = new Date("2026-06-01T00:00:00Z");
const AUGUST = new Date("2026-08-01T00:00:00Z");

// --- the regression this file is named for -----------------------------------

const attom = row({
  source: "attom",
  fetchedAt: JUNE,
  assessedTotal: "1711090.00",
  assessedLand: "207693.00",
  assessedImprovement: "1503397.00",
});
const rentcast = row({ source: "rentcast", fetchedAt: AUGUST, marketValue: "291000.00" });

const merged = mergeValuations([rentcast, attom])!;
assert(merged.assessedTotal === "1711090.00", `assessment survives, got ${merged.assessedTotal}`);
assert(merged.assessedLand === "207693.00", "land survives a newer, thinner provider");
assert(merged.assessedImprovement === "1503397.00", "improvement survives too");
assert(merged.marketValue === "291000.00", "and the newer provider still contributes its field");

// Provenance is per field — "enriched via rentcast" over an ATTOM assessment
// is a small lie on a page whose claim is that you can check the numbers.
assert(merged.sources.assessedTotal === "attom", "assessment credited to attom");
assert(merged.sources.marketValue === "rentcast", "market value credited to rentcast");
assert(
  provenanceLabel(merged) === "rentcast + attom",
  `both sources named, got ${provenanceLabel(merged)}`,
);

// --- recency still wins where providers genuinely disagree -------------------

const older = row({ source: "a", fetchedAt: JUNE, marketValue: "100.00" });
const newer = row({ source: "b", fetchedAt: AUGUST, marketValue: "200.00" });
assert(
  mergeValuations([older, newer])!.marketValue === "200.00",
  "newest wins when both have the field",
);
// Input order must not decide it — the caller could hand these over either way.
assert(
  mergeValuations([newer, older])!.marketValue === "200.00",
  "and sorting is defensive, not dependent on caller order",
);

// --- falsy values are values ------------------------------------------------

// The three that would break under a truthiness check: a boolean false, a
// county that genuinely assessed at zero, and a parcel with no bedrooms.
const falsy = mergeValuations([
  row({ source: "x", fetchedAt: AUGUST, homestead: false, assessedTotal: "0.00", beds: 0 }),
  row({ source: "y", fetchedAt: JUNE, homestead: true, assessedTotal: "500.00", beds: 3 }),
])!;
assert(falsy.homestead === false, "homestead:false is an answer, not an absence");
assert(falsy.assessedTotal === "0.00", "an assessed 0 is an answer");
assert(falsy.beds === 0, "0 bedrooms is an answer");

// An empty string is an absence, though — that is a provider returning nothing.
const blank = mergeValuations([
  row({ source: "x", fetchedAt: AUGUST, zoning: "" }),
  row({ source: "y", fetchedAt: JUNE, zoning: "AA1" }),
])!;
assert(blank.zoning === "AA1", `blank string falls through, got ${JSON.stringify(blank.zoning)}`);

// --- shape ------------------------------------------------------------------

assert(mergeValuations([]) === null, "no rows → null, not an empty husk");

const solo = mergeValuations([row({ source: "attom", fetchedAt: JUNE, beds: 3 })])!;
assert(solo.beds === 3 && solo.zoning === null, "unset fields are null, not undefined");
assert(solo.contributors.join() === "attom", "one contributor");

// A provider that contributed nothing is not credited.
const nothing = mergeValuations([
  row({ source: "attom", fetchedAt: JUNE, beds: 3 }),
  row({ source: "empty", fetchedAt: AUGUST }),
])!;
assert(
  !nothing.contributors.includes("empty"),
  `a provider with no values is not listed, got ${nothing.contributors.join()}`,
);

console.log("property merge: all assertions passed");
