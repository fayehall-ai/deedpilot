/**
 * History-guided suggested bid, always ≤ oracle maxBid.
 *
 * Mirrors copilot history_guidance + policy decide (without LLM):
 *   ceiling = maxBid − historyBuffer
 *   target  = ceiling × bidFraction
 *   bid     = blend(opening, target) capped at ceiling
 *
 * Pure module (no Node fs) so the client DealCalculator can recompute live.
 * Pass bucket stats from the server (or from getComparables on the server/API).
 */

import type { DealResult } from "@/lib/deal/maxbid";
import type { HistoryBucket } from "@/lib/history/types";

export interface SuggestedBidInput {
  state: string;
  saleType: string;
  openingBid?: number;
  assessedValue?: number;
  fips?: string;
  /** Preloaded history bucket (from history_index). Optional. */
  historyBucket?: HistoryBucket | null;
  historyKey?: string;
  /** Oracle result from computeMaxBid — required for a numeric suggestion. */
  deal: Pick<DealResult, "maxBid" | "recommendation" | "bidRoom" | "projectedProfit">;
}

export interface SuggestedBidResult {
  /** Null when pass / insufficient data / no oracle max. */
  suggestedBid: number | null;
  action: "bid" | "pass" | "insufficient-data";
  /** Oracle walk-away; suggestion is always ≤ this when both set. */
  maxBid: number | null;
  historyBufferUsd: number;
  bidFractionOfCeiling: number;
  ceilingAfterBuffer: number | null;
  /** true if suggestedBid ≤ maxBid (or both null). */
  withinOracle: boolean;
  historyKey: string;
  historyN: number;
  medianWinningBid: number | null;
  pRedeem: number | null;
  notes: string[];
  /** How far suggested is under maxBid (null if pass). */
  headroomVsMaxBid: number | null;
  /** suggested − opening (null if either missing). */
  roomAboveOpening: number | null;
  /** suggested − median historical sold (null if unknown). */
  vsMedianSold: number | null;
}

function guidanceFromBucket(
  bucket: HistoryBucket | null,
  key: string,
  opts: {
    oracleMaxBid: number | null;
    openingBid?: number;
    assessedValue?: number;
    saleType: string;
  },
): {
  buffer: number;
  bidFrac: number;
  notes: string[];
  n: number;
  medWin: number | null;
  pRedeem: number | null;
} {
  const notes: string[] = [];
  let buffer = 0;
  let bidFrac = 0.9;

  if (!bucket) {
    notes.push(`No historical bucket for ${key}; suggestion uses oracle only.`);
    return {
      buffer: 0,
      bidFrac: 0.9,
      notes,
      n: 0,
      medWin: null,
      pRedeem: null,
    };
  }

  // Count only rows whose price is a comparable clearing price. Illinois
  // publishes 70k sold liens, but they are bid down on the penalty rate with the
  // price pinned to taxes owed — quoting that as "history n=70,109" would imply
  // market evidence the bucket does not have. See copilot/deedpilot_copilot/labels.py.
  const n = bucket.nComparablePrices ?? bucket.nWithWinningBid ?? bucket.n;
  const medWin = bucket.medianWinningBid;
  const medRatio = bucket.medianBidToAssessed;
  const pRedeem = bucket.pRedeem;
  const oracleMaxBid = opts.oracleMaxBid;

  if (n >= 20 && medWin != null && oracleMaxBid != null && oracleMaxBid > 0) {
    if (medWin < oracleMaxBid * 0.55) {
      bidFrac = 0.82;
      notes.push(
        `History n=${n}: median sold $${Math.round(medWin).toLocaleString()} is well below oracle $${Math.round(oracleMaxBid).toLocaleString()} — target ~${Math.round(bidFrac * 100)}% of ceiling.`,
      );
    } else if (medWin > oracleMaxBid * 0.95) {
      buffer += Math.min(5000, oracleMaxBid * 0.03);
      notes.push(
        `History n=${n}: median sold near/above oracle — add $${Math.round(buffer).toLocaleString()} caution buffer.`,
      );
    } else {
      notes.push(
        `History n=${n}: median sold $${Math.round(medWin).toLocaleString()} vs oracle $${Math.round(oracleMaxBid).toLocaleString()}.`,
      );
    }
  } else if (n > 0) {
    notes.push(`History n=${n} for ${key} — limited sample; light guidance only.`);
  } else {
    notes.push(`No winning-bid history for ${key}; oracle-only suggestion.`);
  }

  if (
    medRatio != null &&
    opts.openingBid != null &&
    opts.assessedValue != null &&
    opts.assessedValue > 0
  ) {
    const openRatio = opts.openingBid / opts.assessedValue;
    if (openRatio > medRatio * 1.4) {
      const extra = Math.min(
        4000,
        (openRatio - medRatio) * opts.assessedValue * 0.15,
      );
      buffer += extra;
      notes.push(
        `Opening/assessed ${(openRatio * 100).toFixed(1)}% is hot vs hist median ${(medRatio * 100).toFixed(1)}% — +$${Math.round(extra).toLocaleString()} buffer.`,
      );
    }
  }

  if (
    pRedeem != null &&
    pRedeem >= 0.45 &&
    (opts.saleType === "Redeemable Deed" ||
      opts.saleType === "Tax Lien" ||
      opts.saleType === "Hybrid")
  ) {
    notes.push(
      `Historical/shrunk p_redeem≈${Math.round(pRedeem * 100)}% — size position for redemption outcome.`,
    );
  }

  return {
    buffer: Math.round(buffer * 100) / 100,
    bidFrac,
    notes,
    n,
    medWin,
    pRedeem,
  };
}

