/**
 * The cache key must never merge two real properties.
 * Run: npx tsx lib/property/lookup-cache.test.ts
 *
 * This is the only part of caching worth a test. A key that is too strict costs
 * a wasted search; a key that is too loose serves the valuation of a *different
 * building* to someone deciding what to bid. The asymmetry is the whole design,
 * so the pairs below fix it in place against a future "improvement" that
 * expands abbreviations or folds directions.
 */
import { normaliseAddress, HIT_TTL_DAYS, MISS_TTL_HOURS } from "./lookup-cache";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const same = (a: string, b: string) => normaliseAddress(a) === normaliseAddress(b);

// --- noise that cannot change which building is meant -----------------------

for (const [a, b, why] of [
  ["350 5th Ave, New York, NY 10118", "350 5TH AVE, NEW YORK, NY 10118", "case"],
  ["350 5th Ave, New York", "  350 5th Ave, New York  ", "surrounding whitespace"],
  ["350  5th   Ave", "350 5th Ave", "repeated spaces"],
  ["350 5th Ave, New York.", "350 5th Ave, New York", "trailing punctuation"],
  ["350 5th Ave, New York, NY 10118", "350 5th Ave,  New York, NY 10118. ", "all of the above"],
] as const) {
  assert(same(a, b), `${why} must not create a second entry: "${a}" vs "${b}"`);
}

// --- differences that identify a different property -------------------------

for (const [a, b, why] of [
  ["123 Main St, Dallas TX", "123 Main Ave, Dallas TX", "street type"],
  ["10 S Academy St", "10 N Academy St", "direction"],
  ["123 Main St", "125 Main St", "house number"],
  ["500 Oak Dr, Austin TX", "500 Oak Dr, Austin MN", "state"],
  ["12 Elm St Apt 3", "12 Elm St Apt 4", "unit"],
  ["77 Pine St, Denver CO 80014", "77 Pine St, Denver CO 80202", "ZIP"],
] as const) {
  assert(!same(a, b), `${why} distinguishes two properties and must not be normalised away: "${a}" vs "${b}"`);
}

// --- the asymmetry is deliberate and stated ---------------------------------

/*
 * A miss is frequently a fact about the search rather than about the world — a
 * slow county portal, a rate limit, a page not yet indexed. Holding one as long
 * as a real valuation would make a transient failure look permanent to every
 * later reader.
 */
assert(MISS_TTL_HOURS < HIT_TTL_DAYS * 24, "a miss must expire sooner than a hit");
assert(MISS_TTL_HOURS <= 24, "a miss must not be held for more than a day");

console.log("lookup cache tests ok", { HIT_TTL_DAYS, MISS_TTL_HOURS });
