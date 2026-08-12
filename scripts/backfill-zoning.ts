/**
 * Recover zoning from stored ATTOM payloads.
 *
 *   npx tsx scripts/backfill-zoning.ts [--apply]
 *
 * `lot.zoningType` is on every ATTOM record we hold and was never mapped, so
 * `lot_valuations.zoning` is null on all 1,695 rows while the value sits in
 * `raw`. No provider call needed.
 */
import "../lib/env";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lotValuations } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await db
    .select({ id: lotValuations.id, raw: lotValuations.raw, zoning: lotValuations.zoning })
    .from(lotValuations)
    .where(eq(lotValuations.source, "attom"));

  let fixed = 0;
  for (const r of rows) {
    if (r.zoning) continue;
    const raw = (r.raw ?? {}) as { lot?: { zoningType?: unknown } };
    const z = typeof raw.lot?.zoningType === "string" ? raw.lot.zoningType.trim() : "";
    if (!z) continue;
    fixed++;
    if (APPLY) await db.update(lotValuations).set({ zoning: z }).where(eq(lotValuations.id, r.id));
  }
  console.log(`${rows.length} attom row(s); ${fixed} recoverable zoning value(s)`);
  console.log(APPLY ? "applied" : "dry run — pass --apply to write");
  const after = await db.execute(
    sql.raw(`SELECT count(*)::int AS rows, count(zoning)::int AS with_zoning
             FROM lot_valuations WHERE source='attom'`));
  console.table(after);
  process.exit(0);
}
main();