/**
 * Compute history-guided suggested bid. Always ≤ maxBid when both are numeric.
 */
export function computeSuggestedBid(input: SuggestedBidInput): SuggestedBidResult {
  const { state, saleType, openingBid, assessedValue, deal } = input;
  const key = input.historyKey ?? `${state}|${saleType}`;
  const bucket = input.historyBucket ?? null;
  const maxBid = deal.maxBid;

  const g = guidanceFromBucket(bucket, key, {
    oracleMaxBid: maxBid,
    openingBid,
    assessedValue,
    saleType,
  });

  if (deal.recommendation === "insufficient-data" || maxBid == null) {
    return {
      suggestedBid: null,
      action: "insufficient-data",
      maxBid,
      historyBufferUsd: g.buffer,
      bidFractionOfCeiling: g.bidFrac,
      ceilingAfterBuffer: null,
      withinOracle: true,
      historyKey: key,
      historyN: g.n,
      medianWinningBid: g.medWin,
      pRedeem: g.pRedeem,
      notes: [...g.notes, "Oracle needs ARV/assessed data before a bid can be suggested."],
      headroomVsMaxBid: null,
      roomAboveOpening: null,
      vsMedianSold: null,
    };
  }

  const ceiling = Math.max(0, maxBid - g.buffer);
  if (deal.recommendation === "no-bid" || ceiling <= 0) {
    return {
      suggestedBid: null,
      action: "pass",
      maxBid,
      historyBufferUsd: g.buffer,
      bidFractionOfCeiling: g.bidFrac,
      ceilingAfterBuffer: ceiling,
      withinOracle: true,
      historyKey: key,
      historyN: g.n,
      medianWinningBid: g.medWin,
      pRedeem: g.pRedeem,
      notes: [
        ...g.notes,
        deal.recommendation === "no-bid"
          ? "Oracle says no-bid — suggestion is pass."
          : "Ceiling after history buffer is non-positive — pass.",
      ],
      headroomVsMaxBid: null,
      roomAboveOpening:
        openingBid != null ? Math.round((0 - openingBid) * 100) / 100 : null,
      vsMedianSold: g.medWin != null ? Math.round((0 - g.medWin) * 100) / 100 : null,
    };
  }

  const targetCeiling = ceiling * g.bidFrac;
  const opening = openingBid ?? 0;
  let bid: number;
  if (opening > 0 && opening < targetCeiling) {
    bid = Math.min(targetCeiling, opening + 0.4 * (targetCeiling - opening));
  } else {
    bid = targetCeiling;
  }
  // Hard cap: never above oracle maxBid (and never above buffer ceiling)
  bid = Math.min(bid, ceiling, maxBid);
  bid = Math.max(0, Math.round(bid * 100) / 100);

  if (bid <= 0 || (openingBid != null && openingBid > bid)) {
    // Opening already above suggested/ceiling → pass
    return {
      suggestedBid: null,
      action: "pass",
      maxBid,
      historyBufferUsd: g.buffer,
      bidFractionOfCeiling: g.bidFrac,
      ceilingAfterBuffer: ceiling,
      withinOracle: true,
      historyKey: key,
      historyN: g.n,
      medianWinningBid: g.medWin,
      pRedeem: g.pRedeem,
      notes: [
        ...g.notes,
        openingBid != null && openingBid > ceiling
          ? "Opening bid is already above history-adjusted ceiling — pass."
          : "No positive suggested bid under ceiling — pass.",
      ],
      headroomVsMaxBid: Math.round((maxBid - ceiling) * 100) / 100,
      roomAboveOpening: null,
      vsMedianSold: g.medWin != null ? Math.round((0 - g.medWin) * 100) / 100 : null,
    };
  }

  const withinOracle = bid <= maxBid + 1e-9;

  return {
    suggestedBid: bid,
    action: "bid",
    maxBid,
    historyBufferUsd: g.buffer,
    bidFractionOfCeiling: g.bidFrac,
    ceilingAfterBuffer: Math.round(ceiling * 100) / 100,
    withinOracle,
    historyKey: key,
    historyN: g.n,
    medianWinningBid: g.medWin,
    pRedeem: g.pRedeem,
    notes: g.notes,
    headroomVsMaxBid: Math.round((maxBid - bid) * 100) / 100,
    roomAboveOpening:
      openingBid != null ? Math.round((bid - openingBid) * 100) / 100 : null,
    vsMedianSold:
      g.medWin != null ? Math.round((bid - g.medWin) * 100) / 100 : null,
  };
}
