/*
 * No `server-only` guard — the producer CLI runs under plain tsx.
 *
 * This deliberately queries rather than calling `getCapeAuctions`, which is
 * marked `"use cache"` with `cacheLife("minutes")`. Those directives are right
 * for a page render and throw outside a Next request context, so a CLI that
 * imported them could not run at all. The selection below is the same one.
 */
import { and, asc, eq, gte, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions, capeProductions, capeReviews, counties, lots } from "@/lib/db/schema";
import { hasParcels, isConfirmedInventory } from "@/lib/db/inventory";
import { sql as rawSql } from "drizzle-orm";
import { getCounty, resolveCountyRule } from "@/lib/atlas";
import { statuteFor } from "@/lib/deal/statute";
import { pickLink, type CountyDirectory, type OfficeKind } from "@/lib/directory/onlinesearches";
import directory from "@/data/county-directory.json";
import type { PackageInput, CapeProductionState } from "./components";

/**
 * Assemble `PackageInput` for every upcoming sale.
 *
 * One place, so the board, the ops console and the producer all judge the same
 * facts. When they drifted — and they would, being three call sites building
 * the same object — the checklist on screen would disagree with the checklist
 * the narration was written from, and nobody would be able to tell which was
 * right.
 */
/**
 * The smallest sale that earns a briefing video.
 *
 * Counted on the best available figure — parcels crawled, or the count the
 * county announced. See the note at the call site.
 */
export const MIN_PARCELS = 20;

/**
 * How far out a sale must be before it is worth briefing.
 *
 * A briefing that arrives after the hammer is not a briefing. Component Eight
 * already says so — `productionDeadline` puts a package due the Monday or
 * Tuesday night before its sale, five to seven days ahead — and until now that
 * deadline was reported rather than enforced: a sale three days out was still
 * selected, produced, and marked overdue on arrival.
 *
 * Seven days is the outer edge of that existing lead time, so this floor and
 * the deadline model agree rather than each carrying their own number. It also
 * buys the crawler a week: 90% of packages have no parcel list yet, and a sale
 * selected a week out can still gain one before the script is written.
 */
export const MIN_LEAD_DAYS = 7;

export async function capePackageInputs(opts: { auctionId?: string; today?: string } = {}): Promise<
  (PackageInput & {
    countyFips: string;
    /**
     * Parcels the county announced, where it stated a count. Carried so the
     * render cron can rank sales by `greatest(lotCount, announced)` — the same
     * best figure `MIN_PARCELS` is measured on. Deliberately not part of
     * `PackageInput`, so it cannot reach `capeInputsHash` and restale scripts.
     */
    announcedParcelCount: number | null;
  })[]
> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  /*
   * The same definition of inventory the site uses, not a second one.
   *
   * This read `lot_count >= 0`, which admits every row ever written — a lot
   * count is never negative. The producer therefore offered 848 upcoming
   * packages where the site counted 488, and the 360-package difference was
   * calendar shells and unconfirmed dates: sales with no parcels crawled, none
   * announced, or a date this system projected rather than read. Ordered by
   * production deadline, those sorted to the *front* of the queue, so the work
   * a batch run would have picked up first was the work worth doing least.
   *
   * `hasParcels` keeps announced sales, which matters: a county that has
   * stated 1,697 parcels without publishing the list is a real package with a
   * real deadline, and Component Two exists precisely to say the list has not
   * been read yet.
   */
  /*
   * A briefing needs a sale worth briefing on.
   *
   * 43 upcoming sales offer a single parcel and 96 offer four or fewer. A
   * five-minute video explaining a state's redemption statute, the county's
   * submarkets and what a deed conveys is the same length and the same cost
   * whether the auction has one parcel or seventeen hundred, and at one parcel
   * nobody watches it — including the bidder, who has already decided.
   *
   * Measured against `greatest(lot_count, announced_parcel_count)`, which is the
   * best figure available rather than the one we happen to hold. 389 of 454
   * packages are sales whose list nothing has crawled yet, so a threshold on
   * `lot_count` alone would admit 22 of them and silently retire the rest —
   * judging the county's auction by our own crawl coverage rather than by its
   * size. The county's announced count is a claim about the sale; ours is a
   * claim about this database, and the sale is what is being briefed.
   *
   * Deliberately not in `lib/db/inventory.ts`: that file defines what the *site*
   * counts as inventory, and a one-parcel sale is perfectly real and belongs on
   * the map. This is only about whether it earns a video.
   *
   * `--auction <id>` bypasses it, so a small sale can still be produced on
   * purpose.
   */
  /*
   * The earliest sale worth producing. See `MIN_LEAD_DAYS`.
   *
   * Computed here rather than in SQL so the same string arithmetic drives the
   * query and anything that reports on it.
   */
  const earliest = new Date(Date.parse(`${today}T12:00:00Z`) + MIN_LEAD_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const where = opts.auctionId
    ? eq(auctions.id, opts.auctionId)
    : and(
        gte(auctions.saleDate, earliest),
        hasParcels(),
        isConfirmedInventory(),
        rawSql`greatest(${auctions.lotCount}, coalesce(${auctions.announcedParcelCount}, 0)) >= ${MIN_PARCELS}`,
      );

  const rows = await db
    .select({
      id: auctions.id,
      countyFips: auctions.countyFips,
      countyName: counties.name,
      state: counties.state,
      saleDate: auctions.saleDate,
      saleDateConfirmed: auctions.saleDateConfirmed,
      saleType: auctions.saleType,
      sourceUrl: auctions.sourceUrl,
      platform: auctions.platform,
      listingKind: auctions.listingKind,
      lotCount: auctions.lotCount,
      announcedParcelCount: auctions.announcedParcelCount,
      startTime: auctions.startTime,
      logistics: auctions.logistics,
      registrationDeadline: auctions.registrationDeadline,
      depositDeadline: auctions.depositDeadline,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(where)
    .orderBy(asc(auctions.saleDate), asc(counties.state), asc(counties.name))
    .limit(1000);

  if (rows.length === 0) return [];

  /*
   * One sale, one package — even when the database holds two rows for it.
   *
   * `auctions` is unique on (county, platform, external_id), so a sale that
   * arrives twice under different ids is two rows. It happens whenever a
   * platform crawl meets a calendar import of the same auction: Marion County
   * Indiana on 2026-10-13 exists as `govease|1282` with 50 crawled parcels and
   * as `import:99877` with 1,841 announced and none crawled. 44 county-and-date
   * pairs are in that state.
   *
   * Left alone it produces two briefings for one auction — one describing the
   * parcels, one saying the list has not been published — and a reviewer cannot
   * tell which to believe. The crawled row wins, because parcels this database
   * holds outrank a count somebody announced.
   *
   * This is a presentation fix, not the cure. The rows are still two, and
   * reconciling them belongs in the ingest path where the collision is made.
   * Doing it here at least stops the duplicate reaching a script, a video and a
   * reviewer while that is outstanding.
   */
  const bySale = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.countyFips}|${r.saleDate}`;
    const held = bySale.get(key);
    if (!held) { bySale.set(key, r); continue; }
    /* Prefer crawled parcels, then a published sale list, then whichever came first. */
    const better =
      (r.lotCount > 0 ? 2 : 0) + (r.listingKind === "sale_list" ? 1 : 0) >
      (held.lotCount > 0 ? 2 : 0) + (held.listingKind === "sale_list" ? 1 : 0);
    if (better) bySale.set(key, r);
  }
  const deduped = [...bySale.values()];
  if (deduped.length !== rows.length) {
    console.warn(
      `[cape] ${rows.length - deduped.length} duplicate auction row(s) collapsed — ` +
        `same county and sale date under different external ids`,
    );
  }
  rows.length = 0;
  rows.push(...deduped);

  const coverage = await parcelCoverage();
  const productions = await productionStates();
  const corrections = await reviewNotes(rows.map((r) => r.id));

  const dir = directory as Record<string, CountyDirectory>;
  const officesFor = (fips: string): Partial<Record<string, string>> => {
    const entry = dir[fips];
    if (!entry) return {};
    const out: Partial<Record<string, string>> = {};
    for (const kind of ["assessor", "collector", "recorder", "gis", "tax_portal"] as OfficeKind[]) {
      const hit = pickLink(entry, kind);
      if (hit) out[kind] = hit.url;
    }
    return out;
  };

  const empty = {
    total: 0, withParcelNumber: 0, withAssessed: 0,
    withAddress: 0, withZoning: 0, withGeo: 0,
  };

  return rows.map((r) => ({
    auctionId: r.id,
    countyFips: r.countyFips,
    countyName: r.countyName,
    state: r.state,
    saleDate: r.saleDate,
    saleDateConfirmed: r.saleDateConfirmed,
    saleType: r.saleType,
    sourceUrl: r.sourceUrl,
    platform: r.platform,
    /*
     * Read, not hardcoded null.
     *
     * This said `startTime: null` from the first draft, so Component Two's
     * "Auction time" reported "No start time on the sale notice" for every
     * package in the system — including the sales whose `auctions.start_time`
     * column held a time the county had published. A checklist that cannot
     * report a fact the row beside it already holds is not measuring the sale,
     * it is measuring itself.
     */
    startTime: r.startTime,
    logistics: r.logistics ?? null,
    registrationDeadline: r.registrationDeadline,
    depositDeadline: r.depositDeadline,
    lotCount: r.lotCount,
    announcedParcelCount: r.announcedParcelCount ?? null,
    listingKind: r.listingKind,
    rule: resolveCountyRule(r.countyFips),
    statute: statuteFor(r.state) ?? null,
    offices: officesFor(r.countyFips),
    population: getCounty(r.countyFips)?.population ?? null,
    parcels: coverage[r.id] ?? empty,
    today,
    production: productions[r.id] ?? null,
    ...(corrections.get(r.id)?.length ? { reviewNotes: corrections.get(r.id) } : {}),
  }));
}

/**
 * Ed's "needs a change" notes per sale, oldest first. See `PackageInput.reviewNotes`.
 *
 * Every note, not only the latest: a correction stays true after the rewrite
 * that applied it — the venue is still the annex next week — and dropping the
 * first when a second arrives would let the next rewrite undo it.
 */
async function reviewNotes(auctionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (auctionIds.length === 0) return out;
  const rows = await db
    .select({ auctionId: capeReviews.auctionId, note: capeReviews.note })
    .from(capeReviews)
    .where(and(inArray(capeReviews.auctionId, auctionIds), eq(capeReviews.verdict, "needs-change")))
    .orderBy(asc(capeReviews.createdAt));
  for (const r of rows) {
    const note = r.note?.trim();
    if (note) out.set(r.auctionId, [...(out.get(r.auctionId) ?? []), note]);
  }
  return out;
}

async function parcelCoverage() {
  const rows = await db
    .select({
      auctionId: lots.auctionId,
      total: sql<number>`count(*)::int`,
      withParcelNumber: sql<number>`count(${lots.parcelNumber})::int`,
      withAssessed: sql<number>`count(${lots.assessedValue})::int`,
      withAddress: sql<number>`count(${lots.addressLine})::int`,
      withZoning: sql<number>`count(distinct ${lots.id}) filter (where exists (
        select 1 from lot_valuations lv where lv.lot_id = ${lots.id} and lv.zoning is not null))::int`,
      withGeo: sql<number>`count(${lots.latitude})::int`,
    })
    .from(lots)
    .groupBy(lots.auctionId);

  const out: Record<string, (typeof rows)[number]> = {};
  for (const r of rows) out[r.auctionId] = r;
  return out;
}

/** Hosted briefing URLs by auction id, for surfaces that link to them. */
export async function publishedVideoUrls(): Promise<Record<string, string>> {
  const rows = await db
    .select({ auctionId: capeProductions.auctionId, videoUrl: capeProductions.videoUrl })
    .from(capeProductions);
  const out: Record<string, string> = {};
  for (const r of rows) if (r.videoUrl) out[r.auctionId] = r.videoUrl;
  return out;
}

/** Every production row, in the shape the checklist reads. */
export async function productionStates(): Promise<Record<string, CapeProductionState>> {
  const rows = await db.select().from(capeProductions);
  const out: Record<string, CapeProductionState> = {};
  for (const r of rows) {
    out[r.auctionId] = {
      inputsHash: r.inputsHash,
      hasScript: Boolean(r.script),
      slidePlanCount: r.slidePlanCount,
      hasAudio: Boolean(r.audioPath),
      hasVideo: Boolean(r.videoPath),
      unsupportedFigures: r.unsupportedFigures ?? [],
    };
  }
  return out;
}
