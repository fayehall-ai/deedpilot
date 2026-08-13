/**
 * Operator corrections to an auction, and the validation that keeps them safe.
 *
 * ## Why this exists
 *
 * `upsertAuction` sets `saleDate`, `saleDateConfirmed`, `listingKind`,
 * `saleType`, `status` and the rest from `excluded.*` on every crawl. That is
 * correct — the county is authoritative — but it means a hand-corrected sale
 * date is reverted by the next run. An edit form without this tier is worse
 * than no edit form: it looks like it worked and quietly undoes itself
 * overnight, which is the failure mode an operator would never think to check.
 *
 * ## Why validation is strict rather than convenient
 *
 * Overrides are applied inside the upsert through a Postgres cast —
 * `(operator_overrides->>'saleType')::sale_type`. A value outside the enum does
 * not degrade gracefully; it raises, and it raises *inside the upsert*, so that
 * auction would fail to ingest on every future crawl with an error naming a
 * cast rather than a bad override. One careless write would silently retire a
 * county's sale from the pipeline.
 *
 * So every value is checked against the column's own domain here, before it can
 * reach the database. `OVERRIDABLE` is an allow-list, not a convention.
 */

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions } from "@/lib/db/schema";

export * from "./auction-override-fields";
// Imported as well as re-exported: `setOverrides` validates before writing.
import { validateOverrides } from "./auction-override-fields";

export class InvalidOverrideError extends Error {}

/**
 * Merge corrections into an auction.
 *
 * A patch value of `null` clears that one field back to the source, so reverting
 * a single correction never means retyping the others.
 */
export async function setOverrides(
  auctionId: string,
  patch: Record<string, unknown>,
  editedBy = "admin",
): Promise<Record<string, unknown>> {
  const toWrite = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const errors = validateOverrides(toWrite);
  if (errors.length) throw new InvalidOverrideError(errors.join("; "));

  const [row] = await db
    .select({ current: auctions.operatorOverrides })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  if (!row) throw new InvalidOverrideError(`no auction ${auctionId}`);

  const merged: Record<string, unknown> = { ...(row.current ?? {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete merged[field];
    else merged[field] = value;
  }

  const empty = Object.keys(merged).length === 0;
  await db
    .update(auctions)
    .set({
      // An empty map is stored as NULL rather than `{}`, so "has corrections"
      // is a single null check everywhere downstream.
      operatorOverrides: empty ? null : merged,
      editedBy: empty ? null : editedBy,
      editedAt: empty ? null : new Date(),
    })
    .where(eq(auctions.id, auctionId));

  return merged;
}

/** Drop every correction on an auction, reverting it wholly to the county. */
export async function clearOverrides(auctionId: string): Promise<void> {
  await db
    .update(auctions)
    .set({ operatorOverrides: null, editedBy: null, editedAt: null })
    .where(eq(auctions.id, auctionId));
}

export interface OverriddenAuction {
  id: string;
  countyFips: string;
  saleDate: string;
  overrides: Record<string, unknown>;
  editedBy: string | null;
  editedAt: Date | null;
}

/** Every auction currently carrying a correction, for the console. */
export async function listOverriddenAuctions(limit = 50): Promise<OverriddenAuction[]> {
  const rows = await db
    .select({
      id: auctions.id,
      countyFips: auctions.countyFips,
      saleDate: auctions.saleDate,
      overrides: auctions.operatorOverrides,
      editedBy: auctions.editedBy,
      editedAt: auctions.editedAt,
    })
    .from(auctions)
    .where(and(sql`${auctions.operatorOverrides} is not null`))
    .orderBy(auctions.editedAt)
    .limit(limit);

  return rows.map((r) => ({ ...r, overrides: r.overrides ?? {} }));
}
