/*
 * No `server-only` guard, matching `lib/admin/queue.ts`, `lib/ingest/runner.ts`
 * and `lib/admin/plan-jobs.ts` rather than the console-facing modules.
 *
 * An importer is genuinely useful from a terminal — running a calendar in
 * headlessly, or checking what a file would do before anyone clicks anything,
 * is the main way to tell whether an import is sane — and `server-only` throws
 * under plain tsx. The Server Action that wraps this is where the cookie is
 * checked; the guard here was belt-and-braces, and it cost the ability to run
 * the thing from a script or a cron.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties } from "../db/schema";
import { CountyIndex, describeFailure, type CountyRef } from "./counties";
import type { ImportedAuction } from "./auction-rows";
import { planImport, type Ambiguity } from "./plan";
import { resolveSourceUrl } from "./source-url";

/**
 * Writing imported auctions to the database, exactly once each.
 *
 * "No duplicates" is three separate problems here, and only the first is the
 * obvious one:
 *
 *  1. **The same row twice in one file.** Cheap to catch — the exporter's own
 *     id is unique per sale — but it has to be caught before the insert, or the
 *     unique index turns it into a failed statement rather than a report.
 *
 *  2. **The same file uploaded twice.** The natural operator motion is to
 *     re-upload after fixing a few rows, and it must update rather than
 *     duplicate. The id is namespaced (`import:98131`) and the upsert keys on
 *     it, so a second upload of an unchanged file writes nothing new.
 *
 *  3. **A sale this system already crawled.** The hard one. The pipeline
 *     already holds 234 auctions, several in counties the import also covers,
 *     and those rows carry a *different* external id — the platform's, not the
 *     aggregator's — so nothing about the keys stops a second row for the same
 *     real-world sale appearing on the calendar beside the first.
 *
 * ## What happens on a collision with a crawled sale
 *
 * A county holding a sale on a date where we already have an auction is taken
 * to be that same sale, and the imported row is *not* inserted. What it
 * contributes is the announced parcel count, written onto the existing row.
 *
 * The direction of that merge is deliberate: a first-party crawl of the
 * county's own site outranks an aggregator's summary of it, so the import never
 * overwrites a crawled auction's date, type, platform or URL. It only fills a
 * column no adapter writes. Note that anything written into `raw` on a shared
 * row would not survive anyway — `upsertAuction` replaces `raw` wholesale on
 * every future crawl — which is a second reason to keep the contribution to the
 * one column that is genuinely ours.
 *
 * Where the pairing is not one-to-one — a county with two sales that day and
 * one imported row, or Mississippi publishing District 1 and District 2 against
 * a single crawled auction — nothing is merged and nothing is guessed. The
 * imported rows are inserted and the collision is reported for a person to look
 * at, because picking one of several candidates by position would be a coin
 * flip that leaves no trace.
 */

/** A row that could not be stored, and why. Rendered verbatim to the operator. */
export interface RejectedRow {
  line: number;
  label: string;
  problem: string;
}

/** A pairing this code refused to make on its own. See `./plan`. */
export type AmbiguousCollision = Ambiguity;

export interface ImportReport {
  /** Data rows in the file, excluding the header. */
  totalRows: number;
  inserted: number;
  /** Existing imported rows refreshed by this upload. */
  updated: number;
  /** Rows folded into an auction the pipeline already had. */
  mergedIntoCrawled: number;
  /** Rows sharing an id with an earlier row in the same file. */
  duplicateInFile: number;
  rejected: RejectedRow[];
  ambiguous: AmbiguousCollision[];
  /** FIPS codes this upload touched, for the enrichment pass. */
  countiesTouched: string[];
  dateRange: { from: string; to: string } | null;
}

/** Rows that survived parsing, ready to be resolved against the county table. */
export interface ResolvedAuction extends ImportedAuction {
  countyFips: string;
  line: number;
  /**
   * Settled here rather than in the parser, because the pages worth citing are
   * keyed by FIPS and the parser only has the county's label. `source_url` is
   * NOT NULL and `resolveSourceUrl` always returns something, so the parser's
   * `null` never reaches the write.
   */
  sourceUrl: string;
}

