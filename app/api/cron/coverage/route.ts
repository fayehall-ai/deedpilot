/**
 * Nightly coverage meta-loop (plan + cheap safe actions).
 *
 * On Vercel we cannot run a 500-lot MI enrich in one invocation. This cron:
 *   1. Builds and writes data/coverage-scoreboard.json (ephemeral on serverless —
 *      so we also return the board in the response for observability).
 *   2. Purges skeleton auctions (lot_count=0).
 *   3. Optionally enriches a small MI batch when ?enrich=1&limit=N.
 *
 * Full enrich / prospect / cartographer stay on a long-running host:
 *   npm run flywheel:coverage -- --cycle --limit 500
 */

import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions } from "@/lib/db/schema";
import { buildCoverageScoreboard } from "@/lib/coverage/scoreboard";
import { runEnrichment } from "@/lib/ingest/runner";
import { getAdapter } from "@/lib/ingest/adapters";

export const maxDuration = 60;

const CRON_SECRET = process.env.VERCEL_CRON_SECRET || "dev-secret";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronHeader = request.headers.get("x-vercel-cron");
  const secret = request.nextUrl.searchParams.get("secret");

  if (
    authHeader !== `Bearer ${CRON_SECRET}` &&
    secret !== CRON_SECRET &&
    !cronHeader
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actions: string[] = [];
  const enrich = request.nextUrl.searchParams.get("enrich") === "1";
  const limit = Math.min(
    40,
    Number(request.nextUrl.searchParams.get("limit") || "25") || 25,
  );

  try {
    const before = await buildCoverageScoreboard();

    // Purge skeletons
    const today = todayIso();
    const skel = await db
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(gte(auctions.saleDate, today), eq(auctions.lotCount, 0)));
    if (skel.length > 0) {
      await db
        .delete(auctions)
        .where(and(gte(auctions.saleDate, today), eq(auctions.lotCount, 0)));
      actions.push(`purged ${skel.length} skeleton auction(s)`);
    }

    if (enrich) {
      const adapter = getAdapter("mi-taxsaleinfo");
      if (adapter?.enrichLot) {
        const s = await runEnrichment(adapter, { limit });
        actions.push(
          `MI enrich attempted=${s.attempted} enriched=${s.enriched} gone=${s.gone} failed=${s.failed}`,
        );
      }
    }

    const board = await buildCoverageScoreboard();

    // Best-effort write (may be read-only on some deploys)
    try {
      const dir = join(process.cwd(), "data");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "coverage-scoreboard.json"),
        JSON.stringify(board, null, 2),
      );
      actions.push("wrote data/coverage-scoreboard.json");
    } catch {
      actions.push("scoreboard write skipped (filesystem)");
    }

    return NextResponse.json({
      ok: true,
      goldBefore: before.gold.score,
      goldAfter: board.gold.score,
      live: {
        lots: board.live.totalLotsUpcoming,
        assessed: board.live.lotsWithAssessed,
        autoPriceable: board.live.lotsAutoPriceable,
        skeletons: board.live.skeletonAuctions,
        states: board.live.statesWithLots,
      },
      workTop: board.workPlan.slice(0, 5).map((w) => w.title),
      actions,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
