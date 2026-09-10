/**
 * Clear the delisting flag from imported announcements.
 *
 *   npm run repair:delisting -- --dry-run
 *   npm run repair:delisting
 *
 * The work itself lives in `lib/ops/tasks.ts` so this and the console button
 * cannot drift: two implementations of "the same" repair are two repairs.
 * What stays here is the terminal's own affordance — a dry run, which a button
 * has no room for and an operator at a prompt reasonably expects.
 */
import "../lib/env";
import { and, isNotNull, like } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions } from "../lib/db/schema";
import { IMPORT_ID_SQL_PATTERN } from "../lib/import/provenance";
import { opsTask } from "../lib/ops/tasks";

const flag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  if (flag("dry-run")) {
    const rows = await db
      .select({
        countyFips: auctions.countyFips,
        saleDate: auctions.saleDate,
        announced: auctions.announcedParcelCount,
      })
      .from(auctions)
      .where(and(like(auctions.externalId, IMPORT_ID_SQL_PATTERN), isNotNull(auctions.delistedAt)));

    if (rows.length === 0) {
      console.log("No imported announcements are flagged as delisted.");
      process.exit(0);
    }
    for (const r of rows.slice(0, 10)) {
      console.log(`  ${r.countyFips} ${r.saleDate} — ${r.announced ?? 0} parcels`);
    }
    if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
    console.log(`\n${rows.length} would be cleared. Dry run — nothing written.`);
    process.exit(0);
  }

  const task = opsTask("repair-delisting")!;
  const result = await task.run({ limit: 0, deadline: Date.now() + 60_000 });
  console.log(result.summary);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
