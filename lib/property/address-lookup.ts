/**
 * The home-page "Look up address" search, answered from RealEstateAPI.
 *
 * The web search it replaces as the first answer took twenty seconds and more,
 * read figures off whatever pages turned up, and priced a property from a
 * listing site's estimate. This asks RealEstateAPI's PropertyDetail — the
 * county assessor record plus their valuation model — in about a second, and
 * falls back to the web search only when it has no record (see
 * app/lookup-action.ts).
 *
 * The result is shaped as the `SearchedProperty` the page already renders, so
 * both sources draw the same card; `ReapiExtras` carries what only a record has.
 */
import type { SearchedProperty } from "./providers/websearch";
import { detailByAddress, mapRecord } from "./providers/realestateapi";
export { AmbiguousAddressError } from "./providers/realestateapi";

/** What a bidder reads that a web search never reliably had. */
export interface ReapiExtras {
  assessedValue: number | null;
  estimatedEquity: number | null;
  equityPercent: number | null;
  openMortgageBalance: number | null;
  ownerOccupied: boolean | null;
  absenteeOwner: boolean | null;
  taxDelinquentYear: string | null;
  apn: string | null;
  county: string | null;
}

export interface ReapiLookup {
  data: SearchedProperty;
  extras: ReapiExtras;
  location?: { lat: number; lon: number; matched: string };
  /** The whole PropertyDetail payload, so the lookup can draw the parcel page's card. */
  raw: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Flags worth a chip on the card, in the words a buyer uses. */
function features(d: Record<string, unknown>): string[] {
  const p = obj(d.propertyInfo);
  const out: string[] = [];
  if (p.garage || num(p.garageSquareFeet)) out.push("Garage");
  if (p.pool) out.push("Pool");
  if (p.fireplace) out.push("Fireplace");
  if (str(p.airConditioningType)) out.push(`${str(p.airConditioningType)} air`);
  if (str(p.basementType) && !/no basement/i.test(String(p.basementType))) out.push("Basement");
  if (p.hoa || d.hoa) out.push("HOA");
  if (num(p.stories)) out.push(`${num(p.stories)} stories`);
  if (d.vacant) out.push("Vacant");
  if (d.foreclosure || d.preForeclosure) out.push("Foreclosure on record");
  return out;
}

export async function reapiLookup(query: string): Promise<ReapiLookup | null> {
  const raw = await detailByAddress(query);
  if (!raw) return null;
  const rec = mapRecord(raw);
  const addr = obj(obj(raw.propertyInfo).address);
  const owner = obj(raw.ownerInfo);
  const tax = obj(raw.taxInfo);
  const retrieved = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const data: SearchedProperty = {
    found: true,
    marketValue: rec.marketValue ?? null,
    addressLine: rec.addressLine ?? str(addr.address),
    city: rec.city ?? null,
    zip: rec.zip ?? null,
    ownerName: rec.ownerName ?? null,
    beds: rec.beds ?? null,
    baths: rec.baths ?? null,
    buildingSqft: rec.buildingSqft ?? null,
    lotSqft: rec.lotSqft ?? null,
    yearBuilt: rec.yearBuilt ?? null,
    // "Single Family Residence", not the "SFR" code.
    propertyType: str(obj(raw.lotInfo).propertyUse) ?? str(obj(raw.propertyInfo).propertyUse) ?? rec.propertyType ?? null,
    lastSaleAmount: rec.lastSaleAmount ?? null,
    lastSaleDate: rec.lastSaleDate ?? null,
    confidence: rec.marketValue ? "stated" : "none",
    closestMatch: null,
    features: features(raw),
    neighborhood: str(obj(raw.neighborhood).name),
    /*
     * Only a live listing. `mlsStatus` is the last listing's status whatever
     * its age — "Closed" on 2201 Crossrail Dr is a 2025 rental — and read as
     * the property's status it misleads.
     */
    status: raw.mlsPending ? "Sale pending" : raw.mlsActive || raw.forSale ? "Listed for sale" : null,
    estimateLow: null,
    estimateHigh: null,
    comparables: null,
    basis:
      `County assessor record and RealEstateAPI's valuation model for ${str(addr.label) ?? query}, ` +
      `retrieved ${retrieved}.`,
    sources: [],
  };

  const extras: ReapiExtras = {
    assessedValue: num(tax.assessedValue),
    estimatedEquity: num(raw.estimatedEquity),
    equityPercent: num(raw.equityPercent),
    openMortgageBalance: num(raw.estimatedMortgageBalance) ?? num(raw.openMortgageBalance),
    ownerOccupied: bool(owner.ownerOccupied) ?? bool(raw.ownerOccupied),
    absenteeOwner: bool(owner.absenteeOwner) ?? bool(raw.absenteeOwner),
    taxDelinquentYear: str(tax.taxDelinquentYear),
    apn: rec.parcelNumber ?? null,
    county: rec.county ?? null,
  };

  const lat = rec.latitude;
  const lon = rec.longitude;
  return {
    data,
    extras,
    raw,
    location:
      lat !== undefined && lon !== undefined
        ? { lat, lon, matched: str(addr.label) ?? query }
        : undefined,
  };
}
