/**
 * Trusted tool / oracle: compute_maxbid
 *
 * POST /api/tools/maxbid
 * Body: DealInputs JSON
 *
 * Output is deterministic arithmetic. The LLM never invents a walk-away price.
 */

import { NextRequest, NextResponse } from "next/server";
import { computeMaxBid, type DealInputs } from "@/lib/deal/maxbid";
import type { SaleType } from "@/lib/atlas/types";

export const runtime = "nodejs";

const SALE_TYPES: SaleType[] = ["Tax Lien", "Tax Deed", "Redeemable Deed", "Hybrid"];

function parseBody(raw: unknown): DealInputs | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "JSON body required" };
  const b = raw as Record<string, unknown>;
  if (typeof b.state !== "string" || !b.state) return { error: "state is required" };
  if (typeof b.saleType !== "string" || !SALE_TYPES.includes(b.saleType as SaleType)) {
    return { error: `saleType must be one of ${SALE_TYPES.join(", ")}` };
  }
  return {
    state: b.state,
    saleType: b.saleType as SaleType,
    fips: typeof b.fips === "string" ? b.fips : undefined,
    openingBid: typeof b.openingBid === "number" ? b.openingBid : undefined,
    assessedValue: typeof b.assessedValue === "number" ? b.assessedValue : undefined,
    arvOverride: typeof b.arvOverride === "number" ? b.arvOverride : undefined,
    rehabCost: typeof b.rehabCost === "number" ? b.rehabCost : undefined,
    targetMargin: typeof b.targetMargin === "number" ? b.targetMargin : undefined,
    holdingMonths: typeof b.holdingMonths === "number" ? b.holdingMonths : undefined,
    survivingLiens: typeof b.survivingLiens === "number" ? b.survivingLiens : undefined,
    sellingCostRate: typeof b.sellingCostRate === "number" ? b.sellingCostRate : undefined,
  };
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", tool: "compute_maxbid" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error, tool: "compute_maxbid" }, { status: 400 });
  }

  const result = computeMaxBid(parsed);

  return NextResponse.json({
    tool: "compute_maxbid",
    trusted: true,
    oracle: true,
    note: "Deterministic. Never override maxBid with model-generated numbers.",
    inputs: parsed,
    result,
  });
}
