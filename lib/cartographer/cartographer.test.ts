/**
 * Cartographer validation assertions.
 *
 * These pin the checks that stand between a drafted number and a walk-away
 * price. No network — drafting is a model call, validation is the part that
 * must be deterministic.
 * Run: npx tsx lib/cartographer/cartographer.test.ts
 */
import { coveredStates, uncoveredStates } from "./index";
import { renderProposal, validateProposal, type StatuteProposal } from "./validate";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const GOOD: StatuteProposal = {
  state: "IL",
  saleType: "Tax Lien",
  redemption: {
    tiers: [
      { throughDays: 182, penalty: 0.09 },
      { throughDays: 365, penalty: 0.18 },
    ],
    maxDays: 913,
    extendedFor: "Owner-occupied residential",
  },
  quietTitle: { typicalLow: 2500, typicalHigh: 7000, typicalMonths: 6, required: true },
  closingCosts: 350,
  assessmentRatio: 0.3333,
  assessmentBasis: "Illinois assesses at one-third of fair market value outside Cook County.",
  statute: "35 ILCS 200/21",
  asOf: "2026-07",
  sources: ["https://www.ilga.gov/legislation/ilcs/ilcs3.asp"],
  caveats: ["Quiet-title cost is market practice, not statute."],
  provenance: {
    assessmentRatio: { source: "https://www.ilga.gov/x", asOf: "2026-07" },
    redemption: { source: "https://www.ilga.gov/y", asOf: "2026-07" },
    quietTitle: { source: "https://www.ilga.gov/z", asOf: "2026-07" },
    closingCosts: { source: "https://www.ilga.gov/w", asOf: "2026-07" },
  },
};

const clone = (over: Partial<StatuteProposal>): StatuteProposal => ({ ...GOOD, ...over });

assert(validateProposal(GOOD).ok, "a well-formed, fully cited proposal passes");

// --- the percentage-vs-fraction trap ----------------------------------------

// This is the error that would make every price in a state wrong by 100x.
const pctRatio = validateProposal(clone({ assessmentRatio: 33.33 }));
assert(!pctRatio.ok, "an assessment ratio expressed as a percentage must be rejected");
assert(
  pctRatio.issues.some((i) => i.field === "assessmentRatio"),
  "and must name the field",
);

const pctPenalty = validateProposal(
  clone({ redemption: { tiers: [{ throughDays: 365, penalty: 18 }], maxDays: 365 } }),
);
assert(!pctPenalty.ok, "a penalty expressed as a percentage must be rejected");

assert(!validateProposal(clone({ assessmentRatio: 0 })).ok, "zero ratio rejected");
assert(!validateProposal(clone({ assessmentRatio: -0.4 })).ok, "negative ratio rejected");
assert(validateProposal(clone({ assessmentRatio: 1.0 })).ok, "Texas assesses at 100% — allowed");

// --- redemption coherence ----------------------------------------------------

assert(
  !validateProposal(
    clone({
      redemption: {
        tiers: [
          { throughDays: 365, penalty: 0.25 },
          { throughDays: 182, penalty: 0.5 },
        ],
        maxDays: 730,
      },
    }),
  ).ok,
  "tiers must increase in throughDays",
);

assert(
  !validateProposal(
    clone({
      redemption: {
        tiers: [
          { throughDays: 182, penalty: 0.5 },
          { throughDays: 365, penalty: 0.25 },
        ],
        maxDays: 730,
      },
    }),
  ).ok,
  "redeeming later must never cost the owner less",
);

assert(
  !validateProposal(
    clone({ redemption: { tiers: [{ throughDays: 913, penalty: 0.18 }], maxDays: 365 } }),
  ).ok,
  "maxDays shorter than the last tier is incoherent",
);

// A lien whose whole instrument is the redemption cannot lack one.
assert(
  !validateProposal(clone({ saleType: "Tax Lien", redemption: null })).ok,
  "a Tax Lien with no redemption period is contradictory",
);
assert(
  validateProposal(
    clone({
      saleType: "Tax Deed",
      redemption: null,
      // Michigan: redemption is extinguished at the foreclosure judgment.
    }),
  ).ok,
  "a Tax Deed with no redemption is normal",
);

