/**
 * Statute coverage and the two traps the IL/CA review surfaced.
 * Run: npx tsx lib/deal/statute.test.ts
 */
import { computeMaxBid } from "./maxbid";
import { STATUTE_PARAMS, coveredStateList, statuteFor } from "./statute";
import { FLOOR_RATIOS } from "./floor-ratios";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

// --- coverage ----------------------------------------------------------------

const covered = coveredStateList();
assert(covered.includes("IL") && covered.includes("CA"), "IL and CA are now priceable");
/*
 * Asserted as an invariant, not a count. This line read `covered.length === 7`
 * and started failing the moment Arkansas was promoted — a passing test turned
 * red by a change it was never guarding, which teaches an operator to ignore it.
 * What actually matters is that the list is derived from the table rather than
 * maintained by hand beside it.
 */
assert(covered.length === Object.keys(STATUTE_PARAMS).length, "covered list must be derived from the table");
assert(new Set(covered).size === covered.length, "covered list has duplicates");

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

// --- market value as an ARV source ------------------------------------------

// The case this was added for: a state with no STATUTE_PARAMS entry, so a
// parcel with an assessed value still returned insufficient-data because there
// was no ratio to convert it with. 779 upcoming Arkansas parcels sat in that
// state while carrying a market estimate nobody read.
//
// Arkansas was the example until it was promoted, which turned this into a test
// asserting that a *covered* state cannot be priced — it failed for the one
// reason we most wanted to be able to cause. The subject is now derived, so
// promoting any particular state can never invalidate the case again.
const NOT_COVERED = ["WY", "VT", "ND", "NH"].find((s) => !statuteFor(s));
assert(NOT_COVERED, "this case needs a state with no statutory entry; all candidates are covered");
const arNoRatio = computeMaxBid({ state: NOT_COVERED!, saleType: "Tax Deed", assessedValue: 30_000 });
assert(
  arNoRatio.recommendation === "insufficient-data",
  "assessed value alone is still unpriceable without a ratio",
);
const arWithMarket = computeMaxBid({
  state: NOT_COVERED!,
  saleType: "Tax Deed",
  assessedValue: 30_000,
  marketValue: 120_000,
});
assert(
  arWithMarket.recommendation !== "insufficient-data",
  `a market estimate prices it without a ratio, got ${arWithMarket.recommendation}`,
);
assert(arWithMarket.arv.value === 120_000, `ARV is the market figure, got ${arWithMarket.arv.value}`);
assert(
  /as-is valuation, not an after-repair one/.test(arWithMarket.arv.basis),
  "the basis says plainly that an AVM is not an after-repair value",
);

// Precedence: the reader's own comps beat a provider estimate, which beats the
// assessed ÷ ratio derivation. Getting this order wrong would silently override
// a figure someone researched by hand.
const precedence = computeMaxBid({
  state: "IL",
  saleType: "Tax Lien",
  assessedValue: 30_000,
  marketValue: 120_000,
  arvOverride: 250_000,
});
assert(precedence.arv.value === 250_000, `user comps win, got ${precedence.arv.value}`);
const overRatio = computeMaxBid({
  state: "IL",
  saleType: "Tax Lien",
  assessedValue: 30_000,
  marketValue: 120_000,
});
assert(overRatio.arv.value === 120_000, `market beats the ratio, got ${overRatio.arv.value}`);

// A zero or negative estimate is not a valuation — it must not price a parcel.
for (const bad of [0, -1]) {
  assert(
    computeMaxBid({ state: "AR", saleType: "Tax Deed", marketValue: bad }).recommendation ===
      "insufficient-data",
    `marketValue ${bad} is not a valuation`,
  );
}

// And the message names the missing input rather than saying "not enough data".
const nothing = computeMaxBid({ state: "AR", saleType: "Tax Deed" });
assert(
  nothing.warnings.some((w) => /no assessed value|published no assessed value/i.test(w)),
  `the warning says what is missing, got: ${nothing.warnings.join(" | ")}`,
);
assert(
  nothing.warnings.some((w) => /comparable-sales estimate/i.test(w)),
  "and what to do about it",
);

// --- the assumed floor -------------------------------------------------------

// Arkansas is 5,420 of the unpriceable parcels and has 889 measured pairs.
const arFloor = computeMaxBid({ state: "AR", saleType: "Tax Deed", openingBid: 1_000 });
assert(arFloor.arv.assumed === true, "flagged as assumed");
assert(arFloor.arv.value !== null, "a floor exists where the state is measured");
assert(
  arFloor.recommendation !== "insufficient-data",
  `the page stops saying not-enough-data, got ${arFloor.recommendation}`,
);
assert(arFloor.confidence === "low", "an assumed floor is always low confidence");
assert(
  /Assumed floor, not a valuation of this parcel/.test(arFloor.arv.basis),
  "the basis leads with what it is not",
);
assert(
  arFloor.arv.basis.includes(FLOOR_RATIOS.AR.n.toLocaleString()),
  "and cites its sample size",
);

/*
 * Conservative quartile, not the median — wrong low beats wrong high at an
 * auction. Derived from the table rather than pinned to a number: the ratios
 * are regenerated as enrichment shifts the distribution, and an assertion on
 * today's value fails on a healthy re-run while saying nothing about the rule.
 * AR's p25 has already moved 10.82 → 10.39 once.
 */
assert(
  arFloor.arv.value === 1_000 * FLOOR_RATIOS.AR.p25,
  `p25 is used, got ${arFloor.arv.value} against p25 ${FLOOR_RATIOS.AR.p25}`,
);
assert(
  FLOOR_RATIOS.AR.p25 < FLOOR_RATIOS.AR.median,
  "and p25 really is the conservative end",
);

// States with no measured entry get nothing. Louisiana is 1,638 unpriceable
// parcels and no observed pairs; inventing a ratio for it would be worse than
// the message it replaces.
const laFloor = computeMaxBid({ state: "LA", saleType: "Tax Deed", openingBid: 1_000 });
assert(
  laFloor.recommendation === "insufficient-data",
  "an unmeasured state gets no floor, not a national average",
);
assert(laFloor.arv.assumed !== true, "and is not flagged as assumed");

// A floor never outranks something real.
const realBeatsFloor = computeMaxBid({
  state: "AR",
  saleType: "Tax Deed",
  openingBid: 1_000,
  marketValue: 90_000,
});
assert(realBeatsFloor.arv.value === 90_000, "a provider estimate beats the floor");
assert(realBeatsFloor.arv.assumed !== true, "and is not assumed");
assert(
  computeMaxBid({ state: "AR", saleType: "Tax Deed", openingBid: 1_000, arvOverride: 50_000 })
    .arv.assumed !== true,
  "nor does the reader's own figure become assumed",
);

// No opening bid, no floor — there is nothing to multiply.
assert(
  computeMaxBid({ state: "AR", saleType: "Tax Deed" }).recommendation === "insufficient-data",
  "no opening bid means no floor",
);
for (const bad of [0, -5]) {
  assert(
    computeMaxBid({ state: "AR", saleType: "Tax Deed", openingBid: bad }).arv.assumed !== true,
    `an opening bid of ${bad} is not a basis for a floor`,
  );
}

// A green light off a placeholder is the most dangerous output here, so it is
// never allowed to stand unqualified.
if (arFloor.recommendation === "bid") {
  assert(
    arFloor.warnings.some((w) => /not a green light/.test(w)),
    "a bid off an assumed floor carries its own warning",
  );
}
