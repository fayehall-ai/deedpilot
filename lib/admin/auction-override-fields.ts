/**
 * Which auction fields an operator may correct, and how each value is checked.
 *
 * Split from `auction-overrides.ts` because that module is `server-only` and
 * holds the database writes, which makes it unimportable from a plain test —
 * and this is the half that must be tested. An invalid value here is not a
 * rejected form field: it is stored, then read back inside `upsertAuction`
 * through a Postgres cast, and an out-of-domain value raises *there*, failing
 * that auction's ingest on every future crawl.
 */
import { auctionStatusEnum, listingKindEnum, saleTypeEnum } from "@/lib/db/schema";

/*
 * Read off the pgEnum rather than retyped here.
 *
 * The first draft of this file hand-mirrored the members and got `sale_type`
 * wrong — it listed "Foreclosure" and "Unknown", neither of which exists, while
 * missing "Hybrid". Storing one of those would have raised inside the upsert's
 * `::sale_type` cast and retired that auction from every future crawl. Deriving
 * from the schema makes that class of drift impossible.
 */
export const SALE_TYPES = saleTypeEnum.enumValues;
export const LISTING_KINDS = listingKindEnum.enumValues;
export const AUCTION_STATUSES = auctionStatusEnum.enumValues;

export type OverridableField =
  | "saleDate"
  | "saleDateConfirmed"
  | "listingKind"
  | "saleType"
  | "status"
  | "startTime"
  | "title";

/**
 * What may be corrected, and how each value is checked.
 *
 * Confined to fields whose wrongness reaches a subscriber: the date they drive
 * to, whether that date is trustworthy, whether the document is a sale list at
 * all, and the legal classification the max-bid maths keys off. Enrichment
 * columns are absent on purpose — those are already coalesced and were never at
 * risk from a re-ingest.
 */
export const OVERRIDABLE: Record<OverridableField, (v: unknown) => string | null> = {
  saleDate: (v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`))
      ? null
      : "saleDate must be a real calendar date as YYYY-MM-DD",
  saleDateConfirmed: (v) =>
    typeof v === "boolean" ? null : "saleDateConfirmed must be true or false",
  listingKind: (v) =>
    typeof v === "string" && (LISTING_KINDS as readonly string[]).includes(v)
      ? null
      : `listingKind must be one of: ${LISTING_KINDS.join(", ")}`,
  saleType: (v) =>
    typeof v === "string" && (SALE_TYPES as readonly string[]).includes(v)
      ? null
      : `saleType must be one of: ${SALE_TYPES.join(", ")}`,
  status: (v) =>
    typeof v === "string" && (AUCTION_STATUSES as readonly string[]).includes(v)
      ? null
      : `status must be one of: ${AUCTION_STATUSES.join(", ")}`,
  startTime: (v) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= 40
      ? null
      : "startTime must be short published prose, e.g. '10:00 AM ET'",
  title: (v) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= 200 ? null : "title must be 1-200 characters",
};

export const isOverridable = (field: string): field is OverridableField => field in OVERRIDABLE;

/**
 * Check a whole override map. Returns every problem rather than the first,
 * because an operator fixing a form wants the full list.
 */
export function validateOverrides(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (!isOverridable(field)) {
      errors.push(`${field} is not overridable — allowed: ${Object.keys(OVERRIDABLE).join(", ")}`);
      continue;
    }
    const problem = OVERRIDABLE[field](value);
    if (problem) errors.push(problem);
  }
  return errors;
}
