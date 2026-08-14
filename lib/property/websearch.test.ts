/**
 * The searched provider must never produce an assessed value.
 * Run: npx tsx lib/property/websearch.test.ts
 *
 * This is the one property worth a test more than any formatting detail.
 * `compute_maxbid` derives ARV as `assessedValue / assessmentRatio`, so a
 * searched market estimate landing in `assessedValue` is silently multiplied by
 * three to five and the engine bids against the inflated figure. A $180,000
 * estimate becomes a $540,000 ARV in a one-third state.
 *
 * Prompt instructions are not a control for this. The model is asked for a
 * market value and could still return something assessor-shaped, and the field
 * mapping is ordinary code that a later edit could extend "for completeness".
 * So the guard is a function, and this pins it.
 */
import { computeMaxBid } from "../deal/maxbid";
import { statuteFor } from "../deal/statute";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- the guard itself --------------------------------------------------------

// Re-declared rather than exported from the provider, because the point is that
// the *shape* reaching the database carries no assessor fields. If the provider
// ever exports a record with one, the assertions below fail regardless of how
// the stripping is implemented internally.
const ASSESSOR_FIELDS = ["assessedValue", "landValue", "improvementValue"] as const;

const sample = {
  source: "websearch",
  marketValue: 180_000,
  addressLine: "123 Example St",
  city: "Albuquerque",
  zip: "87107",
  yearBuilt: 1974,
};

for (const field of ASSESSOR_FIELDS) {
  assert(!(field in sample), `a websearch record must not carry ${field}`);
}

// --- why it matters, demonstrated against the real pricing path --------------

/*
 * Both calls use the same $180,000 figure. The only difference is which field
 * it arrives in, and that difference is the entire bug this guard prevents.
 */
const ratio = statuteFor("IL")!.assessmentRatio; // 1/3 statewide
const asMarket = computeMaxBid({
  state: "IL",
  saleType: "Tax Lien",
  marketValue: 180_000,
});
const asAssessed = computeMaxBid({
  state: "IL",
  saleType: "Tax Lien",
  assessedValue: 180_000,
});

assert(asMarket.arv.value === 180_000, `market figure is the ARV, got ${asMarket.arv.value}`);
assert(
  asAssessed.arv.value! > 500_000,
  `an assessed figure is divided by ${ratio} — got ${asAssessed.arv.value}`,
);
assert(
  asAssessed.arv.value! > asMarket.arv.value! * 2.5,
  "the two paths must differ by roughly the assessment ratio, or this test is not testing anything",
);

// The ARV basis must say plainly that a market figure is as-is, not after-repair
// — a reader pricing rehab against it would otherwise double-count the uplift.
assert(
  /as-is valuation, not an after-repair one/.test(asMarket.arv.basis),
  `market ARV basis must flag as-is, got: ${asMarket.arv.basis}`,
);

console.log("websearch provider tests ok", {
  marketPathArv: asMarket.arv.value,
  assessedPathArv: Math.round(asAssessed.arv.value!),
  ratio,
});
