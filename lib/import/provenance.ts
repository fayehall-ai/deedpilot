/**
 * Which rows came from an uploaded calendar rather than a crawl.
 *
 * `auctions.external_id` carries the id of whatever published the sale, and an
 * imported announcement namespaces its own so it can never collide with an
 * adapter's. That prefix is the only provenance marker the table has, so the
 * test for it lives here rather than being written out at each call site — it
 * is read by the import, by the auction page, and by the ingest reconciler,
 * which are three layers that must agree on what an imported row is.
 *
 * ## Why the ingest layer needs to know
 *
 * `reconcileCountyAuctions` flags a still-future sale as delisted when a crawl
 * of its county does not see it. That inference is sound for a sale the county
 * published and then withdrew, and false for an imported announcement, which
 * the county's page never carried in the first place: the crawl is reading a
 * different source and simply has nothing to say about it.
 *
 * Observed, and the reason this module exists: the first pass of crawls over
 * the imported calendar marked **212 of 570** announcements as delisted — every
 * one of them a sale that is still perfectly real and still scheduled. The
 * column's own comment says it records that "a county publishes an absence".
 * No county published anything here.
 */

/** Namespace for ids minted by the sale-calendar import. */
export const IMPORT_ID_PREFIX = "ustla:";

/** SQL pattern for the same, for statements that cannot call a function. */
export const IMPORT_ID_SQL_PATTERN = `${IMPORT_ID_PREFIX}%`;

/** True when this auction came from a calendar import rather than a crawl. */
export function isImportedExternalId(externalId: string): boolean {
  return externalId.startsWith(IMPORT_ID_PREFIX);
}
