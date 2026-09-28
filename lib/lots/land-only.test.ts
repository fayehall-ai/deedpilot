/**
 * Which parcels count as land-only.
 * Run: npx tsx lib/lots/land-only.test.ts
 */
import { isLandOnly, type LandOnlyFields } from "./land-only";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const base: LandOnlyFields = { addressLine: null, landUse: null, buildingSqft: null, yearBuilt: null };
const lot = (o: Partial<LandOnlyFields>) => ({ ...base, ...o });

assert(isLandOnly(lot({})), "no address is land");
assert(isLandOnly(lot({ addressLine: "   " })), "blank address is land");
assert(isLandOnly(lot({ addressLine: "0 MAIN ST" })), "zero house number is land");
assert(isLandOnly(lot({ addressLine: " 00 Oak Rd" })), "padded zero house number is land");
assert(isLandOnly(lot({ addressLine: "MAIN ST" })), "street name without a number is land");
assert(isLandOnly(lot({ addressLine: "Oak Ridge Rd, Lot 4" })), "no leading house number is land");
assert(isLandOnly(lot({ addressLine: "12 Elm St", landUse: "Vacant" })), "vacant tag wins over an address");
assert(isLandOnly(lot({ addressLine: "12 Elm St", landUse: "Res 1-3 Unimpr Land" })), "unimproved tag");

assert(!isLandOnly(lot({ addressLine: "12 Elm St" })), "a numbered address is kept");
assert(!isLandOnly(lot({ addressLine: "105 Main St" })), "a house number starting 10x is not zero");
assert(!isLandOnly(lot({ addressLine: "0123 Main St" })), "leading zero on a real number is kept");
assert(!isLandOnly(lot({ addressLine: "12 Elm St", landUse: "Residential" })), "residential kept");
assert(!isLandOnly(lot({ addressLine: "MAIN ST", buildingSqft: 1400 })), "a building overrides a numberless street");
assert(!isLandOnly(lot({ buildingSqft: 1200 })), "a building overrides a missing address");
assert(!isLandOnly(lot({ addressLine: "0 MAIN ST", yearBuilt: 1978 })), "year built overrides zero address");
assert(!isLandOnly(lot({ landUse: "Vacant", buildingSqft: 900 })), "a building overrides a vacant tag");

console.log("land-only: ok");
