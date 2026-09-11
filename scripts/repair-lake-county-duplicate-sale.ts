/**
 * Collapse Lake County's three records of one sale into one.
 *
 *   npx tsx scripts/repair-lake-county-duplicate-sale.ts --dry-run
 *   npx tsx scripts/repair-lake-county-duplicate-sale.ts
 *
 * ## The three
 *
 * Zeus sale 2640 — the 2026 Lake County Indiana Tax Lien Sale — is in the
 * database twice, and the new Zeus adapter would make it three times:
 *
 *   18089|2026-09-15   county_site   2026-09-15   8,611 lots   generic adapter
 *   import:96777       zeus          2026-09-08       0 lots   USTLA import
 *   zeus|2640          zeus          2026-09-08   7,187 lots   would be written
 *
 * They do not collide, because `auctions_source_key` is unique on
 * (countyFips, platform, externalId) and all three differ. Nothing would stop
 * a third row appearing; it simply has to be resolved deliberately.
 *
 * ## Why the generic row survives and the others do not
 *
 * The obvious move — run the Zeus adapter and delete the old rows — is wrong,
 * for two reasons.
 *
 * The first is that our 8,611 rows carry 8,525 distinct parcels and Zeus's page
 * now lists 7,187. The sale closed on 8 September; the page shows what was left
 * at the end. The ~1,338 parcels we hold and it does not are ones that left the
 * sale between the crawl and the gavel — redeemed, or pulled. That is history,
 * and `reconcile.ts` exists to mark such parcels rather than forget them.
 * Replacing our rows with the page's current state would delete the record that
 * they were ever in the sale.
 *
 * The second is that those lots are being filled with coordinates and situs
 * addresses from Indiana's cadastre as this is written. Deleting them throws
 * away the enrichment and the free lookups that produced it.
 *
 * So the generic row keeps its lots and takes the correct identity instead:
 * Zeus's own sale id, platform, published close date and title. A later Zeus
 * crawl then matches it on (18089, zeus, zeus|2640) and updates in place rather
 * than adding a fourth.
 *
 * ## The date
 *
 * 2026-09-08, and it is not a guess. The generic adapter projected 2026-09-15
 * from the state's typical schedule — that is where CAPE's "Auction date is
 * projected, not county-published" comes from. Zeus prints a window closing
 * 9/8/2026 10:00 PM CDT, and USTLA independently recorded 2026-09-08. Two
 * sources that do not share a pipeline agree, so the date is confirmed.
 *
 * ## What is deleted, and the guard on it
 *
 * Only `import:96777`, and only after checking it holds no lots and no CAPE
 * production. It is USTLA's record of the same sale, carrying nothing the
 * surviving row will not have. The script refuses rather than cascade-deleting
 * anything with data attached.
 */
import "../lib/env";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, capeProductions, lots } from "../lib/db/schema";

const flag = (n: string) => process.argv.includes(`--${n}`);

const FIPS = "18089";
const KEEP_EXTERNAL_ID = "18089|2026-09-15";
const DROP_EXTERNAL_ID = "import:96777";

/** Zeus's own published facts for sale 2640, as read off publicauctions.php. */
const ZEUS = {
  idSale: "2640",
  externalId: "zeus|2640",
  saleDate: "2026-09-08",
  title: "2026 Lake County Indiana Tax Lien Sale",
  sourceUrl: "https://www.zeusauction.com/publicsale.php?idSale=2640",
};

async function main() {
  const dry = flag("dry-run");

  const rows = await db
    .select({
      id: auctions.id,
      externalId: auctions.externalId,
      platform: auctions.platform,
      saleDate: auctions.saleDate,
      title: auctions.title,
    })
    .from(auctions)
    .where(eq(auctions.countyFips, FIPS));

  const keep = rows.find((r) => r.externalId === KEEP_EXTERNAL_ID);
  const drop = rows.find((r) => r.externalId === DROP_EXTERNAL_ID);

  if (!keep) {
    console.log(`No auction ${KEEP_EXTERNAL_ID} in ${FIPS} — already migrated, or never present.`);
    process.exit(0);
  }

  const [{ n: keepLots }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lots)
    .where(eq(lots.auctionId, keep.id))) as { n: number }[];

  console.log(`Keeping  ${keep.externalId}  (${keepLots.toLocaleString()} lots)`);
  console.log(`  external id    ${keep.externalId} -> ${ZEUS.externalId}`);
  console.log(`  platform       ${keep.platform} -> zeus`);
  console.log(`  sale date      ${keep.saleDate} -> ${ZEUS.saleDate} (confirmed)`);
  console.log(`  listing kind   -> sale_list`);
  console.log(`  title          ${JSON.stringify(keep.title)} -> ${JSON.stringify(ZEUS.title)}`);

  if (drop) {
    const [{ n: dropLots }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(lots)
      .where(eq(lots.auctionId, drop.id))) as { n: number }[];
    const [{ n: dropCape }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(capeProductions)
      .where(eq(capeProductions.auctionId, drop.id))) as { n: number }[];

    console.log(`\nDropping ${drop.externalId}  (${dropLots} lots, ${dropCape} CAPE row(s))`);

    if (dropLots > 0 || dropCape > 0) {
      console.error(
        `\nRefusing: ${drop.externalId} has data attached. ` +
          `This script only removes an empty duplicate, never a row someone would miss.`,
      );
      process.exit(1);
    }
  } else {
    console.log(`\n${DROP_EXTERNAL_ID} is already gone.`);
  }

  if (dry) {
    console.log("\n(dry run — nothing written)");
    process.exit(0);
  }

  /*
   * Drop first. Both rows would briefly be (18089, zeus, ...) and while the
   * unique key tolerates that — the external ids differ — removing the empty
   * one first keeps the calendar from ever showing two Lake County sales on
   * the same day, even for the length of a transaction.
   */
  if (drop) {
    await db.delete(auctions).where(eq(auctions.id, drop.id));
  }

  await db
    .update(auctions)
    .set({
      externalId: ZEUS.externalId,
      platform: "zeus",
      saleDate: ZEUS.saleDate,
      saleDateConfirmed: true,
      listingKind: "sale_list",
      status: "closed",
      title: ZEUS.title,
      sourceUrl: ZEUS.sourceUrl,
    })
    .where(and(eq(auctions.id, keep.id), eq(auctions.countyFips, FIPS)));

  console.log(`\nLake County now holds one record of Zeus sale ${ZEUS.idSale}.`);
  console.log(
    `Its CAPE production is now stale by inputs hash, which is correct — ` +
      `the script was written against a projected date and the wrong county.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
