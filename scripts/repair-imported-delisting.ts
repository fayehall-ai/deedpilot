/**
 * Clear delisting that crawls applied to imported announcements.
 *
 *   npm run repair:delisting -- --dry-run
 *   npm run repair:delisting
 *
 * `reconcileCountyAuctions` used to flag any still-future sale a county crawl
 * did not see, which swept up imported announcements the county's page never
 * carried — 212 of 570 on the first pass, every one still real and scheduled.
 * `lib/ingest/reconcile.ts` no longer does that. This undoes what it did.
 *
 * Safe to run repeatedly, and worth re-running after any crawl started from a
 * process that loaded the old code, since a long-running worker keeps whatever
 * it was launched with.
 *
 * ## Why clearing every one of them is correct
 *
 * Nothing except that reconciler has ever written `delisted_at` on an imported
 * row. The import does not set it, and the fold in `lib/import/reconcile.ts`
 * deletes rather than flags. So every flag on a `ustla:` row is one of these,
 * and there is no legitimate delisting to preserve. The filter is on the id
 * namespace alone, deliberately — narrowing it to "flags set today" would leave
 * older ones behind for no reason.
 */

import "../lib/env";
import { and, isNotNull, like, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions } from "../lib/db/schema";
import { IMPORT_ID_SQL_PATTERN } from "../lib/import/provenance";

const flag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const affected = and(
    like(auctions.externalId, IMPORT_ID_SQL_PATTERN),
    isNotNull(auctions.delistedAt),
  );

  const rows = await db
    .select({
      id: auctions.id,
      countyFips: auctions.countyFips,
      saleDate: auctions.saleDate,
      announced: auctions.announcedParcelCount,
    })
    .from(auctions)
    .where(affected);

  if (rows.length === 0) {
    console.log("No imported announcements are flagged as delisted.");
    process.exit(0);
  }

  const future = rows.filter((r) => r.saleDate >= new Date().toISOString().slice(0, 10));
  const parcels = rows.reduce((n, r) => n + (r.announced ?? 0), 0);
  console.log(
    `${rows.length} imported announcement(s) flagged as delisted ` +
      `(${future.length} still in the future, ${parcels.toLocaleString()} announced parcels).`,
  );

  if (flag("dry-run")) {
    for (const r of rows.slice(0, 10)) {
      console.log(`  ${r.countyFips} ${r.saleDate} — ${r.announced ?? 0} parcels`);
    }
    if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
    console.log("\nDry run — nothing written.");
    process.exit(0);
  }

  const cleared = await db
    .update(auctions)
    .set({ delistedAt: null })
    .where(affected)
    .returning({ id: auctions.id });

  console.log(`Cleared ${cleared.length}.`);

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auctions)
    .where(affected);
  console.log(n === 0 ? "None remain flagged." : `${n} still flagged — investigate.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