/**
 * Attach a FIPS code to every row, or reject it.
 *
 * Separated from the write so the caller can report resolution failures
 * without having opened a transaction.
 */
export async function resolveCounties(
  rows: { row: ImportedAuction; line: number }[],
): Promise<{ resolved: ResolvedAuction[]; rejected: RejectedRow[]; viaParent: number }> {
  const refs: CountyRef[] = await db
    .select({
      fips: counties.fips,
      name: counties.name,
      state: counties.state,
      stateName: counties.stateName,
    })
    .from(counties);
  const index = new CountyIndex(refs);
  /** For the citation lookup, which needs the county's own name and state. */
  const byFips = new Map(refs.map((r) => [r.fips, r]));

  const resolved: ResolvedAuction[] = [];
  const rejected: RejectedRow[] = [];
  /**
   * Rows filed under a parent county because their own jurisdiction has no
   * FIPS of its own — New Jersey's municipalities, Georgia's cities, New
   * England towns. Counted because it is the number that explains a county
   * total far larger than the number of counties actually holding sales, and
   * because a sudden change in it means the label format moved.
   */
  let viaParent = 0;

  for (const { row, line } of rows) {
    const match = index.resolve(row.stateLabel, row.countyLabel);
    if (!match.ok) {
      rejected.push({
        line,
        label: `${row.countyLabel}, ${row.stateLabel}`,
        problem: describeFailure(match.reason),
      });
      continue;
    }
    /*
     * A municipal sale keeps the municipality in its title.
     *
     * "Lumberton Township" files under Burlington County because that is the
     * only FIPS there is, and without the label it becomes indistinguishable
     * from a sale Burlington County is itself holding — on a calendar that
     * groups by county, several New Jersey townships would read as one county
     * running five identical auctions. The title is exactly the field the
     * schema keeps for separating same-county sales, and the county's own note
     * is appended after it rather than replaced.
     */
    const title =
      match.via === "parent" && match.municipality
        ? [match.municipality, row.title].filter(Boolean).join(" — ")
        : row.title;

    /*
     * The citation, now that the county is known: the waterfall picks the most
     * sale-specific county page it can reach for this FIPS — see
     * `source-url.ts`. Never the exporter's own per-row page.
     */
    const ref = byFips.get(match.fips);
    const sourceUrl = resolveSourceUrl({
      countyFips: match.fips,
      state: ref?.state ?? row.stateLabel,
      countyName: ref?.name ?? row.countyLabel,
      raw: row.raw,
    }).url;

    resolved.push({ ...row, title, countyFips: match.fips, line, sourceUrl });
    if (match.via === "parent") viaParent++;
  }

  return { resolved, rejected, viaParent };
}

/**
 * Write resolved rows, deduplicating against the file and against the database.
 *
 * Runs in one transaction. 644 rows is small enough that all-or-nothing is
 * affordable, and it means a failure halfway through does not leave a calendar
 * half-populated with no record of where it stopped.
 */
