/**
 * Structured statutory parameters for the deal maths.
 *
 * The atlas stores redemption rules as prose, which is right for reading and
 * useless for arithmetic. This module encodes the same rules as numbers for
 * the five covered states only — every entry carries its statute and a check
 * date, and states without an entry return null so the engine degrades to
 * "we can't compute this, here's the prose" instead of inventing a number.
 *
 * These figures move with legislation. Re-verify against the cited statute
 * before trusting a computed max bid in a state whose `asOf` has gone stale.
 */

import type { SaleType } from "../atlas/types";

export interface RedemptionTier {
  /** Upper bound of this tier, in days from the sale/deed date. */
  throughDays: number;
  /**
   * Penalty as a fraction of the bid, e.g. 0.25 for 25%.
   *
   * Texas and Georgia levy a flat *penalty*, not interest — 25% is 25%
   * whether the owner redeems on day 3 or day 179. Annualising it produces
   * absurd headline yields, so the engine reports both the flat penalty and a
   * separate annualised figure, clearly labelled.
   */
  penalty: number;
}

export interface StatuteParams {
  state: string;
  saleType: SaleType;
  /** Null when the sale conveys clear title with no post-sale redemption. */
  redemption: {
    tiers: RedemptionTier[];
    /** Longest possible redemption window, in days. */
    maxDays: number;
    /** Property classes that get the longer window, in plain language. */
    extendedFor?: string;
  } | null;
  /**
   * Typical cost to obtain insurable title, in dollars. A tax deed is not a
   * warranty deed; in most states you cannot resell or finance until this is
   * done, and leaving it out is the single most common way a "profitable"
   * tax deed purchase turns out not to be.
   */
  quietTitle: { typicalLow: number; typicalHigh: number; typicalMonths: number; required: boolean };
  /** Recording, documentary stamps, and deed issuance, as a rough fixed cost. */
  closingCosts: number;
  /**
   * Assessed value as a fraction of fair market value — the most dangerous
   * number in this file.
   *
   * Georgia assesses at 40% of FMV and Michigan at 50%. Treating a Georgia
   * assessment as market value understates the property by 2.5x and makes
   * every parcel in the state look like a catastrophic overpay. Texas
   * assesses at 100% by statute, so the same code with one ratio would be
   * badly wrong in four of the five covered states.
   */
  assessmentRatio: number;
  /** How that ratio is set, for the "where did this number come from" panel. */
  assessmentBasis: string;
  statute: string;
  /** YYYY-MM this entry was last verified. */
  asOf: string;
  sources: string[];
  /** Anything that materially changes the maths and isn't a number. */
  caveats: string[];
}

