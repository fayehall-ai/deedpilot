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
  lotStatus: string;
}

export function paidLookupRefusal(p: SpendFields): string | null {
  if (p.saleType === "Tax Lien") return "tax lien sale";
  if (p.auctionStatus === "cancelled" || p.delisted) return "sale cancelled";
  if (p.lotStatus !== "pending") return `parcel ${p.lotStatus}`;
  if (isLandOnly(p)) return "land-only parcel";
  return null;
}

/** Providers the policy above governs. */
export const GUARDED_PROVIDERS = new Set(["realestateapi"]);