export async function applyImport(
  rows: ResolvedAuction[],
  totalRows: number,
): Promise<Omit<ImportReport, "rejected">> {
  const report: Omit<ImportReport, "rejected"> = {
    totalRows,
    inserted: 0,
    updated: 0,
    mergedIntoCrawled: 0,
    duplicateInFile: 0,
    ambiguous: [],
    countiesTouched: [],
    dateRange: null,
  };
  if (rows.length === 0) return report;

  /* The full row set, including any repeats — `planImport` reports those. The
   * date range and county list are computed over all of them because a repeat
   * still names a real county and date. */
  const unique = rows;

  const dates = unique.map((r) => r.saleDate).sort();
  report.dateRange = { from: dates[0], to: dates[dates.length - 1] };
  const fipsList = [...new Set(unique.map((r) => r.countyFips))];
  report.countiesTouched = fipsList;

  return await db.transaction(async (tx) => {
    /*
     * Everything already held for the counties and dates this file covers.
     * One query rather than one per row: the file spans 30 states and a round
     * trip each would dominate the import.
     */
    const existing = await tx
      .select({
        id: auctions.id,
        countyFips: auctions.countyFips,
        saleDate: auctions.saleDate,
        externalId: auctions.externalId,
      })
      .from(auctions)
      .where(
        and(
          inArray(auctions.countyFips, fipsList),
          gte(auctions.saleDate, report.dateRange!.from),
          lte(auctions.saleDate, report.dateRange!.to),
        ),
      );

    /* Every decision is made before anything is written, by a pure function
     * that is tested directly. This loop only carries them out. */
    const plan = planImport(unique, existing);
    report.ambiguous = plan.ambiguous;

    for (const d of plan.decisions) {
      switch (d.kind) {
        case "duplicate_in_file":
          report.duplicateInFile++;
          break;

        case "update":
          await tx.update(auctions).set(updatableFields(d.row)).where(eq(auctions.id, d.id));
          report.updated++;
          break;

        case "merge":
          /*
           * Only the announced count. A first-party crawl of the county's own
           * site outranks an aggregator's summary of it, so the date, type,
           * platform and URL on that row are left exactly as the crawler wrote
           * them. Skipped entirely when the file states no count, so a merge
           * can never blank one that is already there.
           */
          if (d.row.announcedParcelCount !== null) {
            await tx
              .update(auctions)
              .set({ announcedParcelCount: d.row.announcedParcelCount })
              .where(eq(auctions.id, d.id));
          }
          report.mergedIntoCrawled++;
          break;

        case "insert":
          await insert(tx, d.row);
          report.inserted++;
          break;
      }
    }

    return report;
  });
}

/**
 * Columns an upload may write on a row it owns.
 *
 * `lot_count` is absent on purpose and must stay absent: it counts parcel rows
 * this database holds, and an import holds none. See the column's comment in
 * the schema.
 */
function updatableFields(r: ResolvedAuction) {
  return {
    saleType: r.saleType,
    saleDate: r.saleDate,
    platform: r.platform,
    startTime: r.startTime,
    title: r.title,
    sourceUrl: r.sourceUrl,
    announcedParcelCount: r.announcedParcelCount,
    raw: r.raw as Record<string, unknown>,
    lastSeenAt: new Date(),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insert(tx: Tx, r: ResolvedAuction): Promise<void> {
  await tx
    .insert(auctions)
    .values({
      countyFips: r.countyFips,
      platform: r.platform,
      saleType: r.saleType,
      externalId: r.externalId,
      title: r.title,
      saleDate: r.saleDate,
      /*
       * The date is confirmed. This is a county-published sale date relayed by
       * an aggregator, not a date this system projected from a state's typical
       * schedule — which is the distinction the column exists to draw. The
       * conservative default of `false` is for adapters that take a date off a
       * calendar without the county having said so; that is not this.
       */
      saleDateConfirmed: true,
      /*
       * `unknown`, and deliberately not `sale_list`.
       *
       * This column records which published document the *parcels* were read
       * from, and no parcels have been read: the import carries a count, not a
       * list. Claiming `sale_list` here would put these rows through
       * `isConfirmedInventory()` as though a sale list had been parsed, which is
       * the exact confusion that filter exists to prevent. They reach the
       * calendar instead by their announced count, labelled as announced.
       */
      listingKind: "unknown",
      status: "scheduled",
      sourceUrl: r.sourceUrl,
      announcedParcelCount: r.announcedParcelCount,
      raw: r.raw as Record<string, unknown>,
    })
    /*
     * A safety net rather than the main path: step 2 already found anything
     * this import owns, keyed without platform. This catches the narrow race
     * where two uploads run at once, and keeps operator corrections winning
     * over the file for the same reasons `upsertAuction` documents.
     */
    .onConflictDoUpdate({
      target: [auctions.countyFips, auctions.platform, auctions.externalId],
      set: {
        saleType: sql`coalesce((${auctions.operatorOverrides}->>'saleType')::sale_type, excluded.sale_type)`,
        saleDate: sql`coalesce((${auctions.operatorOverrides}->>'saleDate')::date, excluded.sale_date)`,
        startTime: sql`coalesce(${auctions.operatorOverrides}->>'startTime', excluded.start_time)`,
        title: sql`coalesce(${auctions.operatorOverrides}->>'title', excluded.title)`,
        sourceUrl: sql`excluded.source_url`,
        announcedParcelCount: sql`excluded.announced_parcel_count`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`now()`,
      },
    });
}
