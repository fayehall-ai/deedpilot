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

  listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]>;
}
