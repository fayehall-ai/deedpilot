/**
 * POST /api/lots/:id/enrich
 *
 * On-demand property enrichment. **Admin only.**
 *
 * ## Why this is gated
 *
 * It was not, and it spends money. `enrichLotById` walks the provider chain,
 * which ends in a billed RealEstateAPI search, and `force`
 * skips the "this lot already has a value" guard that was the only thing
 * limiting how often it could fire. A public button on every parcel page,
 * calling an unauthenticated endpoint that bills per invocation, is a way to
 * turn someone else's afternoon into our invoice. 1,188 wasted RentCast calls
 * have already been paid for on this project by accident; paying for them on
 * purpose would be worse.
 *
 * The bulk scripts are how enrichment actually happens — see
 * `lib/property/pipeline.ts` for the order and what each stage costs.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin/auth";
import {
  configuredEnrichmentProviders,
  enrichLotById,
} from "@/lib/property/enrich";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    // 404 rather than 401: an unauthenticated caller learns nothing about
    // whether this route, or this lot, exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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

/** Diagnostic. Gated too — it reports which paid providers hold a key. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  return NextResponse.json({
    lotId: id,
    providers: configuredEnrichmentProviders(),
    note: "POST to run enrichment. Set REALESTATEAPI_API_KEY.",
  });
}
