/**
 * Max-bid engine.
 *
 * This is deterministic arithmetic, deliberately kept out of the language
 * model. The AI writes the narrative around these numbers; it never produces
 * the walk-away price. Someone is going to raise a paddle based on this
 * output, so every figure is traceable to an input or a cited statute, and
 * anything we don't know is reported as unknown rather than defaulted to a
 * flattering value.
 *
 * The model, in one line:
 *
 *   maxBid = ARV·(1 − margin) − sellingCosts − rehab − title − closing
 *            − holding − survivingLiens
 *
 * i.e. the highest bid that still clears your target margin after every cost
 * of turning a tax-sale parcel into resaleable, insurable property.
 */

import type { SaleType } from "../atlas/types";
import { coveredStateList, statuteFor, type StatuteParams } from "./statute";

export interface DealInputs {
  state: string;
  saleType: SaleType;
  /**
   * 5-digit county FIPS. Optional, but supplying it matters where a county
   * departs from its state's assessment ratio — Cook County assesses
   * residential at 10% against Illinois' statutory 33⅓%, so omitting it there
   * overstates the property threefold.
   */
  fips?: string;

  /** From the auction listing. */
  openingBid?: number;
  assessedValue?: number;

  /** A real comparable-sales figure, when the user has one. Beats everything. */
  arvOverride?: number;
  /**
   * A provider's market estimate for the parcel — ATTOM's market total value,
   * or a RentCast AVM.
   *
   * Ranks above the assessed-value derivation because it is a market figure
   * already, rather than an assessed figure divided by a statutory ratio. It
   * also needs no ratio at all, which is what makes it usable in the states
   * that have no `STATUTE_PARAMS` entry — the ones where a parcel could carry
   * a perfectly good valuation and still return insufficient-data.
   */
  marketValue?: number;
  /** Estimated cost to make the property resaleable. */
  rehabCost?: number;
  /** Required profit as a fraction of ARV. Default 30%. */
  targetMargin?: number;
  /** Months of carry before exit. Defaults to the state's quiet-title span + 2. */
  holdingMonths?: number;
  /** Known liens that survive the sale (municipal, HOA, federal). */
  survivingLiens?: number;
  /** Agent commission + seller closing costs on exit, as a fraction of ARV. */
  sellingCostRate?: number;
}

export interface CostLine {
  label: string;
  amount: number;
  /** Where the number came from — shown in the UI, never hidden. */
  note: string;
  /** True when this is an assumed default rather than a user or source value. */
  assumed: boolean;
}

export interface RedemptionOutlook {
  windowDays: number;
  /** Flat statutory penalty for the first tier, e.g. 0.25 for 25%. */
  flatPenalty: number;
  /** Dollar penalty earned if the owner redeems at the recommended max bid. */
  penaltyAtMaxBid: number;
  /**
   * The flat penalty expressed as an annual rate over the *shortest* window.
   *
   * Reported separately and labelled, because it is the number that gets
   * quoted misleadingly: Texas's 25% over a 180-day window annualises to
   * ~56%, which is true only if the owner redeems on the last possible day
   * and you immediately redeploy the capital.
   */
  annualisedBestCase: number;
  extendedFor?: string;
  note: string;
  /**
   * Where the penalty is set by bidding rather than statute, what the market
   * actually pays.
   *
   * `flatPenalty` above is the legal ceiling. In Illinois that ceiling is 18%
   * per six-month period and the observed clearing rate across 64,526 recorded
   * Cook County liens is a 0% median. Quoting the ceiling as the expected
   * return overstates it by roughly an order of magnitude.
   */
  marketPenalty?: {
    observedMedian: number;
    observedMean: number;
    n: number;
    penaltyAtMaxBidObserved: number;
    source: string;
    note: string;
  };
}

export type Recommendation = "bid" | "no-bid" | "insufficient-data";

export interface DealResult {
  /** The walk-away price. Null when we cannot responsibly produce one. */
  maxBid: number | null;
  recommendation: Recommendation;
  confidence: "high" | "medium" | "low";

