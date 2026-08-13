/**
 * Remove two speculative New Mexico auctions that duplicated a real notice.
 *
 *   npx tsx scripts/purge-nm-placeholder-auctions.ts           # dry run
 *   npx tsx scripts/purge-nm-placeholder-auctions.ts --apply
 *
 * ## What these rows are
 *
 * 93 parcels were filed under two counties — 186 rows — with Los Ranchos de
 * Albuquerque addresses appearing under both Bernalillo (35001, correct) and
 * Catron (35003, the other end of the state). A parcel in two counties is not a
 * near-miss: it is inventory in a place it does not exist.
 *
 * Neither came from the `nm-ptd` adapter, which reads the state index and stamps
 * `saleDateConfirmed: true`. Both carry:
 *
 *     {"saleDateEstimated": true, "scheduleConfidence": "unresearched"}
 *
 * — the speculative-coverage path, with guessed dates (2026-08-06, 2026-08-08,
 * both since passed), no source PDF and generic titles. A generic scan attached
 * one notice's parcels (`AuctionAdvertisement-22-2.pdf`) to two placeholders.
 *
 * ## Why `purgeSkeletons` does not cover it
 *
 * That pass targets `lot_count = 0` with a future sale date — an empty shell.
 * These are the opposite shape: 93 lots each, dates already past. A skeleton is
 * a promise with nothing behind it; this is real parcel data filed under an
 * invented auction, which is worse, because it reads as inventory.
 *
 * ## Why deletion rather than `delisted_at`
 *
 * Delisting asserts something factual — that the county stopped publishing a
 * sale. That never happened here. These auctions were never published at all,
 * so recording them as withdrawn would put a false statement about a county's
 * conduct into the history the Archivist learns from.
 *
 * Both guards below refuse anything the authoritative path produced, so this
 * cannot be pointed at a real notice by editing TARGETS carelessly.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";

const APPLY = process.argv.includes("--apply");
const TARGETS = ["35001|2026-08-06", "35003|2026-08-08"];
const IN = sql.join(
  TARGETS.map((t) => sql`${t}`),
  sql`, `,
);

async function main() {
  const before = await db.execute(sql`
    SELECT a.external_id, a.county_fips, a.sale_date, count(l.id)::int lots,
           (a.raw->>'saleDateEstimated') AS estimated,
           (a.raw->>'scheduleConfidence') AS confidence
    FROM auctions a LEFT JOIN lots l ON l.auction_id=a.id
    WHERE a.external_id IN (${IN})
    GROUP BY 1,2,3,5,6`);
  console.log("\nTARGET (speculative placeholders, estimated dates, already past):");
  console.table(before as unknown as object[]);

  const rows = before as unknown as { external_id: string; estimated: string }[];
  if (rows.length === 0) {
    console.log("nothing to do — already removed");
    process.exit(0);
  }
  for (const r of rows) {
    // A published notice is never a target, whatever TARGETS says.
    if (r.external_id.startsWith("nm-ptd:")) {
      throw new Error(`refusing: ${r.external_id} is a published notice`);
    }
    if (r.estimated !== "true") {
      throw new Error(`refusing: ${r.external_id} is not an estimated-date auction`);
    }
  }

  if (!APPLY) {
    console.log("\n(dry run — pass --apply to delete)");
    process.exit(0);
  }

  const dl = await db.execute(sql`
    DELETE FROM lots WHERE auction_id IN (SELECT id FROM auctions WHERE external_id IN (${IN}))`);
  const da = await db.execute(sql`DELETE FROM auctions WHERE external_id IN (${IN})`);
  console.log(`deleted lots: ${(dl as { rowCount?: number }).rowCount}, auctions: ${(da as { rowCount?: number }).rowCount}`);

  const dup = await db.execute(sql`
    SELECT count(*)::int remaining FROM (
      SELECT l.parcel_number FROM lots l JOIN auctions a ON a.id=l.auction_id
      WHERE a.county_fips LIKE '35%' AND l.parcel_number IS NOT NULL
      GROUP BY 1 HAVING count(DISTINCT a.county_fips) > 1) t`);
  console.log("NM parcels still claimed by more than one county:");
  console.table(dup as unknown as object[]);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
