import { sql } from "drizzle-orm";
import { lots } from "../db/schema";

/**
 * Land-only parcels — vacant lots with no structure — are not of interest, so
 * the parcel table and the PropStream export leave them out by default.
 *
 * Almost no source says so outright (a few hundred of ~196k upcoming parcels
 * carry a land-use tag), so the rule leans on how counties list vacant land:
 *
 *   - no situs address at all — a parcel with no building has nothing to number;
 *   - a house number of zero, "0 MAIN ST" — the assessor's placeholder for a lot
 *     on a street with no structure on it;
 *   - a street name with no house number at all, "MAIN ST" — same meaning;
 *   - a land-use tag that says vacant or unimproved.
 *
 * Any sign of a building (square footage or a year built) overrides all of these:
 * that is direct evidence, the address rules are inference.
 *
 * `isLandOnly` and `landOnlySql` are the same rule twice — one for tests and
 * in-memory rows, one so the filter runs before the query's row limit rather
 * than after it. Change them together.
 */

const VACANT_USE = /vacant|unimpr|land only/i;
const ZERO_HOUSE_NUMBER = /^0+\s/;
const HOUSE_NUMBER = /^\d/;

export interface LandOnlyFields {
  addressLine: string | null;
  landUse: string | null;
  buildingSqft: number | null;
  yearBuilt: number | null;
}

export function isLandOnly(l: LandOnlyFields): boolean {
  if ((l.buildingSqft ?? 0) > 0 || (l.yearBuilt ?? 0) > 0) return false;
  if (l.landUse && VACANT_USE.test(l.landUse)) return true;
  const addr = l.addressLine?.trim() ?? "";
  return addr === "" || !HOUSE_NUMBER.test(addr) || ZERO_HOUSE_NUMBER.test(addr);
}

export const landOnlySql = sql<boolean>`(
  coalesce(${lots.buildingSqft}, 0) <= 0
  and coalesce(${lots.yearBuilt}, 0) <= 0
  and (
    coalesce(${lots.landUse}, '') ~* 'vacant|unimpr|land only'
    or coalesce(btrim(${lots.addressLine}), '') = ''
    or btrim(${lots.addressLine}) !~ '^[0-9]'
    or btrim(${lots.addressLine}) ~ '^0+\\s'
  )
)`;
