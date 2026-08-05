/**
 * POST /api/lots/:id/enrich
 * On-demand property enrichment (ATTOM / RentCast when configured).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  configuredEnrichmentProviders,
  enrichLotById,
} from "@/lib/property/enrich";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let force = false;
  try {
    const body = (await req.json()) as { force?: boolean };
    force = Boolean(body?.force);
  } catch {
    /* empty body ok */
  }

  try {
    const result = await enrichLotById(id, { force });
    return NextResponse.json({
      ...result,
      providers: configuredEnrichmentProviders(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : String(e),
        providers: configuredEnrichmentProviders(),
      },
      { status: 502 },
    );
  }
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return NextResponse.json({
    lotId: id,
    providers: configuredEnrichmentProviders(),
    note: "POST to run enrichment. Set ATTOM_API_KEY and/or RENTCAST_API_KEY.",
  });
}
