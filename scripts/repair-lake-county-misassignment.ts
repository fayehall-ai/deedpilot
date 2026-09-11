/**
 * Move Zeus sale 2640 from St. Joseph County to Lake County, where it is.
 *
 *   npx tsx scripts/repair-lake-county-misassignment.ts --dry-run
 *   npx tsx scripts/repair-lake-county-misassignment.ts
 *
 * ## What is wrong
 *
 * One auction — 8,611 lots, the largest single block of parcels we hold — is
 * recorded against St. Joseph County, Indiana (18141). Its parcels are Lake
 * County's (18089). 8,610 of the 8,611 parcel numbers begin `45`, which is
 * Indiana's DLGF county code for Lake, and eight sampled at random resolve
 * against Indiana's own statewide parcel service to `county_fips 18089` with
 * situs cities of Gary, Dyer, Merrillville and Winfield. None of those is in
 * St. Joseph County, whose seat is South Bend.
 *
 * ## Why it happened
 *
 * `data/source-registry.json` binds `zeusauction.com/publicauctions.php` to
 * county 18141, at confidence 0.43, origin `link_followed`. That page is Zeus's
 * national index of public auctions, not a St. Joseph source. The generic
 * adapter builds its auction key as `${binding.countyFips}|${saleDate}` and
 * files whatever it scrapes under the county the registry named, so it took
 * Lake County's sale and labelled it St. Joseph's. The registry entry is
 * removed here as well as the data corrected; leaving it would have the next
 * generic crawl recreate exactly this row.
 *
 * A single-county binding is the wrong shape for a multi-county platform. The
 * durable fix is a Zeus adapter with its own `discoverCounties()`, which is how
 * every other platform in `lib/ingest/adapters` avoids this. Until that exists,
 * no binding is better than a wrong one: Zeus inventory stops arriving rather
 * than arriving mislabelled.
 *
 * ## Why the external id moves too
 *
 * `auctions_source_key` is unique on (countyFips, platform, externalId) and the
 * generic adapter derives the id from the FIPS. Leaving `18141|2026-09-15` on a
 * Lake County row would be a key that disagrees with its own county, and would
 * collide the day someone correctly binds Zeus to 18089.
 *
 * ## What is deliberately not touched
 *
 * The other 18141 row — `import:96770`, 2026-09-01, zero lots — stays. It came
 * from a USTLA import rather than this crawl, it carries no parcels to test
 * against, and the USTLA export for this window lists neither St. Joseph nor
 * Lake. There is no evidence it is wrong, and moving it on the strength of its
 * neighbour would be a guess.
 */
import "../lib/env";
import { eq, sql } from "drizzle-orm";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db";
import { auctions, lots } from "../lib/db/schema";

const flag = (n: string) => process.argv.includes(`--${n}`);

const FROM_FIPS = "18141";
const TO_FIPS = "18089";
const OLD_EXTERNAL_ID = "18141|2026-09-15";
const NEW_EXTERNAL_ID = "18089|2026-09-15";
const REGISTRY = join(process.cwd(), "data", "source-registry.json");
const ZEUS_HOST = "zeusauction.com";

async function main() {
  const dry = flag("dry-run");

  const [target] = await db
    .select({ id: auctions.id, fips: auctions.countyFips, saleDate: auctions.saleDate })
    .from(auctions)
    .where(eq(auctions.externalId, OLD_EXTERNAL_ID))
    .limit(1);

  if (!target) {
    console.log(`No auction with external_id ${OLD_EXTERNAL_ID} — already repaired, or never present.`);
    process.exit(0);
  }

  const [{ n: lotCount }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lots)
    .where(eq(lots.auctionId, target.id))) as { n: number }[];

  /*
   * The evidence, re-checked at run time rather than trusted from the header.
   * If this is not overwhelmingly a `45` county, something has changed and the
   * repair should not proceed on last week's reasoning.
   */
  const [{ lake, other }] = (await db
    .select({
      lake: sql<number>`count(*) filter (where left(${lots.parcelNumber}, 2) = '45')::int`,
      other: sql<number>`count(*) filter (where left(${lots.parcelNumber}, 2) <> '45')::int`,
    })
    .from(lots)
    .where(eq(lots.auctionId, target.id))) as { lake: number; other: number }[];

  console.log(`Auction ${target.id}`);
  console.log(`  sale date      ${target.saleDate}`);
  console.log(`  county         ${target.fips} -> ${TO_FIPS}`);
  console.log(`  external id    ${OLD_EXTERNAL_ID} -> ${NEW_EXTERNAL_ID}`);
  console.log(`  lots           ${lotCount}`);
  console.log(`  parcel prefix  ${lake} begin '45' (Lake), ${other} do not`);

  if (lake === 0 || lake < other) {
    console.error(`\nRefusing: the parcels do not look like Lake County's. Re-check before repairing.`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
    counties: Record<string, { sources?: { host?: string; url?: string }[] }>;
  };
  const entry = registry.counties?.[FROM_FIPS];
  const zeusSources = (entry?.sources ?? []).filter(
    (s) => (s.host ?? "").includes(ZEUS_HOST) || (s.url ?? "").includes(ZEUS_HOST),
  );
  console.log(`  registry       ${zeusSources.length} Zeus source(s) bound to ${FROM_FIPS}`);

  if (dry) {
    console.log("\n(dry run — nothing written)");
    process.exit(0);
  }

  await db
    .update(auctions)
    .set({ countyFips: TO_FIPS, externalId: NEW_EXTERNAL_ID })
    .where(eq(auctions.id, target.id));

  const moved = await db
    .update(lots)
    .set({ countyFips: TO_FIPS })
    .where(eq(lots.auctionId, target.id))
    .returning({ id: lots.id });

  if (entry && zeusSources.length > 0) {
    entry.sources = (entry.sources ?? []).filter((s) => !zeusSources.includes(s));
    /*
     * A county whose only source was the bad one is a gap again, and should say
     * so — that is what puts it back in front of the prospector.
     */
    if (entry.sources.length === 0) {
      (entry as Record<string, unknown>).isGap = true;
    }
    writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
  }

  console.log(`\nMoved the auction and ${moved.length} lot(s) to ${TO_FIPS}.`);
  console.log(`Removed ${zeusSources.length} Zeus binding(s) from ${FROM_FIPS} in the registry.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
