/**
 * Statute coverage and the two traps the IL/CA review surfaced.
 * Run: npx tsx lib/deal/statute.test.ts
 */
import { computeMaxBid } from "./maxbid";
import { STATUTE_PARAMS, coveredStateList, statuteFor } from "./statute";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

// --- coverage ----------------------------------------------------------------

const covered = coveredStateList();
assert(covered.includes("IL") && covered.includes("CA"), "IL and CA are now priceable");
assert(covered.length === 7, `expected 7 covered states, got ${covered.length}`);

// The warning for an uncovered state must be derived, not a stale hardcoded list.
const wy = computeMaxBid({ state: "WY", saleType: "Tax Deed", assessedValue: 50_000 });
assert(wy.recommendation === "insufficient-data", "uncovered state cannot be priced");
assert(
  wy.warnings.some((w) => w.includes("IL") && w.includes("CA")),
  "the uncovered-state warning must list the states we actually cover",
);

// --- every entry is internally coherent --------------------------------------

for (const [state, p] of Object.entries(STATUTE_PARAMS)) {
  assert(p.state === state, `${state}: key and state field disagree`);
  assert(p.assessmentRatio > 0 && p.assessmentRatio <= 1, `${state}: ratio out of range`);
  assert(p.quietTitle.typicalLow <= p.quietTitle.typicalHigh, `${state}: QT range inverted`);
  assert(p.sources.length > 0, `${state}: no sources`);
  assert(/^\d{4}-\d{2}$/.test(p.asOf), `${state}: asOf must be YYYY-MM`);
  if (p.redemption) {
    let prevDays = -1;
    let prevPenalty = -1;
    for (const t of p.redemption.tiers) {
      assert(t.throughDays > prevDays, `${state}: tiers must increase in days`);
      assert(t.penalty >= prevPenalty, `${state}: penalty must not decrease`);
      assert(t.penalty >= 0 && t.penalty <= 1, `${state}: penalty must be a fraction`);
      prevDays = t.throughDays;
      prevPenalty = t.penalty;
    }
    assert(p.redemption.maxDays >= prevDays, `${state}: maxDays below last tier`);
  }
  for (const [fips, o] of Object.entries(p.countyAssessmentRatios ?? {})) {
    assert(/^\d{5}$/.test(fips), `${state}: county key ${fips} is not a 5-digit FIPS`);
    assert(o.ratio > 0 && o.ratio <= 1, `${state}: county ratio out of range`);
    assert(o.basis.length > 20, `${state}: county override needs a stated basis`);
  }
}

// --- trap 1: Cook County's assessment ratio ----------------------------------

// Illinois assesses at 33⅓% statewide; Cook runs a classified system at ~10%.
// Cook is also 70,109 of our historical rows, so getting this wrong misvalues
// the largest single block of data we hold by a factor of three.
const base = { state: "IL", saleType: "Tax Lien" as const, assessedValue: 30_000, rehabCost: 15_000 };
const statewide = computeMaxBid(base);
const cook = computeMaxBid({ ...base, fips: "17031" });

assert(near(statewide.arv.value!, 30_000 / 0.3333, 5), "statewide uses the statutory ratio");
assert(near(cook.arv.value!, 300_000, 1), "Cook uses the 10% classified ratio");
assert(cook.arv.countyOverride === true, "Cook reports that an override applied");
assert(statewide.arv.countyOverride !== true, "non-Cook reports no override");
assert(cook.maxBid! > statewide.maxBid! * 2, "the ratio difference must move the ceiling");

// Omitting FIPS in a state that has overrides is a silent hazard, so it warns.
assert(
  statewide.warnings.some((w) => w.includes("17031")),
  "omitting FIPS in IL must warn that a county override exists",
);
assert(
  !cook.warnings.some((w) => w.includes("No FIPS was supplied")),
  "supplying FIPS must not warn about it",
);

// A county override in one state must not leak into another.
const az = computeMaxBid({ state: "AZ", saleType: "Tax Lien", fips: "17031", assessedValue: 30_000 });
assert(az.arv.countyOverride !== true, "Illinois' Cook override must not apply in Arizona");

// --- trap 2: the statutory cap is not the market rate ------------------------

// Illinois bids the penalty DOWN from 18%. Across 64,526 recorded Cook sales it
// cleared at a 0% median. Quoting the cap as a return overstates it ~10x.
const r = statewide.redemption!;
assert(r.flatPenalty === 0.18, "the statutory ceiling is still reported");
assert(r.marketPenalty !== undefined, "a bid-down state must report the market rate");
assert(r.marketPenalty!.observedMedian === 0, "recorded median is 0%");
assert(r.marketPenalty!.n === 64_526, "and says how many sales that is");
assert(
  r.marketPenalty!.penaltyAtMaxBidObserved < r.penaltyAtMaxBid,
  "observed penalty must be below the statutory figure",
);
assert(
  statewide.warnings.some((w) => w.includes("bids the penalty DOWN")),
  "the bid-down gap must be a warning, not a footnote",
);

// Texas's penalty is fixed by statute, so it has no market rate to report.
const tx = computeMaxBid({ state: "TX", saleType: "Redeemable Deed", assessedValue: 200_000 });
assert(tx.redemption!.marketPenalty === undefined, "TX penalty is statutory, not bid down");
assert(
  !tx.warnings.some((w) => w.includes("bids the penalty DOWN")),
  "TX must not carry a bid-down warning",
);

// --- trap 3: a legally correct ratio can still mislead -----------------------

const ca = computeMaxBid({ state: "CA", saleType: "Tax Deed", assessedValue: 200_000 });
assert(ca.arv.value === 200_000, "CA assesses at full cash value, so ARV equals assessed");
assert(
  ca.warnings.some((w) => w.includes("Proposition 13")),
  "a derived CA ARV must carry the Prop 13 caveat",
);
// The caveat is about *deriving* from assessed value; a real comp doesn't need it.
const caComp = computeMaxBid({ state: "CA", saleType: "Tax Deed", arvOverride: 400_000 });
assert(
  !caComp.warnings.some((w) => w.includes("Proposition 13")),
  "a user-supplied ARV must not be caveated for Prop 13",
);
assert(statuteFor("CA")!.redemption === null, "a California tax deed has no post-sale redemption");

console.log("statute tests ok", {
  covered: covered.join(","),
  statewideArv: Math.round(statewide.arv.value!),
  cookArv: Math.round(cook.arv.value!),
  statutoryPenalty: r.penaltyAtMaxBid,
  observedPenalty: r.marketPenalty!.penaltyAtMaxBidObserved,
});
