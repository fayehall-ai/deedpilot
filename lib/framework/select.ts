/**
 * Which sales get a framework, and each one built.
 *
 * Shared by the terminal (`npm run framework`), the live `/frameworks` page and
 * the weekly Drive delivery, so all three agree on the window and the rules.
 *
 * ## The window: a week out, eight weeks wide
 *
 * A framework is a research instrument, and research needs time: a document for
 * a sale three days away cannot change what anybody does — the title search
 * will not come back, the deposit is already late. Seven days is the floor CAPE
 * uses for the same reason. The far end goes stale: a county can move a date or
 * pull a list, and a framework written today for a sale in March asserts things
 * nobody has checked. Eight weeks is a season, near enough to be current.
 *
 * One per county unless `every`: the next sale is the one anybody is preparing
 * for, and a county running monthly would otherwise produce near-identical
 * documents whose only difference is the date.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getCounty } from "../atlas";
import type { County } from "../atlas/types";
import { buildFramework, type Framework, type FrameworkAuction } from "./content";

export const LEAD_DAYS = 7;
export const WEEKS = 8;

export interface FrameworkSale {
  fips: string;
  county: County;
  saleDate: string;
  /** Parcels held, or announced where none are held yet — the delivery ranking. */
  parcels: number;
  framework: Framework;
  /** `Duval_County_FL_Framework_2026-10-14`, the name the documents have always had. */
  fileBase: string;
}

export function frameworkFileBase(county: County, saleDate: string): string {
  return `${county.name.replace(/[^A-Za-z0-9]+/g, "_")}_County_${county.state}_Framework_${saleDate}`;
}

export async function frameworkSales(opts: {
  fips?: string;
  state?: string;
  /** A named date is an instruction, not a suggestion: the window does not apply. */
  date?: string;
  every?: boolean;
  lead?: number;
  weeks?: number;
  onSkip?: (fips: string, why: string) => void;
} = {}): Promise<FrameworkSale[]> {
  const lead = opts.lead ?? LEAD_DAYS;
  const weeks = opts.weeks ?? WEEKS;
  const rows = (await db.execute(sql`
    select a.county_fips fips, a.sale_date::text d, a.sale_type, a.platform, a.start_time,
           a.source_url, a.logistics, a.announced_parcel_count ann, a.sale_date_confirmed conf,
           (select count(*) from lots l where l.auction_id = a.id)::int lots
    from auctions a
    join counties c on c.fips = a.county_fips
    where a.delisted_at is null
      ${opts.date
        ? sql`and a.sale_date = ${opts.date}::date`
        /* Cast the bounds: `current_date + $1` on an untyped bind is ambiguous to Postgres. */
        : sql`and a.sale_date >= current_date + (${lead})::int
              and a.sale_date <= current_date + (${lead + weeks * 7})::int`}
      ${opts.fips ? sql`and a.county_fips = ${opts.fips}` : sql``}
      ${opts.state ? sql`and c.state = ${opts.state}` : sql``}
    order by a.sale_date
  `)) as unknown as {
    fips: string; d: string; sale_type: string; platform: string; start_time: string | null;
    source_url: string; logistics: FrameworkAuction["logistics"]; ann: number | null; conf: boolean; lots: number;
  }[];

  const chosen = opts.every ? rows : [...new Map(rows.map((r) => [r.fips, r])).values()];
  const out: FrameworkSale[] = [];
  for (const r of chosen) {
    const county = getCounty(r.fips);
    if (!county) {
      opts.onSkip?.(r.fips, "not a county");
      continue;
    }
    try {
      const auction: FrameworkAuction = {
        saleDate: r.d, saleType: r.sale_type, platform: r.platform, startTime: r.start_time,
        sourceUrl: r.source_url, logistics: r.logistics, lotCount: r.lots,
        announced: r.ann, saleDateConfirmed: r.conf,
      } as FrameworkAuction;
      out.push({
        fips: r.fips,
        county,
        saleDate: r.d,
        parcels: Math.max(r.lots, r.ann ?? 0),
        framework: buildFramework(r.fips, auction),
        fileBase: frameworkFileBase(county, r.d),
      });
    } catch (e) {
      /* One county's missing rule must not cost the others. */
      opts.onSkip?.(r.fips, (e as Error).message);
    }
  }
  return out;
}
