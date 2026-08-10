/**
 * Recover assessed improvement value from stored ATTOM responses.
 *
 *   npx tsx scripts/backfill-attom-improvement.ts [--apply]
 *
 * `lib/property/providers/attom.ts` read `assdImpValue` where ATTOM publishes
 * `assdImprValue`, so `improvementValue` came back undefined for every parcel
 * and `lot_valuations.assessed_improvement` was written null 915 times. Land
 * value used the correctly-spelled key and landed on 913 of the same rows,
 * which is why the gap read as "counties publish land but not improvement"
 * rather than as a typo.
 *
 * No ATTOM call is needed to fix it: the whole response is kept in
 * `lot_valuations.raw`, so this reads the value that was already paid for.
 *
 * Dry by default — prints what it would change. Pass `--apply` to write.
 */
import "../lib/env";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lotValuations } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");

function improvementFrom(raw: unknown): number | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const assessment = (r.assessment ?? {}) as Record<string, unknown>;
  const assessed = (assessment.assessed ?? {}) as Record<string, unknown>;
  const v = assessed.assdImprValue ?? assessed.assdImpValue;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const rows = await db
    .select({ id: lotValuations.id, raw: lotValuations.raw, total: lotValuations.assessedTotal })
    .from(lotValuations)
    .where(and(eq(lotValuations.source, "attom"), isNull(lotValuations.assessedImprovement)));

  console.log(`${rows.length} attom row(s) missing assessed_improvement`);

  let recoverable = 0;
  let applied = 0;
  /*
   * Counted and reported rather than corrected. If land + improvement does not
   * equal the total ATTOM also gave us, the response disagrees with itself and
   * the right move is to know how often that happens — not to quietly write a
   * number that fails its own cross-check.
   */
  let inconsistent = 0;

  for (const row of rows) {
    const improvement = improvementFrom(row.raw);
    if (improvement === null) continue;
    recoverable++;

    if (row.total !== null && Math.abs(improvement - Number(row.total)) > Number(row.total)) {
      inconsistent++;
      continue;
    }

    if (APPLY) {
      await db
        .update(lotValuations)
        .set({ assessedImprovement: String(improvement) })
        .where(eq(lotValuations.id, row.id));
      applied++;
    }
  }

  console.log(`${recoverable} recoverable from stored raw`);
  if (inconsistent) console.log(`${inconsistent} skipped — improvement exceeded the total`);
  console.log(APPLY ? `${applied} row(s) updated` : "dry run — pass --apply to write");

  const after = await db.execute(
    sql.raw(`SELECT count(*)::int AS rows, count(assessed_improvement)::int AS with_improvement
             FROM lot_valuations WHERE source='attom'`),
  );
  console.table(after);
  process.exit(0);
}

main();
