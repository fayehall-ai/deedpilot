/**
 * The contract every ingestion source implements.
 *
 * Three stages, deliberately separable so a failure in one county or one
 * auction never takes down a whole run:
 *
 *   discoverCounties() -> which counties this source serves, and their config
 *   listAuctions(binding) -> upcoming sales for one county
 *   listLots(auction) -> parcels in one sale
 */

import type { SaleType } from "../atlas/types";

export type Platform =
  | "realtaxdeed"
  | "realforeclose"
  | "govease"
  | "bid4assets"
  | "zeus"
  | "lienhub"
  | "grantstreet"
  | "taxsaleinfo"
  | "mvba"
  | "lgbs"
  | "county_site"
  | "in_person";

export type AuctionStatus = "scheduled" | "live" | "closed" | "cancelled" | "postponed";

/**
 * Which published document the parcels came from.
 *
 * Only `sale_list` is inventory. See `listingKindEnum` in the schema for why
 * this is tracked rather than assumed.
 */
export type ListingKind = "sale_list" | "delinquent_list" | "lands_available" | "unknown";
export type LotStatus =
  | "pending"
  | "sold"
  | "redeemed"
  | "cancelled"
  | "struck"
  | "withdrawn";

/** A county this adapter can serve, plus whatever config it needs to do so. */
export interface CountyBinding {
  countyFips: string;
  /** Adapter-specific: subdomain, portal URL, internal county id, etc. */
  config: Record<string, unknown>;
}

export interface DiscoveredAuction {
  countyFips: string;
  platform: Platform;
  saleType: SaleType;
  /** Stable id from the source. Half of the dedupe key with county+platform. */
  externalId: string;
  /** ISO date, YYYY-MM-DD. */
  saleDate: string;
  /**
   * True only if the county published this date. Adapters that read a date off
   * the source say so; adapters that take one from the sale calendar must not.
   * Omitted means unconfirmed — the safe reading.
   */
  saleDateConfirmed?: boolean;
  /**
   * Which document the lots come from. Adapters pinned to a known sale list say
   * `sale_list`; the registry-driven crawler reports what it actually opened.
   */
  listingKind?: ListingKind;
  startTime?: string;
  title?: string;
  status?: AuctionStatus;
  sourceUrl: string;
  registrationDeadline?: Date;
  depositDeadline?: Date;
  raw?: Record<string, unknown>;
}

export interface DiscoveredLot {
  externalId?: string;
  lotNumber?: string;
  parcelNumber?: string;
  caseNumber?: string;
  addressLine?: string;
  city?: string;
  zip?: string;
  legalDescription?: string;
  latitude?: number;
  longitude?: number;
  openingBid?: number;
  assessedValue?: number;
  taxesOwed?: number;
  landUse?: string;
  acreage?: number;
  buildingSqft?: number;
  yearBuilt?: number;
  ownerName?: string;
  status?: LotStatus;
  soldAmount?: number;
  sourceUrl?: string;
  raw?: Record<string, unknown>;
}

/**
 * Per-parcel detail fetched in a second pass, after the catalog listing.
 *
 * Separated from `DiscoveredLot` because it costs one request per lot: a
 * catalog page yields ~90 lots in a single fetch, while enrichment is 90
 * fetches. Worth it, but not something to run on every calendar refresh.
 */
export interface LotEnrichment {
  parcelNumber?: string;
  /** Assessor's value. Interpret against the state's assessment ratio. */
  assessedValue?: number;
  /** How stale the assessed figure is, in the source's own words. */
  assessedValueNote?: string;
  taxesOwed?: number;
  addressLine?: string;
  city?: string;
  legalDescription?: string;
  latitude?: number;
  longitude?: number;
  raw?: Record<string, unknown>;
}

export interface SourceAdapter {
  /** Stable identifier used in ingest_runs.adapter and in logs. */
  name: string;
  platform: Platform;
  /** Human-readable note on what this source is and where its data comes from. */
  description: string;

  /**
   * Which counties this adapter serves. Adapters that cover a fixed list can
   * return it directly; adapters over a national platform should query it.
   */
  discoverCounties(): Promise<CountyBinding[]>;

  listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]>;

  /**
   * Parcels in one sale.
   *
   * May refine `auction.listingKind` and `auction.saleDateConfirmed` in place:
   * which document a county actually serves is often only knowable after
   * fetching it, and the runner persists the auction *after* this resolves.
   * Refining upward (unknown → sale_list) requires evidence from the source;
   * silence leaves the conservative value set by `listAuctions`.
   */
  listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]>;

  /**
   * Fetch per-parcel detail the catalog omits. Optional: sources that publish
   * everything up front don't need it.
   *
   * `sourceKey` identifies the row in `lot_valuations`, so a re-run updates in
   * place rather than accumulating duplicates.
   */
  enrichLot?(lot: { externalId: string | null; sourceUrl: string | null }): Promise<LotEnrichment | null>;
  /** Stable identifier for this adapter's valuation rows. */
  valuationSource?: string;
}
