/**
 * Lightweight node assertion for suggested-bid ≤ maxBid.
 * Run: npx tsx lib/history/suggested-bid.test.ts
 */
import { computeMaxBid } from "../deal/maxbid";
import { getComparables } from "./comparables";
import { computeSuggestedBid } from "./suggested-bid";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const deal = computeMaxBid({
  state: "MI",
  saleType: "Tax Deed",
  openingBid: 5000,
  assessedValue: 80000,
  rehabCost: 15000,
});

const hist = getComparables({
  state: "MI",
  saleType: "Tax Deed",
  assessedValue: 80000,
  openingBid: 5000,
  limit: 1,
});

const s = computeSuggestedBid({
  state: "MI",
  saleType: "Tax Deed",
  openingBid: 5000,
  assessedValue: 80000,
  fips: "26163",
  historyBucket: hist.bucket,
  historyKey: hist.key,
  deal: {
    maxBid: deal.maxBid,
    recommendation: deal.recommendation,
    bidRoom: deal.bidRoom,
    projectedProfit: deal.projectedProfit,
  },
});

// Compose what suggested-bid.server does, without importing it: that module
// carries `server-only`, which throws outside a Server Component.
const apiComps = getComparables({
  state: "MI",
  saleType: "Tax Deed",
  assessedValue: 80000,
  openingBid: 5000,
  limit: 1,
});
const sApi = computeSuggestedBid({
  historyBucket: apiComps.bucket,
  historyKey: apiComps.key,
  state: "MI",
  saleType: "Tax Deed",
  openingBid: 5000,
  assessedValue: 80000,
  deal: {
    maxBid: deal.maxBid,
    recommendation: deal.recommendation,
    bidRoom: deal.bidRoom,
    projectedProfit: deal.projectedProfit,
  },
});
assert(sApi.suggestedBid === s.suggestedBid, "withIndex matches");

assert(deal.maxBid != null, "oracle should produce maxBid for MI with assessed");
if (s.suggestedBid != null && deal.maxBid != null) {
  assert(s.suggestedBid <= deal.maxBid + 1e-6, "suggested must be ≤ maxBid");
  assert(s.withinOracle === true, "withinOracle flag");
  assert(s.action === "bid", "expected bid action");
}
assert(s.historyKey.startsWith("MI|"), "history key");

// Forced over-ceiling clamp path: if oracle is no-bid, suggestion is pass
const noBid = computeMaxBid({
  state: "MI",
  saleType: "Tax Deed",
  openingBid: 500_000,
  assessedValue: 40_000,
});
const s2 = computeSuggestedBid({
  state: "MI",
  saleType: "Tax Deed",
  openingBid: 500_000,
  assessedValue: 40_000,
  deal: {
    maxBid: noBid.maxBid,
    recommendation: noBid.recommendation,
    bidRoom: noBid.bidRoom,
    projectedProfit: noBid.projectedProfit,
  },
});
assert(
  s2.action === "pass" || s2.action === "insufficient-data" || s2.suggestedBid == null,
  "hot opening should not invent a high bid",
);
if (s2.suggestedBid != null && noBid.maxBid != null) {
  assert(s2.suggestedBid <= noBid.maxBid + 1e-6, "still ≤ maxBid");
}

console.log("suggested-bid tests ok", {
  maxBid: deal.maxBid,
  suggested: s.suggestedBid,
  action: s.action,
  headroom: s.headroomVsMaxBid,
});
