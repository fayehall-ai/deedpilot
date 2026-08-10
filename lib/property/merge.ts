/**
 * One property record assembled from every provider that answered.
 *
 * The lot page used to render `valuations[0]` — the single most recently
 * fetched row. That is wrong whenever providers disagree in *coverage* rather
 * than in value, which is most of the time: RentCast returns a market estimate
 * and nothing else, ATTOM returns the full assessment. A parcel enriched by
 * ATTOM in June and RentCast in August therefore showed the August row, and the
 * assessment ATTOM had already been paid for vanished from the page — visibly,
 * as an em dash where a number belonged.
 *
 * So fields are merged rather than rows picked: for each field, the newest
 * provider that actually has a value wins. That keeps recency where two
 * providers genuinely disagree, without letting a thin recent answer erase a
 * rich older one.
 *
 * Provenance is kept per field. "Enriched via rentcast" under an assessment
 * that came from ATTOM is a small lie, and on a page whose whole claim is that
 * you can check the numbers, the source of a number is part of the number.
 */
import type { lotValuations } from "@/lib/db/schema";

type ValuationRow = typeof lotValuations.$inferSelect;

/** Fields worth merging. Everything here is nullable on every provider. */
const MERGED_FIELDS = [
  "assessedTotal",
  "assessedLand",
  "assessedImprovement",
  "marketValue",
  "lastSaleAmount",
  "lastSaleDate",
  "taxYear",
  "homestead",
  "zoning",
  "floodZone",
  "beds",
  "baths",
  "lotSqft",
  "buildingSqft",
  "yearBuilt",
  "propertyType",
] as const satisfies readonly (keyof ValuationRow)[];

export type MergedField = (typeof MERGED_FIELDS)[number];

export type MergedProperty = {
  [K in MergedField]: ValuationRow[K];
} & {
  /** Which source supplied each field, for the fields that have one. */
  sources: Partial<Record<MergedField, string>>;
  /** Every source that contributed at least one field, newest first. */
  contributors: string[];
  /** Newest fetch across contributing rows. */
  fetchedAt: Date | null;
};

/**
 * `false` and `0` are values; only null/undefined/"" are absences.
 *
 * Written out rather than relying on truthiness because three of the merged
 * fields are legitimately falsy: `homestead` is a boolean, and an assessed
 * value or bed count of 0 is a real answer from a county that means something
 * different from "we never asked".
 */
function present(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

/**
 * Merge valuation rows into one record, newest-first.
 *
 * Rows are expected in the order `getLotValuations` returns them (newest
 * first); this sorts defensively anyway, because a caller that reorders them
 * would otherwise silently invert the precedence rule.
 */
export function mergeValuations(rows: ValuationRow[]): MergedProperty | null {
  if (rows.length === 0) return null;

  const ordered = [...rows].sort(
    (a, b) => (b.fetchedAt?.getTime() ?? 0) - (a.fetchedAt?.getTime() ?? 0),
  );

  /*
   * Collected into a loose record and cast once at the end, rather than
   * written field-by-field into a typed object. Indexing a typed object with a
   * `keyof` variable makes TypeScript widen the value to the union of every
   * column type, so each assignment needs its own suppression — and a file full
   * of suppressions is a file where a genuine mismatch would not be noticed.
   * One cast, on a record whose keys are the same list the type is built from.
   */
  const values: Record<string, unknown> = {};
  const sources: Partial<Record<MergedField, string>> = {};

  for (const field of MERGED_FIELDS) {
    const hit = ordered.find((row) => present(row[field]));
    values[field] = hit ? hit[field] : null;
    if (hit) sources[field] = hit.source;
  }

  const used = new Set(Object.values(sources));
  return {
    ...(values as { [K in MergedField]: ValuationRow[K] }),
    sources,
    contributors: ordered.map((r) => r.source).filter((s) => used.has(s)),
    fetchedAt: ordered[0].fetchedAt ?? null,
  };
}

/**
 * How to describe where this record came from, in one line.
 *
 * Names every contributing source rather than just the newest, because that is
 * what the merge actually did.
 */
export function provenanceLabel(merged: MergedProperty): string {
  if (merged.contributors.length === 0) return "no provider data";
  return merged.contributors.join(" + ");
}
