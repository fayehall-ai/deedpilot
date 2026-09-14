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
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions } from "@/lib/db/schema";
import { buildCoverageScoreboard } from "@/lib/coverage/scoreboard";
import { runEnrichment } from "@/lib/ingest/runner";
import { getAdapter } from "@/lib/ingest/adapters";

export const maxDuration = 60;

/**
 * Fail closed. There is no default secret.
 *
 * This read `process.env.VERCEL_CRON_SECRET || "dev-secret"`, and
 * `VERCEL_CRON_SECRET` is not set in production — so the live value was the
 * string "dev-secret", and `?secret=dev-secret` authorised anyone who typed it.
 * `api/cron` is deliberately outside the site gate because Vercel's scheduler
 * cannot present a cookie, which left this endpoint reachable by anyone on the
 * internet.
 *
 * What it does once authorised is the part that matters: it deletes every
 * future auction with `lot_count = 0`. That is not a no-op on this database —
 * `announced_parcel_count` exists precisely because an imported sale calendar
 * carries a headline count with no parcel list behind it, so a county
 * announcing 16,062 parcels sits at `lot_count = 0` until something crawls it.
 *
 * `lib/admin/token.ts` states the rule this file broke: an unset secret must
 * deny every candidate, because the tempting default turns a missing
 * environment variable into an open door.
 */
function configuredSecrets(): string[] {
  return [process.env.CRON_SECRET, process.env.VERCEL_CRON_SECRET]
    .map((v) => (v ?? "").trim())
    .filter((v) => v.length > 0);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const secret = request.nextUrl.searchParams.get("secret") ?? "";
  const secrets = configuredSecrets();

  /*
   * `x-vercel-cron` is no longer accepted on its own.
   *
   * It was the only credential the schedule ever presented, and the logs say
   * every one of those invocations was refused anyway — six in seven days, all
   * 401. Trusting a header that demonstrably does not arrive bought nothing
   * except a second way in for anyone who sets it by hand.
   */
  const ok =
    secrets.length > 0 && (secrets.includes(bearer) || secrets.includes(secret));

  if (!ok) {
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

    /*
     * Purge skeletons — but an announced sale is not a skeleton.
     *
     * `lot_count = 0` means "no parcel rows in this database", which is the
     * normal and honest state of a sale imported from a calendar: the county
     * has said it is offering 16,062 parcels and nothing has crawled the list
     * yet. `announced_parcel_count` was added to record exactly that, and its
     * own comment calls the gap between the two figures "the enrichment
     * worklist". Deleting those rows destroys the worklist and the sale with
     * it, and the county goes on holding the auction either way.
     *
     * A skeleton is a row with neither: no parcels and nobody claiming any.
     */
    const today = todayIso();
    const isSkeleton = and(
      gte(auctions.saleDate, today),
      eq(auctions.lotCount, 0),
      sql`coalesce(${auctions.announcedParcelCount}, 0) = 0`,
    );
    const skel = await db.select({ id: auctions.id }).from(auctions).where(isSkeleton);
    if (skel.length > 0) {
      await db.delete(auctions).where(isSkeleton);
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
