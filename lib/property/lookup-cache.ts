/**
 * Remember property lookups, so the same address is not searched twice.
 *
 * A lookup costs a Tavily call plus an extraction and takes about twenty
 * seconds. On a public search box the same address genuinely does get asked
 * twice — the parcels people look up are the ones on a listing everybody is
 * reading — so the second ask should be free.
 *
 * ## The dangerous half is normalisation, not caching
 *
 * A cache key that is too loose returns *the wrong property*, which is far worse
 * than a slow answer and is the one failure this module must not have. "123 Main
 * St" and "123 Main Ave" are different places. So is "10 S Academy" and "10 N
 * Academy". Anything that could merge two real properties is left alone.
 *
 * What is normalised is only noise that cannot change which building is meant:
 * case, surrounding whitespace, repeated spaces, and trailing punctuation. No
 * abbreviation expansion, no directional folding, no unit stripping. The cost of
 * being too strict is a wasted search; the cost of being too loose is a wrong
 * valuation on a page a subscriber might bid against.
 *
 * ## Why misses expire sooner than hits
 *
 * A `found: false` is often a fact about the search rather than about the world
 * — a slow county portal, a rate limit, a page that had not been indexed yet.
 * Caching that for a week would make a transient failure permanent from the
 * reader's point of view. A hit is a valuation, which drifts slowly, so it can
 * be held far longer.
 */

import { and, eq, gt, sql } from "drizzle-orm";

/** How long an answer stays usable. */
export const HIT_TTL_DAYS = 14;
/** Much shorter — see the module header. */
export const MISS_TTL_HOURS = 6;

/**
 * The cache key.
 *
 * Conservative on purpose. Lowercases, collapses internal whitespace, and trims
 * surrounding punctuation. Everything that distinguishes one address from
 * another — street type, direction, unit, ZIP — survives untouched.
 */
export function normaliseAddress(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/^[\s,.;#-]+|[\s,.;#-]+$/g, "")
    .trim();
}

export interface CachedLookup<T> {
  result: T;
  citations: { url: string; title: string | null }[];
  fetchedAt: Date;
  /** Whole hours since it was fetched, for the "as of" line on the page. */
  ageHours: number;
}

async function conn() {
  const [{ db }, { propertyLookups }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
  ]);
  return { db, propertyLookups };
}

/**
 * A previous answer for this address, if one is still fresh.
 *
 * Never throws. A cache that cannot be reached must degrade to a slower correct
 * answer, not to an error — it is an optimisation, and an optimisation that can
 * take the feature down is a liability.
 */
export async function getCached<T>(query: string): Promise<CachedLookup<T> | null> {
  try {
    const { db, propertyLookups } = await conn();
    const key = normaliseAddress(query);

    const [row] = await db
      .select()
      .from(propertyLookups)
      .where(
        and(
          eq(propertyLookups.addressKey, key),
          // Freshness in SQL rather than in JS, so an expired row is simply not
          // selected and cannot be served by a branch that forgot to check.
          gt(
            propertyLookups.fetchedAt,
            sql`now() - (CASE WHEN ${propertyLookups.found}
                              THEN interval '${sql.raw(String(HIT_TTL_DAYS))} days'
                              ELSE interval '${sql.raw(String(MISS_TTL_HOURS))} hours' END)`,
          ),
        ),
      )
      .limit(1);

    if (!row) return null;

    // Counted after the freshness check, so the number means "served from cache"
    // rather than "matched a key". Not awaited — a stats update must never be
    // the reason a reader waits.
    void db
      .update(propertyLookups)
      .set({ hits: sql`${propertyLookups.hits} + 1` })
      .where(eq(propertyLookups.id, row.id))
      .catch(() => {});

    return {
      result: row.result as T,
      citations: row.citations as { url: string; title: string | null }[],
      fetchedAt: row.fetchedAt,
      ageHours: Math.floor((Date.now() - row.fetchedAt.getTime()) / 3_600_000),
    };
  } catch {
    return null;
  }
}

/** Store an answer, replacing any previous one for the same address. */
export async function putCached(
  query: string,
  result: { found: boolean },
  citations: { url: string; title: string | null }[],
): Promise<void> {
  try {
    const { db, propertyLookups } = await conn();
    await db
      .insert(propertyLookups)
      .values({
        addressKey: normaliseAddress(query),
        queryText: query.trim(),
        result,
        citations,
        found: result.found,
      })
      .onConflictDoUpdate({
        target: propertyLookups.addressKey,
        set: {
          queryText: query.trim(),
          result,
          citations,
          found: result.found,
          fetchedAt: new Date(),
          // Reset, because the count describes this answer's usefulness and a
          // refreshed row is a new answer.
          hits: 0,
        },
      });
  } catch {
    // Writing the cache is best effort. The reader already has their answer.
  }
}
