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
import { statuteFor, type StatuteParams } from "./statute";

export interface DealInputs {
  state: string;
  saleType: SaleType;

  /** From the auction listing. */
  openingBid?: number;
  assessedValue?: number;

  /** A real comparable-sales figure, when the user has one. Beats the ratio. */
  arvOverride?: number;
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
}

export type Recommendation = "bid" | "no-bid" | "insufficient-data";

export interface DealResult {
  /** The walk-away price. Null when we cannot responsibly produce one. */
  maxBid: number | null;
  recommendation: Recommendation;
  confidence: "high" | "medium" | "low";

  arv: { value: number | null; basis: string; derived: boolean };
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
): { value: number | null; basis: string; derived: boolean } {
  if (inputs.arvOverride !== undefined && inputs.arvOverride > 0) {
    return {
      value: inputs.arvOverride,
      basis: "Your comparable-sales estimate.",
      derived: false,
    };
  }

  if (inputs.assessedValue === undefined || inputs.assessedValue <= 0) {
    return {
      value: null,
      basis: "No assessed value on the listing and no comparable-sales estimate provided.",
      derived: false,
    };
  }

  if (!statute) {
    return {
      value: null,
      basis: `No assessment-ratio data for ${inputs.state}; assessed value cannot be converted to market value.`,
      derived: false,
    };
  }

  return {
    value: inputs.assessedValue / statute.assessmentRatio,
    basis: `Assessed ${inputs.assessedValue.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })} ÷ ${statute.assessmentRatio} assessment ratio. ${statute.assessmentBasis}`,
    derived: true,
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
      `${inputs.state} is outside the five states with verified statutory parameters (FL, GA, TX, AZ, MI). ` +
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
      warnings: [
        ...warnings,
        "Cannot compute a max bid without an after-repair value. Add a comparable-sales estimate to proceed.",
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
