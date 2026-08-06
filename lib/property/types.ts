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

/**
 * The provider is unusable — bad key, exhausted quota, rate limit.
 *
 * Distinct from "this parcel did not match", and the distinction is not
 * academic. An Arkansas run of 1,442 lots reported 799 skips as
 * "no match from configured providers" when the ATTOM key had actually run out
 * of quota partway through: every lookup after that point returned a 401 that
 * was caught, swallowed, and recorded as a data miss. The result read as
 * "Arkansas parcels don't match ATTOM" — a false conclusion about the data —
 * when the true hit rate was 98.5% and the pipeline had simply stopped working.
 *
 * Anything that throws this must abort the batch rather than let it grind on
 * recording misses that are really outages.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} unavailable (${status}): ${message}`);
    this.name = "ProviderUnavailableError";
  }
}

export interface AssessorLink {
  label: string;
  url: string;
  /** True when the link is a search page (user pastes parcel), not a deep parcel card. */
  searchOnly?: boolean;
}
