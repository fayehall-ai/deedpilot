/**
 * Repair acreage and lot size on lots enriched before the ATTOM swap was fixed.
 *
 *   npx tsx scripts/repair-acreage.ts [--apply]
 *
 * `lotSize1` is acres and `lotSize2` is square feet; the provider had them
 * assigned to each other's fields, so `lots.acreage` was written in square
 * feet. The lot page rendered "ACREAGE 43,560" for a parcel of exactly one
 * acre. Re-derived from the stored payload rather than divided by 43,560 —
 * the true value is on record, so there is no reason to infer it.
 */
import "../lib/env";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lots, lotValuations } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");

function at(raw: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => {
    if (!a || typeof a !== "object") return undefined;
    return (a as Record<string, unknown>)[k];
  }, raw);
}
const numOf = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function main() {
  const rows = await db
    .select({ lotId: lotValuations.lotId, raw: lotValuations.raw, acreage: lots.acreage })
    .from(lotValuations)
    .innerJoin(lots, eq(lots.id, lotValuations.lotId))
    .where(eq(lotValuations.source, "attom"));

  let fixed = 0;
  let already = 0;
  for (const r of rows) {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    const acres = numOf(at(raw, "lot.lotSize1"));
    const sqft = numOf(at(raw, "lot.lotSize2"));
    if (acres === null) continue;
    if (r.acreage !== null && Math.abs(Number(r.acreage) - acres) < 0.001) {
      already++;
      continue;
    }
    fixed++;
    if (APPLY) {
      await db.update(lots).set({ acreage: String(acres) }).where(eq(lots.id, r.lotId));
      if (sqft !== null) {
        await db
          .update(lotValuations)
          .set({ lotSqft: Math.round(sqft) })
          .where(sql`${lotValuations.lotId} = ${r.lotId} and ${lotValuations.source} = 'attom'`);
      }
    }
  }
  console.log(`${rows.length} attom row(s); ${fixed} lot(s) with wrong acreage, ${already} already correct`);
  console.log(APPLY ? "applied" : "dry run — pass --apply to write");
  process.exit(0);
}
main();
