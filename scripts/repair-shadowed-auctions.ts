/**
 * Collapse an empty auction row that shadows a real one.
 *
 *   npm run repair:shadowed -- --dry-run
 *   npm run repair:shadowed
 *
 * ## What went wrong
 *
 * Sale calendars are discovered before catalogs are. A county's own calendar
 * gives a date and a link and nothing stable to key on, so it lands as an
 * auction row with no parcels. When the catalog for that same sale arrives
 * later it carries a different `externalId`, the upsert's
 * `(county, platform, externalId)` target misses, and the table holds two rows
 * for one sale — one with the parcels, one with none.
 *
 * `adoptPlaceholder` in `lib/ingest/runner.ts` stops new pairs forming: an
 * incoming catalog re-keys an empty same-day sibling rather than sitting beside
 * it. This clears the ones that formed before that existed.
 *
 * ## Why it is worth a script rather than a note
 *
 * The duplicates were not merely cosmetic. Every shadowed placeholder found
 * here carried a `cape_productions` row, which means a county briefing was
 * generated from the row holding **zero parcels** rather than from the sale
 * with the catalog. Charlotte's 29 September sale has 52 parcels and its
 * briefing was built against an empty row.
 *
 * ## What it does, and what it refuses to do
 *
 * Only a row with no parcels is ever touched, and only when a populated sibling
 * exists for the same county, platform, sale type and date. Two *populated*
 * lists for one day are a disagreement, not a duplicate, and are left alone —
 * Harris County runs eight constable sales on one date and every one is real.
 *
 * A production on the placeholder moves to the populated sale when that sale
 * has none, so the artifact is not orphaned; its `inputsHash` will no longer
 * match and CAPE will regenerate it from the parcels that were always there.
 * When the populated sale already has its own production, the placeholder's is
 * the redundant one and goes with it.
 */
import "../lib/env";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

const dryRun = process.argv.includes("--dry-run");

interface Shadowed {
  id: string;
  keeper: string;
  county_fips: string;
  d: string;
  platform: string;
  keeper_lots: number;
  had_production: boolean;
  keeper_production: boolean;
}

async function main() {
  const rows = (await db.execute(sql`
    select a.id, b.id as keeper, a.county_fips, a.sale_date::text as d, a.platform,
           (select count(*) from lots l where l.auction_id = b.id)::int as keeper_lots,
           exists (select 1 from cape_productions p where p.auction_id = a.id) as had_production,
           exists (select 1 from cape_productions p where p.auction_id = b.id) as keeper_production
    from auctions a
    join auctions b
      on b.county_fips = a.county_fips and b.platform = a.platform
     and b.sale_type = a.sale_type and b.sale_date = a.sale_date and b.id <> a.id
    where not exists (select 1 from lots l where l.auction_id = a.id)
      and exists (select 1 from lots l2 where l2.auction_id = b.id)
  `)) as unknown as Shadowed[];

  if (rows.length === 0) {
    console.log("No empty auction rows are shadowing a populated one.");
    return;
  }

  console.log(`${rows.length} empty row(s) shadowing a populated sale:\n`);
  for (const r of rows) {
    const fate = !r.had_production
      ? "nothing attached"
      : r.keeper_production
        ? "production dropped — the real sale has its own"
        : "production moved to the real sale";
    console.log(
      `  ${r.county_fips} ${r.d} ${r.platform.padEnd(14)} ` +
        `keeper holds ${String(r.keeper_lots).padStart(4)} parcels — ${fate}`,
    );
  }

  if (dryRun) {
    console.log("\n(dry run — nothing changed)");
    return;
  }

  let moved = 0;
  for (const r of rows) {
    if (r.had_production && !r.keeper_production) {
      await db.execute(
        sql`update cape_productions set auction_id = ${r.keeper} where auction_id = ${r.id}`,
      );
      moved++;
    }
    /* Anything still attached goes with the row — the FK cascades. */
    await db.execute(sql`delete from auctions where id = ${r.id}`);
  }

  console.log(`\nremoved ${rows.length} shadow row(s); moved ${moved} production(s) to the real sale`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.cause?.message ?? e);
    process.exit(1);
  });
