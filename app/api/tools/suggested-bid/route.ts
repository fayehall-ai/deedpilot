/**
 * History-guided suggested bid (always ≤ oracle maxBid).
 *
 * GET /api/tools/suggested-bid?state=MI&saleType=Tax%20Deed&assessedValue=80000&openingBid=5000
 * Optional: rehabCost, targetMargin, arvOverride, fips
 */

import { NextRequest, NextResponse } from "next/server";
import { computeMaxBid } from "@/lib/deal/maxbid";
import { computeSuggestedBidWithIndex } from "@/lib/history/suggested-bid.server";
import type { SaleType } from "@/lib/atlas/types";

export const runtime = "nodejs";

const SALE_TYPES: SaleType[] = [
  "Tax Lien",
  "Tax Deed",
  "Redeemable Deed",
  "Hybrid",
];

function numParam(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const state = sp.get("state")?.trim().toUpperCase();
  const saleTypeRaw = sp.get("saleType")?.trim() || "Tax Deed";
  const fips = sp.get("fips")?.trim() || undefined;

  if (!state || state.length !== 2) {
    return NextResponse.json(
      { error: "state=XX (USPS) is required", tool: "suggested_bid" },
      { status: 400 },
    );
  }
  if (!SALE_TYPES.includes(saleTypeRaw as SaleType)) {
    return NextResponse.json(
      {
        error: `saleType must be one of ${SALE_TYPES.join(", ")}`,
        tool: "suggested_bid",
      },
      { status: 400 },
    );
  }

  const saleType = saleTypeRaw as SaleType;
  const openingBid = numParam(sp.get("openingBid"));
  const assessedValue = numParam(sp.get("assessedValue"));
  const arvOverride = numParam(sp.get("arvOverride"));
  const rehabCost = numParam(sp.get("rehabCost"));
  const survivingLiens = numParam(sp.get("survivingLiens"));
  const targetMargin = numParam(sp.get("targetMargin"));

  const deal = computeMaxBid({
    state,
    saleType,
    openingBid,
    assessedValue,
    arvOverride,
    rehabCost,
    survivingLiens,
    targetMargin,
  });

  const suggestion = computeSuggestedBidWithIndex({
    state,
    saleType,
    openingBid,
    assessedValue,
    fips,
    deal: {
      maxBid: deal.maxBid,
      recommendation: deal.recommendation,
      bidRoom: deal.bidRoom,
      projectedProfit: deal.projectedProfit,
    },
  });

  // Final safety: never return a suggestion above oracle
  if (
    suggestion.suggestedBid != null &&
    deal.maxBid != null &&
    suggestion.suggestedBid > deal.maxBid
  ) {
    suggestion.suggestedBid = deal.maxBid;
    suggestion.withinOracle = true;
    suggestion.headroomVsMaxBid = 0;
    suggestion.notes = [
      ...suggestion.notes,
      "Clamped to oracle maxBid (safety).",
    ];
  }

  return NextResponse.json({
    tool: "suggested_bid",
    trusted: true,
    oracle: true,
    note: "Suggested bid is history-guided and always ≤ compute_maxbid. Never invent maxBid.",
    maxBid: deal.maxBid,
    oracleRecommendation: deal.recommendation,
    suggestion,
  });
}