export const STATUTE_PARAMS: Record<string, StatuteParams> = {
  TX: {
    state: "TX",
    saleType: "Redeemable Deed",
    redemption: {
      // Tex. Tax Code § 34.21. Non-homestead, non-agricultural: 180 days at
      // 25%. Homestead/agricultural: 2 years, 25% in year one, 50% in year two.
      tiers: [
        { throughDays: 365, penalty: 0.25 },
        { throughDays: 730, penalty: 0.5 },
      ],
      maxDays: 730,
      extendedFor: "homestead and agricultural-use property (2 years); all other property is 180 days",
    },
    quietTitle: { typicalLow: 2500, typicalHigh: 6000, typicalMonths: 4, required: true },
    closingCosts: 400,
    assessmentRatio: 1.0,
    assessmentBasis:
      "Texas requires appraisal at 100% of market value as of Jan 1 (Tex. Tax Code § 23.01).",
    statute: "Tex. Tax Code § 34.21 (right of redemption)",
    asOf: "2026-07",
    sources: [
      "https://statutes.capitol.texas.gov/Docs/TX/htm/TX.34.htm",
      "https://liensuite.com/tax-deed/texas",
    ],
    caveats: [
      "The 180-day vs 2-year window turns on the property's use at the time of sale, which the sale list does not state — treat any homestead-looking residential parcel as potentially 2-year.",
      "Purchaser takes subject to the redemption right; you cannot deliver insurable title until it expires.",
      "The 25% is a flat penalty, not annual interest.",
    ],
  },

  GA: {
    state: "GA",
    saleType: "Redeemable Deed",
    redemption: {
      // O.C.G.A. § 48-4-40 et seq. 20% flat for the first year; an additional
      // 10% for each year thereafter until the right is barred by notice.
      tiers: [
        { throughDays: 365, penalty: 0.2 },
        { throughDays: 730, penalty: 0.3 },
        { throughDays: 1095, penalty: 0.4 },
      ],
      maxDays: 1095,
      extendedFor:
        "redemption stays open indefinitely until the purchaser forecloses it by statutory notice (barment)",
    },
    quietTitle: { typicalLow: 3000, typicalHigh: 7500, typicalMonths: 6, required: true },
    closingCosts: 350,
    assessmentRatio: 0.4,
    assessmentBasis:
      "Georgia assesses at 40% of fair market value (O.C.G.A. § 48-5-7).",
    statute: "O.C.G.A. § 48-4-40 through § 48-4-48 (redemption and barment)",
    asOf: "2026-07",
    sources: [
      "https://law.justia.com/codes/georgia/title-48/chapter-4/article-3/",
      "https://www.accgov.com/1717/Right-of-Redemption",
    ],
    caveats: [
      "The 12-month period is a minimum, not an expiry — the redemption right persists until you serve barment notice, so budget for that process.",
      "A redeemable deed conveys no right of possession during the redemption period.",
    ],
  },

  FL: {
    state: "FL",
    saleType: "Tax Deed",
    // Florida extinguishes the owner's right at the sale itself; redemption
    // must happen before the auction closes.
    redemption: null,
    quietTitle: { typicalLow: 2500, typicalHigh: 5500, typicalMonths: 4, required: true },
    closingCosts: 500,
    assessmentRatio: 0.85,
    assessmentBasis:
      "Florida assesses at just value, but Save Our Homes / Amendment 1 caps compress assessed below market on long-held homesteads.",
    statute: "Fla. Stat. ch. 197 (tax deed sales)",
    asOf: "2026-07",
    sources: ["http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0197/0197.html"],
    caveats: [
      "Governmental liens (municipal code enforcement, some special assessments) can survive a Florida tax deed — check the specific municipality.",
      "Federal tax liens survive with a 120-day IRS right of redemption after the sale.",
      "Most title insurers will not insure until a quiet title action completes, and many not until a year after recording.",
    ],
  },

  AZ: {
    state: "AZ",
    saleType: "Tax Lien",
    redemption: {
      // A.R.S. § 42-18152. Three years from the sale before the certificate
      // holder may bring a judicial foreclosure. Interest is bid down from
      // 16% and accrues annually, so it is modelled as an annual rate rather
      // than a flat penalty (see `annualInterest` handling in maxbid.ts).
      tiers: [{ throughDays: 1095, penalty: 0.16 }],
      maxDays: 1095,
      extendedFor: "interest is bid down at auction from a 16% statutory maximum",
    },
    quietTitle: { typicalLow: 2000, typicalHigh: 5000, typicalMonths: 5, required: true },
    closingCosts: 300,
    assessmentRatio: 0.85,
    assessmentBasis:
      "Arizona uses Limited Property Value, which lags full cash value and is capped at 5% annual growth (A.R.S. § 42-13301).",
    statute: "A.R.S. Title 42, ch. 18 (tax liens and foreclosure)",
    asOf: "2026-07",
    sources: ["https://www.azleg.gov/arsDetail/?title=42"],
    caveats: [
      "Arizona sells liens, not deeds — the usual outcome is redemption with interest, not property ownership.",
      "Taking title requires a separate judicial foreclosure after 3 years, at additional legal cost.",
      "16% is the maximum; competitive auctions routinely bid the rate into low single digits.",
    ],
  },

  MI: {
    state: "MI",
    saleType: "Tax Deed",
    // MCL 211.78k — the foreclosure judgment extinguishes all prior interests
    // before the property reaches the auction.
    redemption: null,
    quietTitle: { typicalLow: 1500, typicalHigh: 4000, typicalMonths: 3, required: false },
    closingCosts: 300,
    assessmentRatio: 0.5,
    assessmentBasis:
      "Michigan state equalized value is 50% of true cash value by constitution (Mich. Const. art. IX, § 3); taxable value may be lower still. " +
      "The SEV published with these auction listings is taken from the delinquent tax year that was foreclosed upon, so it is typically several years stale — " +
      "in a rising market it understates current value, and in a falling one it overstates it.",
    statute: "MCL 211.78 et seq. (general property tax act, foreclosure)",
    asOf: "2026-07",
    sources: ["https://www.legislature.mi.gov/Laws/MCL?objectName=MCL-211-78K"],
    caveats: [
      "Michigan's foreclosure judgment cuts off prior liens and the owner's interest, so title is comparatively clean — quiet title is often unnecessary.",
      "Valuations here derive from a stale SEV, not comps. Treat the computed ARV as a starting point and override it with real comparable sales before bidding at the ceiling.",
      "Rand v. Rand / Hall-era excess-proceeds rules mean former owners may claim surplus; this does not affect the buyer's title.",
    ],
  },
};

export function statuteFor(state: string): StatuteParams | null {
  return STATUTE_PARAMS[state] ?? null;
}

/** Whether the deal engine can produce numbers for this state at all. */
export function hasStatuteParams(state: string): boolean {
  return state in STATUTE_PARAMS;
}
