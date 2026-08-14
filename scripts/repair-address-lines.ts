/**
 * Clear address fields that are provably not addresses.
 *
 *   npx tsx scripts/repair-address-lines.ts            # dry run
 *   npx tsx scripts/repair-address-lines.ts --apply
 *
 * ## Why a repair rather than a re-crawl
 *
 * The Michigan catalog parser used to capture everything after "On" up to a
 * comma, which ran past the street into whatever followed — 494 rows ended up
 * holding a sale price and 852 a truncation marker. The parser is fixed and now
 * returns nothing for those cards.
 *
 * Returning nothing is not enough. The lot upsert writes the fields an adapter
 * supplies and leaves the rest alone, so a value that becomes `undefined` keeps
 * whatever was written before it. Re-crawling Michigan confirmed this: the
 * parser reports `{}` for every affected description and the old strings are
 * still in the column.
 *
 * ## Why not make the upsert clear absent fields
 *
 * Because absence has two meanings there. The catalog pass legitimately does not
 * know a street; the detail pass reads a real `Address:` field and fills it in
 * afterwards. Nulling on absence would erase a good address every time the
 * catalog refreshed — trading a wrong value for a lost one.
 *
 * ## Why these patterns are safe to clear
 *
 * Each is impossible in a real address: a dollar sign, the literal "sold for",
 * or an ellipsis the source itself emitted when truncating. None of them can
 * appear in a street a provider could resolve, and the field is an input to
 * enrichment — a wrong address is worse than none, because a null is skipped and
 * a wrong one is looked up.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";

const APPLY = process.argv.includes("--apply");

/** Fragments that cannot occur in a street name. */
const CORRUPT = sql`(
  address_line ILIKE '%sold for%'
  OR address_line LIKE '%$%'
  OR address_line LIKE '%...%'
  OR address_line LIKE '%' || chr(8230) || '%'
)`;

const CORRUPT_CITY = sql`(
  city LIKE '%...%'
  OR city LIKE '%' || chr(8230) || '%'
  OR city ILIKE '%sold for%'
)`;

async function main() {
  const before = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ${CORRUPT})::int bad_address,
           count(*) FILTER (WHERE ${CORRUPT_CITY})::int bad_city
    FROM lots`);
  console.log("\nRows holding a value that cannot be an address:");
  console.table(before as unknown as object[]);

  const sample = await db.execute(sql`
    SELECT address_line, city FROM lots WHERE ${CORRUPT} OR ${CORRUPT_CITY} LIMIT 6`);
  console.log("sample:");
  console.table(sample as unknown as object[]);

  if (!APPLY) {
    console.log("\n(dry run — pass --apply to clear these fields)");
    process.exit(0);
  }

  await db.execute(sql`UPDATE lots SET address_line = NULL WHERE ${CORRUPT}`);
  await db.execute(sql`UPDATE lots SET city = NULL WHERE ${CORRUPT_CITY}`);

  const after = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ${CORRUPT})::int bad_address,
           count(*) FILTER (WHERE ${CORRUPT_CITY})::int bad_city,
           count(address_line)::int addresses_remaining
    FROM lots`);
  console.log("after:");
  console.table(after as unknown as object[]);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
