/**
 * The next sale a county has actually announced, for crawlers that would
 * otherwise have to guess one.
 *
 * "Announced" means a row whose date somebody read off the county's own notice
 * — `sale_date_confirmed`, set by the calendar import, the Auction Scout, and
 * crawls whose document named its date — as opposed to a date the atlas
 * projected from a state's typical schedule. A town's own sale is skipped: the
 * county-wide crawl is not crawling Sardis's list.
 */
import { sql } from "drizzle-orm";
import type { SaleType } from "../atlas/types";

export interface ObservedSale {
  saleDate: string;
  saleType: SaleType;
}

export async function observedSale(countyFips: string): Promise<ObservedSale | null> {
  try {
    /* Imported here so the adapters that call this still load without a database. */
    const { db } = await import("../db");
    const rows = (await db.execute(sql`
      SELECT sale_date::text AS sale_date, sale_type::text AS sale_type
        FROM auctions
       WHERE county_fips = ${countyFips}
         AND sale_date >= current_date
         AND sale_date_confirmed
         AND delisted_at IS NULL
         AND coalesce(title, '') !~* '\\m(city|town|township|village|borough)\\s*$'
       ORDER BY sale_date
       LIMIT 1
    `)) as unknown as { sale_date: string; sale_type: SaleType }[];
    return rows[0] ? { saleDate: rows[0].sale_date, saleType: rows[0].sale_type } : null;
  } catch {
    /* A crawl must not fail because the lookup did: the projection still works. */
    return null;
  }
}
