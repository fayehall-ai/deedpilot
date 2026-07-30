/**
 * Historical comps from recorded auction outcomes.
 *
 * GET /api/tools/comparables?state=MI&saleType=Tax%20Deed&assessedValue=80000&limit=10
 */

import { NextRequest, NextResponse } from "next/server";
import { getComparables } from "@/lib/history/comparables";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state")?.trim().toUpperCase();
  const saleType = req.nextUrl.searchParams.get("saleType")?.trim() || "Tax Deed";
  const assessedRaw = req.nextUrl.searchParams.get("assessedValue");
  const openingRaw = req.nextUrl.searchParams.get("openingBid");
  const fips = req.nextUrl.searchParams.get("fips")?.trim() || undefined;
  const limitRaw = req.nextUrl.searchParams.get("limit");

  if (!state || state.length !== 2) {
    return NextResponse.json(
      { error: "state=XX (USPS) is required", tool: "comparables" },
      { status: 400 },
    );
  }

  const assessedValue = assessedRaw ? Number(assessedRaw) : undefined;
  const openingBid = openingRaw ? Number(openingRaw) : undefined;
  const limit = limitRaw ? Math.min(50, Math.max(1, Number(limitRaw))) : 10;

  const result = getComparables({
    state,
    saleType,
    assessedValue: Number.isFinite(assessedValue) ? assessedValue : undefined,
    openingBid: Number.isFinite(openingBid) ? openingBid : undefined,
    fips,
    limit: Number.isFinite(limit) ? limit : 10,
  });

  return NextResponse.json({
    tool: "comparables",
    trusted: true,
    source: "recorded historical_outcomes via history_index.json",
    ...result,
  });
}
