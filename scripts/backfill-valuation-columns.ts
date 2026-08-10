/**
 * Move building characteristics out of `raw` and into their new columns.
 *
 *   npx tsx scripts/backfill-valuation-columns.ts [--apply]
 *
 * `PropertyProvider` has returned beds, baths, lot size, building size, year
 * built and property type since it was written, but `lot_valuations` had no
 * columns for them, so the write path put them in the `raw` JSON blob where no
 * query could reach them. The columns exist now; this recovers the history.
 *
 * No provider call is needed — every value here was already fetched and paid
 * for. Dry by default; pass `--apply` to write.
 */
import "../lib/env";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lotValuations } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");

/*
 * Explicit dotted paths, in priority order, read off the stored payloads
 * rather than guessed. An earlier version of this script searched a bag of
 * lowercase key names across a few nested objects and produced 13 beds against
 * 537 baths, zero building sizes and zero property types — ATTOM nests two
 * levels deep in camelCase (`building.rooms.bathsTotal`), which no amount of
 * fuzzy matching was going to reach. Guessing at key names is how a backfill
 * writes numbers nobody can trace.
 *
 * `lot.lotSize1` is deliberately absent: ATTOM publishes it in acres while
 * `lotSize2` is square feet, and this column is square feet. Reading the wrong
 * one would put "1" in a field the page renders as "1 sqft".
 */
const PATHS = {
  beds: ["building.rooms.beds", "beds", "bedrooms"],
  baths: ["building.rooms.bathsTotal", "baths", "bathrooms"],
  lotSqft: ["lot.lotSize2", "lotSize"],
  buildingSqft: [
    "building.size.livingSize",
    "building.size.universalSize",
    "building.size.bldgSize",
    "squareFootage",
  ],
  yearBuilt: ["summary.yearBuilt", "yearBuilt"],
  propertyType: ["summary.propertyType", "summary.propType", "propertyType"],
} as const;

function at(raw: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, raw);
}

function pickNumber(raw: Record<string, unknown>, paths: readonly string[]): number | null {
  for (const p of paths) {
    const v = at(raw, p);
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    // 0 is rejected for these fields on purpose: a zero year built, zero lot
    // size or zero living area is a provider placeholder, not a measurement.
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pickString(raw: Record<string, unknown>, paths: readonly string[]): string | null {
  for (const p of paths) {
    const v = at(raw, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function main() {
  const rows = await db
    .select({ id: lotValuations.id, raw: lotValuations.raw, source: lotValuations.source })
    .from(lotValuations);

  console.log(`${rows.length} valuation row(s) to inspect`);

  const filled = { beds: 0, baths: 0, lotSqft: 0, buildingSqft: 0, yearBuilt: 0, propertyType: 0 };
  let touched = 0;

  for (const r of rows) {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    if (!Object.keys(raw).length) continue;

    const beds = pickNumber(raw, PATHS.beds);
    const baths = pickNumber(raw, PATHS.baths);
    const lotSqft = pickNumber(raw, PATHS.lotSqft);
    const buildingSqft = pickNumber(raw, PATHS.buildingSqft);
    const yearBuilt = pickNumber(raw, PATHS.yearBuilt);
    const propertyType = pickString(raw, PATHS.propertyType);

    const set: Record<string, unknown> = {};
    if (beds !== null) {
      set.beds = beds;
      filled.beds++;
    }
    if (baths !== null) {
      set.baths = String(baths);
      filled.baths++;
    }
    if (lotSqft !== null) {
      set.lotSqft = lotSqft;
      filled.lotSqft++;
    }
    if (buildingSqft !== null) {
      set.buildingSqft = buildingSqft;
      filled.buildingSqft++;
    }
    if (yearBuilt !== null) {
      set.yearBuilt = yearBuilt;
      filled.yearBuilt++;
    }
    if (propertyType !== null) {
      set.propertyType = propertyType;
      filled.propertyType++;
    }

    if (!Object.keys(set).length) continue;
    touched++;
    if (APPLY) await db.update(lotValuations).set(set).where(eq(lotValuations.id, r.id));
  }

  console.log(`${touched} row(s) with something to recover`);
  console.table([filled]);
  console.log(APPLY ? "applied" : "dry run — pass --apply to write");

  const after = await db.execute(
    sql.raw(`SELECT count(*)::int AS rows, count(beds)::int AS beds, count(baths)::int AS baths,
                    count(lot_sqft)::int AS lot_sqft, count(building_sqft)::int AS building_sqft,
                    count(year_built)::int AS year_built, count(property_type)::int AS property_type
             FROM lot_valuations`),
  );
  console.table(after);
  process.exit(0);
}

main();