  arv: {
    value: number | null;
    basis: string;
    derived: boolean;
    /**
     * True when a county-specific assessment ratio replaced the state default.
     * Surfaced so the UI can show which ratio produced the valuation rather
     * than implying the statewide one always applies.
     */
    countyOverride?: boolean;
  };
  costs: CostLine[];
  totalCosts: number;
  /** Profit at exactly `maxBid`, by construction equal to margin × ARV. */
  projectedProfit: number | null;
  /** Headroom between the opening bid and the ceiling — the room to compete. */
  bidRoom: number | null;

  redemption: RedemptionOutlook | null;
  statute: StatuteParams | null;
  warnings: string[];
}

const DEFAULTS = {
  targetMargin: 0.3,
  sellingCostRate: 0.08,
  /** Taxes, insurance, utilities, securing the property — per month, of ARV. */
  monthlyHoldingRate: 0.0015,
  minMonthlyHolding: 75,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimate market value from an assessed value using the state's assessment
 * ratio. Returns null when we have neither an override nor an assessment —
 * guessing an ARV is how a bidder ends up 3x over market.
 */
function deriveArv(
  inputs: DealInputs,
  statute: StatuteParams | null,
): { value: number | null; basis: string; derived: boolean; countyOverride?: boolean } {
  if (inputs.arvOverride !== undefined && inputs.arvOverride > 0) {
    return {
      value: inputs.arvOverride,
      basis: "Your comparable-sales estimate.",
      derived: false,
    };
  }

  /*
   * A provider's market estimate, ahead of the assessed-value derivation.
   *
   * It is an *as-is* market figure, not an after-repair one, and the basis
   * string says so — a tax-sale parcel is rarely in the condition an AVM
   * assumes, and treating the two as identical is how a max bid comes out
   * optimistic. It is still a better ARV input than assessed ÷ ratio, which is
   * the same guess with an extra division in front of it, and it is the only
   * one available at all in the states with no statutory ratio.
   */
  if (inputs.marketValue !== undefined && inputs.marketValue > 0) {
    return {
      value: inputs.marketValue,
      basis:
        `Provider market estimate of ${inputs.marketValue.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        })}. This is an as-is valuation, not an after-repair one — enter your own ` +
        `comparable-sales figure if the property needs work.`,
      derived: true,
    };
  }

  if (inputs.assessedValue === undefined || inputs.assessedValue <= 0) {
    return {
      value: null,
      basis:
        "The county published no assessed value for this parcel, no property provider returned " +
        "a market estimate, and no comparable-sales figure has been entered.",
      derived: false,
    };
  }

  if (!statute) {
    return {
      value: null,
      basis:
        `This parcel has an assessed value, but ${inputs.state} has no verified assessment ratio ` +
        `in lib/deal/statute.ts, so it cannot be converted to a market value. Enter a ` +
        `comparable-sales estimate to price it.`,
      derived: false,
    };
  }

  // A county override beats the state ratio. Cook County assesses residential
  // at 10% against Illinois' statutory 33⅓%; using the state figure there
  // triples the implied market value of the largest block of parcels we hold.
  const override = inputs.fips
    ? statute.countyAssessmentRatios?.[inputs.fips]
    : undefined;
  const ratio = override?.ratio ?? statute.assessmentRatio;
  const basis = override?.basis ?? statute.assessmentBasis;

  return {
    value: inputs.assessedValue / ratio,
    basis: `Assessed ${inputs.assessedValue.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })} ÷ ${ratio} assessment ratio. ${basis}`,
    derived: true,
    /** True when a county-specific ratio replaced the state default. */
    countyOverride: override !== undefined,
  };
}

export function computeMaxBid(inputs: DealInputs): DealResult {
  const statute = statuteFor(inputs.state);
  const warnings: string[] = [];

  const targetMargin = inputs.targetMargin ?? DEFAULTS.targetMargin;
  const sellingCostRate = inputs.sellingCostRate ?? DEFAULTS.sellingCostRate;
  const arv = deriveArv(inputs, statute);

  if (!statute) {
    warnings.push(
      `${inputs.state} is outside the states with verified statutory parameters ` +
        `(${coveredStateList().join(", ")}). ` +
        `Costs and redemption terms are not modelled — treat any figure here as unverified.`,
    );
  }

  if (arv.value === null) {
    return {
      maxBid: null,
      recommendation: "insufficient-data",
      confidence: "low",
      arv,
      costs: [],
      totalCosts: 0,
      projectedProfit: null,
      bidRoom: null,
      redemption: null,
      statute,
      /*
       * The basis carries the specific reason; this only says what to do about
       * it. "Not enough data" on its own is the complaint that produced this —
       * it reads as a defect in the product rather than as a missing input the
       * reader can supply in ten seconds, and it does not distinguish a parcel
       * nobody has valued from a state whose assessment ratio has not been
       * researched. Those need different actions from the reader.
       */
      warnings: [
        ...warnings,
        `${arv.basis} Enter a comparable-sales estimate below and every figure on this page ` +
          `recalculates — the engine needs one number, not a full appraisal.`,
      ],
    };
  }

  // --- Costs -------------------------------------------------------------
  const costs: CostLine[] = [];

  costs.push({
    label: "Selling costs on exit",
    amount: round2(arv.value * sellingCostRate),
    note: `${(sellingCostRate * 100).toFixed(1)}% of ARV — agent commission plus seller-side closing.`,
    assumed: inputs.sellingCostRate === undefined,
  });

  const rehab = inputs.rehabCost ?? 0;
  costs.push({
    label: "Rehab",
    amount: rehab,
    note:
      inputs.rehabCost === undefined
        ? "No rehab budget entered — assumed $0. Tax-sale parcels are sold unseen and un-inspected; this is rarely correct."
        : "Your rehab estimate.",
    assumed: inputs.rehabCost === undefined,
  });
  if (inputs.rehabCost === undefined) {
    warnings.push(
      "Rehab is assumed to be $0. You cannot inspect these properties before bidding — budget for the worst plausible condition.",
    );
  }

  const titleCost = statute
    ? (statute.quietTitle.typicalLow + statute.quietTitle.typicalHigh) / 2
    : 0;
  if (statute) {
    costs.push({
      label: statute.quietTitle.required ? "Quiet title (required)" : "Quiet title (often unnecessary)",
      amount: round2(titleCost),
      note:
        `Midpoint of the typical ${statute.state} range ` +
        `($${statute.quietTitle.typicalLow.toLocaleString()}–$${statute.quietTitle.typicalHigh.toLocaleString()}, ` +
        `~${statute.quietTitle.typicalMonths} months).`,
      assumed: true,
    });
  }

  if (statute) {
    costs.push({
      label: "Deed recording and transfer",
      amount: statute.closingCosts,
      note: `Typical ${statute.state} recording and deed issuance cost.`,
      assumed: true,
    });
  }

  const holdingMonths =
    inputs.holdingMonths ?? (statute ? statute.quietTitle.typicalMonths + 2 : 6);
  const monthlyHolding = Math.max(
    arv.value * DEFAULTS.monthlyHoldingRate,
    DEFAULTS.minMonthlyHolding,
  );
  costs.push({
    label: `Holding costs (${holdingMonths} months)`,
    amount: round2(monthlyHolding * holdingMonths),
    note: `Taxes, insurance, and securing the property at ~$${Math.round(monthlyHolding).toLocaleString()}/month.`,
    assumed: inputs.holdingMonths === undefined,
  });

  const survivingLiens = inputs.survivingLiens ?? 0;
  costs.push({
    label: "Surviving liens",
    amount: survivingLiens,
    note:
      inputs.survivingLiens === undefined
        ? "Assumed $0 — not verified. Municipal code-enforcement liens, special assessments, and federal tax liens can survive the sale."
        : "Your lien estimate.",
    assumed: inputs.survivingLiens === undefined,
  });
  if (inputs.survivingLiens === undefined && statute) {
    warnings.push(
      "Surviving liens assumed $0. " + (statute.caveats[0] ?? "Verify what survives in this jurisdiction."),
    );
  }

  // A ratio can be legally correct and still produce a misleading ARV.
  // California assesses at full cash value, so its ratio is honestly 1.0 — but
  // Proposition 13 freezes the base year, so a long-held parcel's assessed
  // value can sit far under market and the derived ARV understates it.
  if (arv.derived && statute?.derivedArvCaveat) {
    warnings.push(statute.derivedArvCaveat);
  }
  if (arv.derived && statute?.countyAssessmentRatios && !arv.countyOverride) {
    const counties = Object.keys(statute.countyAssessmentRatios);
    warnings.push(
      `${inputs.state} has ${counties.length} count${counties.length === 1 ? "y" : "ies"} ` +
        `on a different assessment ratio (${counties.join(", ")}). No FIPS was supplied, so the ` +
        `statewide ratio was used — pass \`fips\` if this parcel is in one of them.`,
    );
  }

  const totalCosts = round2(costs.reduce((n, c) => n + c.amount, 0));

  // --- The ceiling -------------------------------------------------------
  const maxBid = round2(arv.value * (1 - targetMargin) - totalCosts);
  const projectedProfit = round2(arv.value * targetMargin);

  // --- Redemption --------------------------------------------------------
  let redemption: RedemptionOutlook | null = null;
  if (statute?.redemption) {
    const firstTier = statute.redemption.tiers[0];
    // Texas's short window is 180 days; Georgia's and Arizona's first tier is
    // a full year. Use the shortest realistic window for the best case.
    const shortestDays = inputs.state === "TX" ? 180 : firstTier.throughDays;
    redemption = {
      windowDays: statute.redemption.maxDays,
      flatPenalty: firstTier.penalty,
      penaltyAtMaxBid: round2(Math.max(maxBid, 0) * firstTier.penalty),
      annualisedBestCase: round2((firstTier.penalty * 365) / shortestDays),
      extendedFor: statute.redemption.extendedFor,
      note:
        statute.saleType === "Tax Lien"
          ? `${inputs.state} sells liens: the expected outcome is redemption with interest, not ownership. Taking title needs a separate foreclosure after ${statute.redemption.maxDays} days.`
          : `A ${(firstTier.penalty * 100).toFixed(0)}% flat penalty applies if the owner redeems. It is a penalty, not annual interest — the rate does not change with how early they redeem.`,
    };

    const bidDown = statute.redemption.bidDown;
    if (bidDown) {
      redemption.marketPenalty = {
        observedMedian: bidDown.observedMedian,
        observedMean: bidDown.observedMean,
        n: bidDown.n,
        penaltyAtMaxBidObserved: round2(Math.max(maxBid, 0) * bidDown.observedMedian),
        source: bidDown.observedSource,
        note: bidDown.note,
      };
      // The ceiling is not the expectation, and a bidder reading only the
      // headline penalty would price this instrument an order of magnitude
      // wrong. Surface it as a warning, not a footnote.
      warnings.push(
        `${inputs.state} bids the penalty DOWN from ${(bidDown.statutoryMax * 100).toFixed(0)}%. ` +
          `Across ${bidDown.n.toLocaleString()} recorded sales the rate cleared at a ` +
          `${(bidDown.observedMedian * 100).toFixed(0)}% median (${(bidDown.observedMean * 100).toFixed(2)}% mean). ` +
          `Do not underwrite this on the statutory rate.`,
      );
    }
  }

  // --- Recommendation ----------------------------------------------------
  let recommendation: Recommendation = "bid";
  if (maxBid <= 0) {
    recommendation = "no-bid";
    warnings.push(
      "Costs exceed what the property can support at your target margin. There is no bid at which this clears.",
    );
  } else if (inputs.openingBid !== undefined && inputs.openingBid > maxBid) {
    recommendation = "no-bid";
    warnings.push(
      `The opening bid of $${inputs.openingBid.toLocaleString()} is already above your ceiling of $${maxBid.toLocaleString()}.`,
    );
  }

  const confidence: DealResult["confidence"] =
    !arv.derived && inputs.rehabCost !== undefined && statute
      ? "high"
      : statute && arv.value !== null
        ? "medium"
        : "low";

  return {
    maxBid,
    recommendation,
    confidence,
    arv,
    costs,
    totalCosts,
    projectedProfit,
    bidRoom:
      inputs.openingBid !== undefined ? round2(maxBid - inputs.openingBid) : null,
    redemption,
    statute,
    warnings,
  };
}
