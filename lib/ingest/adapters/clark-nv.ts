/**
 * Lightweight custom adapter for Clark County, NV (Las Vegas).
 * Targets the Treasurer's auction portal.
 */
import { politeFetch } from '../fetch';
import type { DiscoveredLot, DiscoveredAuction, SourceAdapter, CountyBinding } from '../types';
import { getCounty } from '../../atlas';

/** The Treasurer's auction portal, used when the binding carries no override. */
const PORTAL_URL = "https://treasurer.clarkcountynv.gov/auction";

/**
 * Stand-in date until the Treasurer publishes one.
 *
 * Paired with `saleDateConfirmed: false`, which is what actually keeps it out
 * of inventory — a date this system invented must never look like one a county
 * announced.
 */
const FALLBACK_SALE_DATE = "2026-11-01";

/** Trim to a non-empty string, or undefined. */
function text(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s || undefined;
}

/** A finite, non-negative number, or undefined. Zero is a real bid amount. */
function numeric(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const clarkNvAdapter: SourceAdapter = {
  name: 'clark-nv',
  platform: 'county_site',
  description: 'Clark County NV Treasurer auction portal. Scrapes Kendo grid results from the live site.',

  async discoverCounties(): Promise<CountyBinding[]> {
    return [{
      countyFips: "32003",
      config: { sourceUrl: "https://treasurer.clarkcountynv.gov/auction" },
    }];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const countyFips = binding.countyFips;
    const county = getCounty(countyFips);
    if (!county || county.state !== 'NV' || !county.name.toLowerCase().includes('clark')) {
      return [];
    }
    const configured = binding.config.sourceUrl;
    return [{
      countyFips,
      platform: "county_site",
      // `SaleType` is the display form. Nevada sells deeds under NRS 361.595.
      saleType: "Tax Deed",
      externalId: "clark-nv-portal",
      saleDate: FALLBACK_SALE_DATE,
      /*
       * The date is a placeholder, not something the Treasurer published, so
       * this stays false and the parcels stay out of inventory. See the note on
       * `listingKind` below — the two flags travel together.
       */
      saleDateConfirmed: false,
      sourceUrl: typeof configured === "string" && configured ? configured : PORTAL_URL,
      /*
       * `unknown`, not `sale_list`. There is no such kind as "portal", and the
       * choice is not cosmetic: `sale_list` plus a confirmed date is the pair
       * that makes parcels count as biddable inventory everywhere on the site.
       * What `listLots` actually reads is a completed-auction results grid, so
       * calling it a sale list would put finished sales under a made-up future
       * date into the calendar and the max-bid engine.
       */
      listingKind: "unknown",
    }];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const url = auction.sourceUrl || PORTAL_URL;
    try {
      // TODO: auctionId is pinned to 21. It will need discovering from the
      // portal before this adapter can follow Clark County forward a sale.
      const resultsUrl = `${PORTAL_URL}/Auction/WinningBid_Read?auctionId=21`;
      const res = await politeFetch(resultsUrl);
      const data: unknown = JSON.parse(res.body);
      const grid = data as { Data?: unknown };
      if (Array.isArray(grid.Data)) {
        /*
         * Mapped onto `DiscoveredLot`'s own field names. The first version
         * emitted `address`, `minBid` and `winningBid`, none of which exist on
         * that interface — and because `.map((row: any) => ...)` returns `any`,
         * the object literal was never checked against it. Every one of those
         * three would have been silently dropped on write, so the adapter would
         * have looked like it worked and stored parcel numbers alone.
         */
        return (grid.Data as Record<string, unknown>[])
          .map((row): DiscoveredLot => {
            const winning = numeric(row.WinningBidAmount);
            return {
              parcelNumber: text(row.ParcelNumber) ?? text(row.ShowParcelNumber),
              addressLine: text(row.PropertyLocation),
              openingBid: numeric(row.MinBidAmount),
              soldAmount: winning,
              // A row in a winning-bid grid is a completed sale, not a pending one.
              status: winning !== undefined ? "sold" : undefined,
              sourceUrl: url,
              raw: row,
            };
          })
          .filter((l) => Boolean(l.parcelNumber));
      }
    } catch (e) {
      console.warn("[clark-nv] results grid fetch failed:", e);
    }
    return [];
  },
};

export default clarkNvAdapter;