// --- quiet title -------------------------------------------------------------

assert(
  !validateProposal(
    clone({ quietTitle: { typicalLow: 9000, typicalHigh: 2000, typicalMonths: 6, required: true } }),
  ).ok,
  "low above high is rejected",
);
assert(
  !validateProposal(
    clone({ quietTitle: { typicalLow: 0, typicalHigh: 0, typicalMonths: 6, required: true } }),
  ).ok,
  "required but free is contradictory",
);

// --- provenance is per field -------------------------------------------------

const missingCite = clone({
  provenance: { assessmentRatio: { source: "https://www.ilga.gov/x", asOf: "2026-07" } },
});
const mc = validateProposal(missingCite);
assert(!mc.ok, "a record-level citation is not enough — each field ages separately");
assert(mc.uncited.includes("redemption"), "uncited fields are named for the reviewer");
assert(mc.uncited.length === 3, `expected 3 uncited, got ${mc.uncited.length}`);

assert(
  !validateProposal(
    clone({
      provenance: { ...GOOD.provenance, redemption: { source: "not-a-url", asOf: "2026-07" } },
    }),
  ).ok,
  "a malformed citation URL is rejected",
);

// A non-official host is a warning, not a rejection — secondary sources are
// often the only thing available for quiet-title practice.
const secondary = validateProposal(
  clone({
    provenance: {
      ...GOOD.provenance,
      quietTitle: { source: "https://someblog.example.com/costs", asOf: "2026-07" },
    },
  }),
);
assert(secondary.ok, "a secondary source warns rather than blocks");
assert(
  secondary.issues.some((i) => i.severity === "warning" && i.field.includes("quietTitle")),
  "but it does warn",
);

assert(!validateProposal(clone({ asOf: "2026" })).ok, "asOf must be YYYY-MM");
assert(!validateProposal(clone({ sources: [] })).ok, "at least one source required");
assert(!validateProposal(clone({ statute: "" })).ok, "statutory citation required");
assert(!validateProposal(clone({ assessmentBasis: "" })).ok, "a bare ratio cannot be reviewed");

// --- rendering carries the citations ----------------------------------------

const rendered = renderProposal(GOOD);
assert(rendered.includes("assessmentRatio: 0.3333"), "renders the ratio");
assert(rendered.includes("https://www.ilga.gov/x"), "renders per-field citations as comments");
assert(rendered.includes('state: "IL"'), "renders the state");

const uncitedRender = renderProposal(missingCite);
assert(uncitedRender.includes("UNCITED"), "an uncited field is marked in the rendered output");

// --- coverage accounting -----------------------------------------------------

const covered = coveredStates();
const uncovered = uncoveredStates();

/*
 * Asserted as an invariant rather than a count. Pinning `covered.length === 7`
 * meant every promotion broke this test for the right reason and the wrong
 * one — Arkansas landing on 13 August failed it while proving it worked. The
 * property that actually matters is that the two lists partition the atlas
 * exactly, with no state in both and none in neither.
 */
assert(covered.length > 0, "some states must be priceable");
assert(
  covered.length + uncovered.length === 51,
  `covered (${covered.length}) and uncovered (${uncovered.length}) must partition 50 states + DC`,
);
assert(
  covered.every((s) => !uncovered.includes(s)),
  "no state may appear as both covered and a gap",
);
// IL and CA were the first two drafted and have since been reviewed and
// promoted, so they must no longer appear as gaps.
assert(covered.includes("IL") && covered.includes("CA"), "IL and CA are now priceable");
assert(!uncovered.includes("IL") && !uncovered.includes("CA"), "and are no longer gaps");
// Arkansas was promoted on 13 August with a searched market-practice pass and
// an assessment ratio measured against 1,669 parcels.
assert(covered.includes("AR"), "AR is priceable");
assert(!uncovered.includes("AR"), "and is no longer a gap");
assert(
  !covered.some((s) => uncovered.includes(s)),
  "covered and uncovered must be disjoint",
);

console.log("cartographer tests ok", {
  covered: covered.join(","),
  uncoveredCount: uncovered.length,
});
