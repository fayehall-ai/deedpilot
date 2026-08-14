/**
 * Fill valuations from RentCast alone, for lots that now have a full address.
 *
 *   npx tsx scripts/bulk-rentcast.ts --state LA
 *
 * ## Why not `enrich:lots`
 *
 * That walks the whole provider chain, so every RentCast miss falls through to
 * the searched provider — twenty seconds and a paid Grok call each. On Louisiana
 * that would be roughly six hundred searches nobody asked for, arriving as a
 * surprise on a different bill from the one that was approved.
 *
 * This calls one provider and stops. A miss stays null for a later pass to
 * decide about deliberately.
 *
 * ## Why it can run at all now
 *
 * RentCast has been healthy throughout and unusable for these lots, because it
 * keys on a street address and Louisiana's had no city or ZIP. Geocoding filled
 * those in — 1,179 of 1,638 — so the provider that was already there and already
 * paid for can finally answer.
 */
import "../lib/env";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lots, auctions, counties } from "../lib/db/schema";
import { rentcastProvider } from "../lib/property/providers/rentcast";
import { applyRecordToLot } from "../lib/property/enrich";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const stateArg = arg("state")?.toUpperCase();
  const limit = Number(arg("limit") ?? 5_000);
  if (!stateArg) {
    console.error("usage: --state XX [--limit N]");
    process.exit(1);
  }
  const state: string = stateArg;
  if (!rentcastProvider.configured()) {
    console.error("RENTCAST_API_KEY is not set");
    process.exit(1);
  }

  const rows = await db
    .select({
      id: lots.id,
      address: lots.addressLine,
      city: lots.city,
      zip: lots.zip,
      parcel: lots.parcelNumber,
      fips: auctions.countyFips,
      countyName: counties.name,
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(
      and(
        eq(lots.status, "pending"),
        eq(counties.state, state),
        isNull(lots.assessedValue),
        // A city is the field that was missing; without it this provider cannot
        // answer and the call is wasted spend.
        isNotNull(lots.city),
        sql`${lots.addressLine} ~ '^[0-9]'`,
      ),
    )
    .limit(limit);

  console.log(`${state}: ${rows.length} lots with a full address and no valuation\n`);

  // Modest, because this is a metered API and a runaway loop here costs money
  // rather than patience.
  const CONCURRENCY = 4;
  let ok = 0, miss = 0, done = 0;
  const queue = [...rows];

  async function worker() {
    for (;;) {
      const row = queue.pop();
      if (!row) return;
      try {
        const rec = await rentcastProvider.lookup({
          state,
          fips: row.fips,
          countyName: row.countyName,
          parcelNumber: row.parcel,
          addressLine: row.address,
          city: row.city,
          zip: row.zip,
        });
        if (rec) {
          await applyRecordToLot(row.id, rec);
          ok++;
        } else miss++;
      } catch {
        miss++;
      }
      if (++done % 100 === 0) console.log(`  ${done}/${rows.length} — ${ok} valued, ${miss} missed`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\ndone: ${ok} valued, ${miss} missed (${Math.round((ok / Math.max(1, ok + miss)) * 100)}%)`);
  console.log(`RentCast calls made: ${ok + miss}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
