/**
 * RealEstateAPI PropertyDetail for every parcel the spend policy allows.
 *
 *   npm run enrich:reapi -- --dry-run          # count and cost, no calls
 *   npm run enrich:reapi                       # next 8 weeks of sales
 *   npm run enrich:reapi -- --days 28 --limit 500 --concurrency 5
 *
 * Asks RealEstateAPI directly rather than walking the provider chain: in the
 * chain the free assessor layer answers first and a paid detail record is
 * never fetched for a parcel that has one, which is the point of this run.
 *
 * Soonest sale first, then highest opening bid — a parcel enriched after its
 * sale is worth nothing. Parcels with a detail record under 90 days old are
 * skipped, so a stopped run resumes where it left off without paying twice.
 * An empty wallet or rejected key stops the run; the rest are not misses.
 */
import "../lib/env";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties, lots } from "../lib/db/schema";
import { recordUsage } from "../lib/ai/usage";
import { applyRecordToLot } from "../lib/property/enrich";
import { realestateapiProvider } from "../lib/property/providers/realestateapi";
import { paidLookupRefusal } from "../lib/property/spend-policy";
import { landOnlySql } from "../lib/lots/land-only";
import { ProviderUnavailableError } from "../lib/property/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const days = Number(arg("days") ?? 56);
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const concurrency = Number(arg("concurrency") ?? 5);

  if (!realestateapiProvider.configured()) throw new Error("REALESTATEAPI_API_KEY is not set");

  /* The spend policy, in SQL, so the selection and the per-lot check agree. */
  const rows = await db
    .select({
      id: lots.id,
      parcelNumber: lots.parcelNumber,
      addressLine: lots.addressLine,
      city: lots.city,
      zip: lots.zip,
      landUse: lots.landUse,
      buildingSqft: lots.buildingSqft,
      yearBuilt: lots.yearBuilt,
      lotStatus: lots.status,
      saleType: auctions.saleType,
      auctionStatus: auctions.status,
      delistedAt: auctions.delistedAt,
      saleDateConfirmed: auctions.saleDateConfirmed,
      saleDate: auctions.saleDate,
      state: counties.state,
      fips: counties.fips,
      countyName: counties.name,
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(
      and(
        sql`${auctions.saleDate} between current_date and current_date + ${days}::int`,
        sql`${auctions.saleType} <> 'Tax Lien'`,
        sql`${auctions.status} <> 'cancelled' and ${auctions.delistedAt} is null`,
        eq(auctions.saleDateConfirmed, true),
        eq(lots.status, "pending"),
        sql`not ${landOnlySql}`,
        sql`not exists (
          select 1 from lot_valuations v
          where v.lot_id = ${lots.id} and v.source = 'realestateapi'
            and v.raw ? 'propertyInfo' and v.fetched_at > now() - interval '90 days'
        )`,
      ),
    )
    .orderBy(auctions.saleDate, sql`${lots.openingBid} desc nulls last`, lots.id)
    .limit(limit ?? 100_000);

  console.log(`${rows.length} parcel(s) to look up, sales in the next ${days} days`);
  if (flag("dry-run")) return;

  let done = 0;
  let hit = 0;
  let miss = 0;
  let failed = 0;
  let stopped: string | null = null;
  const started = Date.now();
  const queue = [...rows];

  async function worker() {
    while (queue.length && !stopped) {
      const r = queue.shift()!;
      /* Belt and braces: the same rule the enrichment chain applies. */
      const refusal = paidLookupRefusal({
        saleType: r.saleType,
        auctionStatus: r.auctionStatus,
        delisted: r.delistedAt !== null,
        saleDateConfirmed: r.saleDateConfirmed,
        lotStatus: r.lotStatus,
        addressLine: r.addressLine,
        landUse: r.landUse,
        buildingSqft: r.buildingSqft,
        yearBuilt: r.yearBuilt,
      });
      if (refusal) continue;

      await db.update(lots).set({ enrichmentAttemptedAt: new Date() }).where(eq(lots.id, r.id));
      void recordUsage({ provider: "realestateapi", operation: "enrich", requests: 1, countyFips: r.fips });
      try {
        const rec = await realestateapiProvider.lookup({
          state: r.state,
          fips: r.fips,
          countyName: r.countyName,
          parcelNumber: r.parcelNumber,
          addressLine: r.addressLine,
          city: r.city,
          zip: r.zip,
        });
        if (rec) {
          await applyRecordToLot(r.id, rec);
          hit++;
        } else miss++;
      } catch (e) {
        if (e instanceof ProviderUnavailableError) {
          stopped = e.message;
          return;
        }
        failed++;
        console.log(`fail ${r.id}: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 100 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(
          `${done}/${rows.length} · ${hit} hit · ${miss} miss · ${failed} failed · ${rate.toFixed(1)}/s · next sale ${r.saleDate}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(
    `\ndone in ${((Date.now() - started) / 60000).toFixed(1)} min — ${done} looked up, ${hit} hit, ${miss} miss, ${failed} failed` +
      (stopped ? `\nSTOPPED: ${stopped}. The ${queue.length} not yet asked are not misses; rerun to resume.` : ""),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
