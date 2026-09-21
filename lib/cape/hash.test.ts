/**
 * A briefing's identity moves with the sale, not with every parcel enriched.
 * Run: npx tsx lib/cape/hash.test.ts
 *
 * The enrichment pass values parcels every ten minutes. When the exact coverage
 * counts were in the hash, each one made the largest sales' scripts stale, and
 * each stale script meant a rewrite and a re-rendered, re-narrated video.
 */
import { capeInputsHash, coverageBand, type PackageInput } from "./components";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

const base = {
  auctionId: "a", countyName: "Duval", state: "FL", saleDate: "2026-10-14", saleDateConfirmed: true,
  saleType: "Tax Deed", sourceUrl: "https://example.gov", platform: "realtaxdeed", startTime: null,
  registrationDeadline: null, depositDeadline: null, lotCount: 200, listingKind: "sale_list",
  rule: null, statute: null, offices: {}, logistics: null, population: 1_000_000, today: "2026-09-21",
  parcels: { total: 200, withParcelNumber: 200, withAssessed: 110, withAddress: 150, withZoning: 0, withGeo: 90 },
} as unknown as PackageInput;
const withParcels = (p: Partial<PackageInput["parcels"]>, extra: Partial<PackageInput> = {}) =>
  ({ ...base, ...extra, parcels: { ...base.parcels, ...p } }) as PackageInput;

assert(capeInputsHash(withParcels({ withAssessed: 111 })) === capeInputsHash(base), "one more parcel valued inside a band changes nothing");
assert(capeInputsHash(withParcels({ withGeo: 120 })) === capeInputsHash(base), "nor does geocoding inside a band");
assert(capeInputsHash(withParcels({ withAssessed: 190 })) !== capeInputsHash(base), "crossing into 'nearly all' does");
assert(capeInputsHash(withParcels({ total: 210 }, { lotCount: 210 })) !== capeInputsHash(base), "a crawl adding parcels does");
assert(capeInputsHash(withParcels({ withZoning: 1 })) !== capeInputsHash(base), "zoning appearing at all does");

assert(capeInputsHash({ ...base, reviewNotes: [] }) === capeInputsHash(base), "no notes is the same package");
assert(
  capeInputsHash({ ...base, reviewNotes: ["The sale is held in the annex, not the courthouse"] }) !== capeInputsHash(base),
  "a correction makes the script stale, so it is rewritten and re-rendered",
);

assert(coverageBand(0, 200) === "none", "none");
assert(coverageBand(110, 200) === "about half", "55% is about half");
assert(coverageBand(200, 200) === "all", "all");
assert(coverageBand(5, 0) === "none", "no parcels at all is none, not a division by zero");

console.log(`cape/hash: ${passed} assertions passed`);
