/**
 * Put coordinates, city and ZIP on lots that have a street address and none.
 *
 *   npx tsx scripts/geocode-lots.ts --state LA
 *   npx tsx scripts/geocode-lots.ts --fips 22051 --limit 200
 *
 * ## Why the Census geocoder
 *
 * Free, keyless, official, and US-only, which is the whole population here. It
 * is also the only one whose licence plainly permits storing the result.
 *
 * ## Why the parish is left out of the query
 *
 * Counter-intuitively, adding it makes matching worse:
 *
 *     "3852 N DEERWOOD DR, Jefferson Parish, LA"  ->  no match
 *     "3852 N DEERWOOD DR, Metairie, LA"          ->  no match
 *     "3852 N DEERWOOD DR, LA"                    ->  3852 N DEERWOOD DR, HARVEY, LA 70058
 *
 * The index is keyed on incorporated places, not parishes, and a wrong guess at
 * the city excludes the right answer. Sending street and state alone lets the
 * geocoder supply the locality itself — which is the part we were missing.
 *
 * ## What this is actually for
 *
 * Louisiana's 1,638 lots carry no valuation and no coordinate. Two things follow
 * from filling that in, and the second is the larger:
 *
 * 1. A point can be matched against a parcel polygon, when a layer for the
 *    parish is eventually found. Nothing to join to today.
 * 2. **City and ZIP arrive with the coordinate.** Every address-keyed provider —
 *    RentCast, and the searched lookup — needs those and has been refusing these
 *    lots for the want of them. That works now, without any new source.
 *
 * ## What it will not do
 *
 * Write a valuation. A geocode is a location, and a location is not a price. It
 * makes other lookups possible; it does not answer for them.
 */
import "../lib/env";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lots, auctions } from "../lib/db/schema";
import { ALL_COUNTIES } from "../lib/atlas";
// One geocoder, shared with the lookup box. See lib/property/geocode.ts.
import { geocodeAddress, type Located } from "../lib/property/geocode";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};


/**
 * Forms of an address worth trying, in order of fidelity.
 *
 * A first pass located 1,139 of 1,206 Louisiana lots and left 66, which turned
 * out not to be unlocatable so much as unparseable:
 *
 *     "620 23RD ST (LAND ONLY)"   an annotation the index reads as street
 *     "1630-32 LAFAYETTE ST"      a range of house numbers, not one address
 *     "12TH ST"                   an ordinal street with no house number
 *
 * The first two are the same address wearing something extra. The third is not
 * an address at all and no variant rescues it — a street name alone matches the
 * whole road.
 *
 * Variants are tried most-faithful first and the first hit wins, so a cleaned
 * form is only used when the original found nothing.
 */
export function addressVariants(raw: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.replace(/\s+/g, " ").trim();
    if (t && /^[0-9]/.test(t) && !out.includes(t)) out.push(t);
  };

  push(raw);
  // "620 23RD ST (LAND ONLY)" -> "620 23RD ST"
  const noParens = raw.replace(/\([^)]*\)/g, "");
  push(noParens);
  // "1630-32 LAFAYETTE ST" -> "1630 LAFAYETTE ST". The first number is the one
  // the parcel is indexed under; the second is the far end of a double lot.
  push(noParens.replace(/^(\d+)\s*[-–]\s*\d+\b/, "$1"));

  return out;
}

async function main() {
  const state = arg("state")?.toUpperCase();
  const fips = arg("fips");
  const limit = Number(arg("limit") ?? 5_000);
  if (!state && !fips) {
    console.error("usage: --state XX | --fips <5-digit>");
    process.exit(1);
  }

  const inCounties = fips
    ? [fips]
    : ALL_COUNTIES.filter((c) => c.state === state).map((c) => c.fips);

  const rows = await db
    .select({ id: lots.id, address: lots.addressLine, fips: auctions.countyFips })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(
      and(
        eq(lots.status, "pending"),
        isNull(lots.latitude),
        // A street number is the minimum a geocoder can work with; a street name
        // alone matches a whole road and would place the parcel anywhere on it.
        sql`${lots.addressLine} ~ '^[0-9]'`,
        sql`${auctions.countyFips} IN (${sql.join(inCounties.map((f) => sql`${f}`), sql`, `)})`,
      ),
    )
    .limit(limit);

  console.log(`${state ?? fips}: ${rows.length} lots with a street address and no coordinate\n`);

  const CONCURRENCY = 6;
  let ok = 0, miss = 0, done = 0;
  const queue = [...rows];

  async function worker() {
    for (;;) {
      const row = queue.pop();
      if (!row) return;
      const st = ALL_COUNTIES.find((c) => c.fips === row.fips)?.state ?? state ?? "";
      let hit: Located | null = null;
      for (const variant of addressVariants(String(row.address))) {
        hit = await geocodeAddress(variant, st, 25_000);
        if (hit) break;
      }
      if (hit) {
        await db
          .update(lots)
          .set({
            latitude: String(hit.lat),
            longitude: String(hit.lon),
            // Only filled where absent — a city the county published is better
            // evidence than one an index inferred.
            ...(hit.city ? { city: hit.city } : {}),
            ...(hit.zip ? { zip: hit.zip } : {}),
          })
          .where(eq(lots.id, row.id));
        ok++;
      } else miss++;
      if (++done % 200 === 0) console.log(`  ${done}/${rows.length} — ${ok} located, ${miss} missed`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\ndone: ${ok} located, ${miss} missed (${Math.round((ok / Math.max(1, ok + miss)) * 100)}%)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
