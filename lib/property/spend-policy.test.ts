/**
 * Which parcels may cost a paid RealEstateAPI lookup.
 * Run: npx tsx lib/property/spend-policy.test.ts
 */
import { paidLookupRefusal, type SpendFields } from "./spend-policy";

function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const ok: SpendFields = {
  saleType: "Tax Deed",
  auctionStatus: "scheduled",
  delisted: false,
  saleDateConfirmed: true,
  listingKind: "sale_list",
  announcedParcelCount: null,
  lotStatus: "pending",
  addressLine: "2201 CROSSRAIL DR",
  landUse: null,
  buildingSqft: null,
  yearBuilt: null,
};
const p = (o: Partial<SpendFields>) => paidLookupRefusal({ ...ok, ...o });

eq(p({}), null, "pending improved parcel in a deed sale is allowed");
eq(p({ saleType: "Redeemable Deed" }), null, "redeemable deed allowed");
eq(p({ saleType: "Hybrid" }), null, "hybrid allowed");

eq(p({ saleType: "Tax Lien" }), "tax lien sale", "lien sale refused");
eq(p({ auctionStatus: "cancelled" }), "sale cancelled", "cancelled sale refused");
eq(p({ delisted: true }), "sale cancelled", "delisted sale refused");
eq(p({ listingKind: "delinquent_list" }), "not a sale list (delinquent_list)", "delinquent roll refused");
eq(p({ listingKind: "unknown" }), "not known to be a sale list", "unread list refused");
eq(p({ listingKind: "unknown", announcedParcelCount: 946 }), null, "announced sale allowed");
eq(p({ saleDateConfirmed: false }), "sale date not confirmed", "projected date refused");
eq(p({ lotStatus: "withdrawn" }), "parcel withdrawn", "withdrawn parcel refused");
eq(p({ lotStatus: "redeemed" }), "parcel redeemed", "redeemed parcel refused");
eq(p({ addressLine: null }), "land-only parcel", "no address refused");
eq(p({ addressLine: "0 MAIN ST" }), "land-only parcel", "zero house number refused");
eq(p({ addressLine: "MAIN ST" }), "land-only parcel", "numberless street refused");
eq(p({ addressLine: "MAIN ST", buildingSqft: 1400 }), null, "a building overrides the address rule");

console.log("spend-policy: ok");
