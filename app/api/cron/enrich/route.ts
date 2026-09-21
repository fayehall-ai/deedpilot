/**
 * The enrichment worker: places and values the parcels of upcoming sales.
 *
 * Its own schedule rather than a stage of the dispatcher, because the two
 * compete for the same clock: every second spent valuing parcels would be a
 * county not crawled. Here it has the function to itself, and the dispatcher
 * keeps its budget for fetching lists. The rules — free before paid, soonest
 * sale first, a weekly dollar ceiling Ed sets on the console — are in
 * `lib/property/enrich-pass.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { getPipelineConfig } from "@/lib/admin/pipeline-settings";
import { runEnrichmentPass } from "@/lib/property/enrich-pass";

export const maxDuration = 300;

/**
 * Stop taking new parcels with two minutes to spare. A single lookup can run
 * past a minute when a provider is slow, and the first deploy of this route
 * was killed at 300 seconds by exactly that with a one-minute reserve.
 */
const BUDGET_MS = 180_000;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = await getPipelineConfig();
  if (!config.enrichEnabled) return NextResponse.json({ ok: true, skipped: "enrichment is switched off" });

  const started = Date.now();
  const result = await runEnrichmentPass({
    deadline: started + BUDGET_MS,
    budgetDollars: config.enrichWeeklyBudgetDollars,
  });
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - started, ...result });
}
