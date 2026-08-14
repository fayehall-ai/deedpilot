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
 * ## Parcel numbers too
 *
 * The same failure reached a different column. Seven of St Charles County
 * Missouri's eight lots carry prose in `parcel_number`, one of them 879
 * characters of the statute's own specimen deed — "Therefore, this indenture,
 * made this ______ day of ______, 20______, between the state of Missouri, by
 * C. D., collector of said ______ County…". An extractor read the statutory form
 * printed beside the sale list as if it were parcel data.
 *
 * A parcel number is short and mostly digits. Prose in that column cannot match
 * any assessor layer, and every lookup it is handed is a wasted request — so it
 * is cleared on the same reasoning as the addresses: a null is skipped, a wrong
 * value is tried.
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

/**
 * Parcel identifiers are short and mostly digits; prose is not one.
 *
 * Two different faults land here and they need different remedies.
 *
 * Recoverable: a real identifier with commentary appended — Bell County TX
 * publishes `105238; Judgment Through Tax Year: 2024`, where `105238` is the
 * parcel and the rest is a note. Trimming at the separator keeps 31 usable ids
 * that clearing would have thrown away.
 *
 * Not recoverable: a value that was never an identifier — Michigan's "Multiple -
 * See Below", and St Charles County MO's 879 characters of the statute's own
 * specimen deed. Those are nulled.
 */
const RECOVERABLE_PARCEL = sql`(parcel_number ~ '^[0-9][0-9.\-]{2,}[;,] ')`;

const CORRUPT_PARCEL = sql`(
  (length(parcel_number) > 40 OR parcel_number ~ '[a-z]{5}')
  AND NOT ${sql`(parcel_number ~ '^[0-9][0-9.\-]{2,}[;,] ')`}
)`;

async function main() {
  const before = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ${CORRUPT})::int bad_address,
           count(*) FILTER (WHERE ${CORRUPT_CITY})::int bad_city,
           count(*) FILTER (WHERE ${CORRUPT_PARCEL})::int bad_parcel,
           count(*) FILTER (WHERE ${RECOVERABLE_PARCEL})::int trimmable_parcel
    FROM lots`);
  console.log("\nRows holding a value that cannot be what its column says:");
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
  // Trim before nulling, so a recoverable id is not caught by the broader rule.
  await db.execute(sql`
    UPDATE lots SET parcel_number = split_part(parcel_number, ';', 1)
    WHERE ${RECOVERABLE_PARCEL}`);
  await db.execute(sql`UPDATE lots SET parcel_number = NULL WHERE ${CORRUPT_PARCEL}`);

  const after = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ${CORRUPT})::int bad_address,
           count(*) FILTER (WHERE ${CORRUPT_CITY})::int bad_city,
           count(*) FILTER (WHERE ${CORRUPT_PARCEL})::int bad_parcel,
           count(address_line)::int addresses_remaining,
           count(parcel_number)::int parcels_remaining
    FROM lots`);
  console.log("after:");
  console.table(after as unknown as object[]);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
