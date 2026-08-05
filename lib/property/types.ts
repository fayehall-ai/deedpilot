/**
 * Property enrichment — PropStream-style detail layered on top of sale lists.
 *
 * Sale lists often only have parcel # + opening bid. Enrichment fills address,
 * assessed/market value, beds/baths, owner, last sale, etc. so max-bid can
 * fire and the lot card is useful.
 */

export interface PropertyRecord {
  source: string;
  parcelNumber?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  ownerName?: string;
  assessedValue?: number;
  marketValue?: number;
  landValue?: number;
  improvementValue?: number;
  lastSaleAmount?: number;
  lastSaleDate?: string; // YYYY-MM-DD
  beds?: number;
  baths?: number;
  buildingSqft?: number;
  lotSqft?: number;
  acreage?: number;
  yearBuilt?: number;
  landUse?: string;
  propertyType?: string;
  zoning?: string;
  homestead?: boolean;
  latitude?: number;
  longitude?: number;
  raw?: Record<string, unknown>;
}

export interface EnrichInput {
  state: string;
  fips: string;
  countyName: string;
  parcelNumber?: string | null;
  addressLine?: string | null;
  city?: string | null;
  zip?: string | null;
}

export interface PropertyProvider {
  name: string;
  configured(): boolean;
  lookup(input: EnrichInput): Promise<PropertyRecord | null>;
}

export interface AssessorLink {
  label: string;
  url: string;
  /** True when the link is a search page (user pastes parcel), not a deep parcel card. */
  searchOnly?: boolean;
}
