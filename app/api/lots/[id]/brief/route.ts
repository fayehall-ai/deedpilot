import { spendDailyAllowance } from "@/lib/site-gate/daily-limit";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealAnalyses } from "@/lib/db/schema";
import { getLot, getLotValuations } from "@/lib/queries";
import { resolveCountyRule } from "@/lib/atlas";
import { mergeValuations } from "@/lib/property/merge";
import { computeMaxBid } from "@/lib/deal/maxbid";
import {
  BriefUnavailableError,
  briefInputsHash,
  generateBrief,
  type BriefInput,
} from "@/lib/ai/brief";
import type { SaleType } from "@/lib/atlas/types";

/** Briefs take ~30-60s at high effort; well under the platform ceiling. */
export const maxDuration = 120;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const row = await getLot(id);
  if (!row) {
    return NextResponse.json({ error: "Lot not found" }, { status: 404 });
  }

  const rule = resolveCountyRule(row.county.fips);
  if (!rule) {
    return NextResponse.json({ error: "County rules unavailable" }, { status: 500 });
  }

  // Caller-supplied assumptions (rehab, margin, liens) change the maths, so
  // they change the cache key too.
  const body = (await request.json().catch(() => ({}))) as {
    rehabCost?: number;
    targetMargin?: number;
    survivingLiens?: number;
    arvOverride?: number;
  };

  /*
   * The same inputs the page prices with.
   *
   * This call omitted `marketValue` and `fips`, so the brief was written about
   * a different parcel from the one in the sidebar next to it: without the
   * market estimate it fell through to an assumed floor, and without the FIPS
   * it used the statewide assessment ratio where a county overrides it — Cook
   * County assesses residential at 10% against Illinois' 33 1/3, which
   * overstates the property threefold. An AI narrative arguing for a ceiling
   * the page does not show is worse than no narrative.
   */
  const merged = mergeValuations(await getLotValuations(row.lot.id));
  const deal = computeMaxBid({
    state: row.county.state,
    saleType: row.auction.saleType as SaleType,
    fips: row.county.fips,
    openingBid: row.lot.openingBid === null ? undefined : Number(row.lot.openingBid),
    assessedValue: row.lot.assessedValue === null ? undefined : Number(row.lot.assessedValue),
    marketValue:
      merged?.marketValue === null || merged?.marketValue === undefined
        ? undefined
        : Number(merged.marketValue),
    rehabCost: body.rehabCost,
    targetMargin: body.targetMargin,
    survivingLiens: body.survivingLiens,
    arvOverride: body.arvOverride,
  });

  const input: BriefInput = { lot: row.lot, auction: row.auction, rule, deal };
  const inputsHash = briefInputsHash(input);

  const [cached] = await db
    .select()
    .from(dealAnalyses)
    .where(and(eq(dealAnalyses.lotId, id), eq(dealAnalyses.inputsHash, inputsHash)))
    .limit(1);

  if (cached?.brief) {
    return NextResponse.json({
      cached: true,
      brief: JSON.parse(cached.brief),
      model: cached.model,
      deal,
    });
  }

  /* Writing a brief is a billed model call; on the public domain it counts against the daily limit. */
  const allowed = await spendDailyAllowance("brief", request.headers);
  if (!allowed.ok) return NextResponse.json({ error: allowed.message, deal }, { status: 429 });

  try {
    const { brief, model, usedFallback } = await generateBrief(input);

    await db
      .insert(dealAnalyses)
      .values({
        lotId: id,
        inputsHash,
        model,
        maxBid: deal.maxBid === null ? null : String(deal.maxBid),
        arvEstimate: deal.arv.value === null ? null : String(deal.arv.value),
        totalCosts: String(deal.totalCosts),
        riskFlags: brief.riskFlags,
        brief: JSON.stringify(brief),
        inputs: { ...body, recommendation: deal.recommendation, usedFallback },
      })
      // A concurrent request for the same inputs may have won the race; its
      // brief is equally valid, so keep whichever landed first.
      .onConflictDoNothing({ target: [dealAnalyses.lotId, dealAnalyses.inputsHash] });

    return NextResponse.json({ cached: false, brief, model, usedFallback, deal });
  } catch (e) {
    if (e instanceof BriefUnavailableError) {
      // The deterministic analysis is still valid and still useful — return it
      // rather than failing the whole request because the narrative is missing.
      return NextResponse.json({ error: e.message, deal }, { status: 503 });
    }
    console.error("[brief] generation failed", e);
    return NextResponse.json({ error: "Brief generation failed" }, { status: 500 });
  }
}
