/*
 * No `server-only` guard, matching `lib/cape/inputs.ts` — the stage model is
 * pure and is worth being able to exercise from a test or a CLI.
 */
import { desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { capeProductions, counties, ingestRuns } from "@/lib/db/schema";
import type { CapeProductionState } from "./components";

/**
 * Where one sale sits, as a single answer.
 *
 * These partition: every sale in the horizon lands in exactly one stage, and
 * the counts sum to the total. That is the whole point — a board that reports
 * "19 with a parcel list" and "3 videos" without saying what the other 466 are
 * doing cannot answer "where are we with the entire list", which is the
 * question this page exists to answer.
 *
 * Ordered by progress, most advanced first. `stageFor` returns the first that
 * applies, so a sale with a video is reported as a video rather than also
 * being counted among those holding a parcel list.
 */
export type CapeStage = "video" | "blocked" | "script" | "list" | "crawled" | "nosource";

export const STAGE_ORDER: readonly CapeStage[] = [
  "video",
  "blocked",
  "script",
  "list",
  "crawled",
  "nosource",
] as const;

export const STAGE_LABEL: Record<CapeStage, string> = {
  video: "Video produced",
  blocked: "Blocked on review",
  script: "Script written",
  list: "Parcel list held",
  crawled: "Crawled, no list published",
  nosource: "No source located",
};

/**
 * What each stage is waiting on. Shown beside the count, because a number
 * without its next action is a number nobody acts on.
 */
export const STAGE_NEXT: Record<CapeStage, string> = {
  video: "Ready to publish",
  blocked: "A figure needs a human decision",
  script: "Narrate and encode",
  list: "Write the script",
  crawled: "County publishes no parsable list — needs a parser or a different source",
  nosource: "Needs the Prospector to find a list URL",
};

export interface StageInput {
  parcels: number;
  production: CapeProductionState | null | undefined;
  /** Whether this sale's county has ever been crawled at all. */
  countyCrawled: boolean;
}

export function stageFor({ parcels, production, countyCrawled }: StageInput): CapeStage {
  if (production?.hasVideo) return "video";
  if ((production?.unsupportedFigures?.length ?? 0) > 0) return "blocked";
  if (production?.hasScript) return "script";
  if (parcels > 0) return "list";
  return countyCrawled ? "crawled" : "nosource";
}

/** Counties that have ever produced an ingest run, for the crawled/no-source split. */
export async function crawledCountyFips(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ fips: ingestRuns.countyFips })
    .from(ingestRuns)
    .where(sql`${ingestRuns.countyFips} is not null`);
  return new Set(rows.map((r) => r.fips).filter((f): f is string => Boolean(f)));
}

export interface RunSummary {
  at: Date;
  detail: string;
}

/**
 * The most recent crawl, and what it returned.
 *
 * Reported as one line rather than a table: the question this answers is "is
 * the parcel data I am looking at current", and a date plus a lot count is the
 * whole of that answer.
 */
export async function latestCrawlRun(): Promise<RunSummary | null> {
  const [last] = await db
    .select({ startedAt: ingestRuns.startedAt })
    .from(ingestRuns)
    .orderBy(desc(ingestRuns.startedAt))
    .limit(1);
  if (!last?.startedAt) return null;

  // Everything from the same calendar day as the last run — one sweep.
  const [agg] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where ${ingestRuns.status} = 'ok')::int`,
      lots: sql<number>`coalesce(sum(${ingestRuns.lotsFound}), 0)::int`,
      counties: sql<number>`count(distinct ${ingestRuns.countyFips})::int`,
    })
    .from(ingestRuns)
    /* Serialised: the driver binds a Date as a parameter the ::timestamptz cast rejects. */
    .where(sql`${ingestRuns.startedAt} >= date_trunc('day', ${last.startedAt.toISOString()}::timestamptz)`);

  return {
    at: last.startedAt,
    detail:
      `${agg?.counties ?? 0} ${agg?.counties === 1 ? "county" : "counties"}, ` +
      `${agg?.ok ?? 0}/${agg?.runs ?? 0} ok, ${(agg?.lots ?? 0).toLocaleString()} parcels found`,
  };
}

/** The most recent CAPE production, and what it left behind. */
export async function latestProductionRun(): Promise<RunSummary | null> {
  const [last] = await db
    .select({ updatedAt: capeProductions.updatedAt })
    .from(capeProductions)
    .orderBy(desc(capeProductions.updatedAt))
    .limit(1);
  if (!last?.updatedAt) return null;

  const [agg] = await db
    .select({
      videos: sql<number>`count(*) filter (where ${capeProductions.videoPath} is not null)::int`,
      scripts: sql<number>`count(*) filter (where ${capeProductions.script} is not null)::int`,
      held: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${capeProductions.unsupportedFigures}, '[]'::jsonb)) > 0)::int`,
    })
    .from(capeProductions);

  /*
   * Counted across every package, which is deliberately a wider set than the
   * funnel below it: a package can be held for review and also sit outside the
   * eight-week confirmed list. Saying so here stops "3 held" beside "0
   * blocked" reading as a contradiction.
   */
  return {
    at: last.updatedAt,
    detail:
      `${agg?.videos ?? 0} video(s), ${agg?.scripts ?? 0} script(s) written` +
      ((agg?.held ?? 0) > 0 ? `, ${agg?.held} held for review` : "") +
      " — all packages",
  };
}

/** Counties with a confirmed sale and at least one parcel, for the header line. */
export async function countiesWithParcels(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${counties.fips})::int` })
    .from(counties)
    .innerJoin(ingestRuns, eq(ingestRuns.countyFips, counties.fips))
    .where(gt(ingestRuns.lotsFound, 0));
  return r?.n ?? 0;
}
