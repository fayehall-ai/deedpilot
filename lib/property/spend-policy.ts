import { isLandOnly, type LandOnlyFields } from "../lots/land-only";

/**
 * Whether a parcel is worth a paid RealEstateAPI lookup. Returns the reason it
 * is not, or null when it is.
 *
 * Every lookup is billed whether or not it matches, so the parcels that cannot
 * lead to a purchase are refused before the call rather than after:
 *
 *   - a tax lien sale sells a certificate, not the property — equity and
 *     mortgage figures do not decide a lien bid. Colorado's treasurer deed
 *     auctions (from 1 June 2026) are typed Tax Deed and pass; its annual lien
 *     sales stay typed Tax Lien and do not;
 *   - a sale that was cancelled or delisted will not happen;
 *   - a list that is not a sale list is not inventory: a delinquent roll parses
 *     like a sale list and is 10-50x larger. 3,060 lookups went on Cobb's
 *     delinquent roll and DeKalb's unread list (Oct 2026), parcels no public
 *     page shows. Same test as `isConfirmedInventory` in lib/db/inventory.ts —
 *     a sale list, or a sale the county announced with a parcel count;
 *   - a sale whose date nobody has confirmed may not happen when, or at all,
 *     as filed: 159 lookups went on King County parcels under a 10 October
 *     "sale" that was a crawl date, a month after the real auction;
 *   - a parcel no longer pending — withdrawn, redeemed, cancelled, sold — is
 *     not on offer;
 *   - a land-only parcel is not of interest (see lib/lots/land-only.ts).
 *
 * Free providers — the state assessor layer — are not affected.
 */
export interface SpendFields extends LandOnlyFields {
  saleType: string;
  auctionStatus: string;
  delisted: boolean;
  saleDateConfirmed: boolean;
  listingKind: string;
  announcedParcelCount: number | null;
  lotStatus: string;
}

export function paidLookupRefusal(p: SpendFields): string | null {
  if (p.saleType === "Tax Lien") return "tax lien sale";
  if (p.auctionStatus === "cancelled" || p.delisted) return "sale cancelled";
  if (p.listingKind !== "sale_list" && !((p.announcedParcelCount ?? 0) > 0)) {
    return p.listingKind === "unknown" ? "not known to be a sale list" : `not a sale list (${p.listingKind})`;
  }
  if (!p.saleDateConfirmed) return "sale date not confirmed";
  if (p.lotStatus !== "pending") return `parcel ${p.lotStatus}`;
  if (isLandOnly(p)) return "land-only parcel";
  return null;
}

/** Providers the policy above governs. */
export const GUARDED_PROVIDERS = new Set(["realestateapi"]);
