/*
 * No `server-only` guard, and that is the point of this file existing.
 *
 * These three predicates decide what counts as inventory, and they are needed
 * both by `lib/queries.ts` — which is `server-only` and cached — and by
 * `lib/cape/inputs.ts`, which runs under plain tsx from the producer CLI and
 * therefore cannot import it. Before this module the CAPE selection simply had
 * its own idea of what to include, and the two drifted: the site counted 488
 * upcoming packages while the producer offered 848, because its filter was
 * `lot_count >= 0`, which admits every row ever written.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { auctions } from "./schema";
import { IMPORT_ID_SQL_PATTERN } from "../import/provenance";

/**
 * A sale whose county has stated a parcel count without publishing the parcels.
 *
 * Written by the CSV import. The count is the county's claim, not a number of
 * rows this database holds — see `announced_parcel_count` in the schema.
 */
export const hasAnnouncedCount = () => sql`coalesce(${auctions.announcedParcelCount}, 0) > 0`;

/**
 * Not an empty calendar shell.
 *
 * Was `lot_count > 0` alone. An announced sale has no lots yet and is still
 * not a skeleton: a skeleton is a date with nothing known about it, whereas an
 * announced sale carries a published parcel count and a venue. Hiding those
 * would mean importing a calendar and then not seeing it.
 */
export const hasParcels = () => or(sql`${auctions.lotCount} > 0`, hasAnnouncedCount());

/**
 * Inventory a bidder can act on: parcels from a county's published sale list,
 * or a sale the county has announced with a count.
 *
 * A delinquent roll parses identically to a sale list and is 10-50x larger, so
 * without this filter the honest counts are swamped by parcels that are not for
 * sale. Applied to every headline number and every default listing view; ops
 * surfaces opt out explicitly.
 *
 * The `listing_kind` half is now a disjunction because an imported sale's
 * `listing_kind` is `unknown` and must stay that way — nothing has read a
 * document for it, so claiming `sale_list` would be a lie about provenance.
 * What admits it instead is the announced count, which no delinquent roll has.
 * A projected date is still excluded by `sale_date_confirmed`, which is the
 * half that was actually keeping research leads off the calendar.
 */
export const isConfirmedInventory = () =>
  and(
    or(eq(auctions.listingKind, "sale_list"), hasAnnouncedCount()),
    eq(auctions.saleDateConfirmed, true),
  );

/**
 * An upcoming sale row that says nothing: no parcels held, none announced, not
 * brought in by an import, never touched by an operator.
 *
 * These are what a generic crawl leaves behind when it finds a county page but
 * no list, and purging them keeps the coverage figures honest. Everything
 * else with `lot_count = 0` is somebody's claim that a sale is happening — an
 * announced count, a sale from the calendar import or the Auction Scout, a
 * venue and contact, an operator's correction — and deleting it destroys the
 * enrichment worklist along with the sale, while the county holds the auction
 * regardless. The purges used to test `lot_count = 0` alone, which would have
 * deleted every imported and Scout-added sale in the calendar.
 */
export const isSkeletonAuction = (today: string) =>
  and(
    sql`${auctions.saleDate} >= ${today}`,
    eq(auctions.lotCount, 0),
    sql`coalesce(${auctions.announcedParcelCount}, 0) = 0`,
    sql`${auctions.externalId} NOT LIKE ${IMPORT_ID_SQL_PATTERN}`,
    sql`${auctions.logistics} IS NULL`,
    sql`coalesce(${auctions.operatorOverrides}, '{}'::jsonb) = '{}'::jsonb`,
  );
