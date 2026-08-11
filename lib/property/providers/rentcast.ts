/**
 * RentCast property records + AVM.
 * Docs: https://developers.rentcast.io/
 *
 * Needs address (street + city/state or zip). Parcel-only lots cannot use this
 * until we have an address from another source.
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";
import { fetchWithBackoff } from "../retry";

const BASE = "https://api.rentcast.io/v1";

export const rentcastProvider: PropertyProvider = {
  name: "rentcast",

  configured() {
    return (process.env.RENTCAST_API_KEY ?? "").trim().length > 0;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const key = (process.env.RENTCAST_API_KEY ?? "").trim();
    if (!key) return null;

    const address = buildAddress(input);
    if (!address) return null;

    const qs = new URLSearchParams({ address });
    const propRes = await fetchWithBackoff(
      `${BASE}/properties?${qs}`,
      { headers: { "X-Api-Key": key, Accept: "application/json" } },
      { provider: "rentcast" },
    );
    if (!propRes.ok) {
      const err = await propRes.text();
      if (propRes.status === 403 && /subscription-inactive|billing/i.test(err)) {
        throw new Error(
          "rentcast: API subscription inactive — activate at https://app.rentcast.io/app/api",
        );
      }
      throw new Error(`rentcast properties ${propRes.status}: ${err.slice(0, 200)}`);
    }
    const props = (await propRes.json()) as Record<string, unknown>[] | Record<string, unknown>;
    const p = Array.isArray(props) ? props[0] : props;
    if (!p || typeof p !== "object") return null;

    // Optional AVM for market estimate
    let marketValue: number | undefined;
    try {
      const avmRes = await fetchWithBackoff(
        `${BASE}/avm/value?${qs}`,
        { headers: { "X-Api-Key": key, Accept: "application/json" } },
        { provider: "rentcast" },
      );
      if (avmRes.ok) {
        const avm = (await avmRes.json()) as { price?: number; value?: number };
        marketValue = num(avm.price ?? avm.value);
      }
    } catch {
      /* AVM optional */
    }

    return {
      source: "rentcast",
      addressLine: str(p.formattedAddress) ?? str(p.addressLine1) ?? input.addressLine ?? undefined,
      city: str(p.city) ?? input.city ?? undefined,
      state: str(p.state) ?? input.state,
      zip: str(p.zipCode) ?? input.zip ?? undefined,
      county: str(p.county) ?? input.countyName,
      ownerName: str(p.ownerName) ?? str((p.owner as { names?: string[] })?.names?.[0]),
      // Tax assessments only. An AVM must never land here.
      //
      // maxbid derives ARV as `assessedValue / assessmentRatio`, so a market
      // estimate in this field gets divided by the ratio a second time: a
      // $144,000 AVM on a Louisiana parcel (10% ratio) implies a $1.44M
      // property. The old fallback did exactly that "so max-bid can still
      // fire", which is the wrong trade — a walk-away price ten times too high
      // is the single output that can cost a subscriber money at auction.
      //
      // The AVM is still returned as `marketValue` and stored in
      // lot_valuations. Surfacing it as a suggested ARV is a product decision
      // for the `arvOverride` path, not something to smuggle in here.
      assessedValue: num(p.assessedValue) ?? num(p.taxAssessedValue),
      marketValue: marketValue ?? num(p.price) ?? num(p.lastSalePrice),
      lastSaleAmount: num(p.lastSalePrice),
      lastSaleDate: dateStr(p.lastSaleDate),
      beds: num(p.bedrooms),
      baths: num(p.bathrooms),
      buildingSqft: num(p.squareFootage),
      lotSqft: num(p.lotSize),
      acreage: num(p.lotSize) ? num(p.lotSize)! / 43560 : undefined,
      yearBuilt: num(p.yearBuilt),
      propertyType: str(p.propertyType),
      latitude: num(p.latitude),
      longitude: num(p.longitude),
      raw: p as Record<string, unknown>,
    };
  },
};

function buildAddress(input: EnrichInput): string | null {
  if (!input.addressLine?.trim()) return null;
  const parts = [
    input.addressLine.trim(),
    input.city?.trim(),
    input.state,
    input.zip?.trim(),
  ].filter(Boolean);
  // Need at least street + state
  if (parts.length < 2) return null;
  return parts.join(", ");
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,$]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function dateStr(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v.slice(0, 10);
  return d.toISOString().slice(0, 10);
}
