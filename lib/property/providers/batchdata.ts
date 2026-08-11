/**
 * BatchData property API — address (and, when plan supports it, APN) lookup.
 * Docs: https://developer.batchdata.com/
 *
 * Env: BATCHDATA_API_KEY
 *
 * Observed live behavior (funded starter balance):
 * - POST /api/v1/property/lookup/all-attributes with nested `address` works
 * - Response often includes address, ids.apn, owner (not always assessment)
 * - Raw `apn`+`fips` requests currently return no match on many FL parcels
 *
 * Auth: Authorization: Bearer <token>
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";
import { fetchWithBackoff } from "../retry";

const BASE = "https://api.batchdata.com/api/v1";

export const batchdataProvider: PropertyProvider = {
  name: "batchdata",

  configured() {
    return (process.env.BATCHDATA_API_KEY ?? "").trim().length > 0;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const key = (process.env.BATCHDATA_API_KEY ?? "").trim();
    if (!key) return null;

    // Address path is the reliable match on current plans.
    if (input.addressLine?.trim()) {
      const rec = await lookupByAddress(key, input);
      if (rec) return rec;
    }

    // APN path — try when present (may no-match depending on plan/format).
    if (input.parcelNumber?.trim() && input.fips) {
      const rec = await lookupByApn(key, input);
      if (rec) return rec;
    }

    // Last resort: free-text search, then require APN match if we had one.
    if (input.parcelNumber?.trim() || input.addressLine?.trim()) {
      return searchAndMatch(key, input);
    }

    return null;
  },
};

async function lookupByAddress(
  key: string,
  input: EnrichInput,
): Promise<PropertyRecord | null> {
  const data = await postJson(key, `${BASE}/property/lookup/all-attributes`, {
    requests: [
      {
        address: {
          street: input.addressLine!.trim(),
          city: input.city?.trim() || undefined,
          state: input.state,
          zip: input.zip?.trim() || undefined,
        },
      },
    ],
  });
  const prop = firstProperty(data);
  return prop ? mapProperty(prop, input) : null;
}

async function lookupByApn(
  key: string,
  input: EnrichInput,
): Promise<PropertyRecord | null> {
  const apn = input.parcelNumber!.trim();
  const fips = input.fips;
  const requests = [
    { apn, fips, fipsCode: fips },
    { address: { apn, countyFipsCode: fips, state: input.state } },
  ];
  for (const req of requests) {
    const data = await postJson(key, `${BASE}/property/lookup/all-attributes`, {
      requests: [req],
    });
    const prop = firstProperty(data);
    if (prop) return mapProperty(prop, input);
  }
  return null;
}

async function searchAndMatch(
  key: string,
  input: EnrichInput,
): Promise<PropertyRecord | null> {
  const query = [
    input.addressLine?.trim(),
    input.parcelNumber?.trim(),
    input.countyName,
    input.state,
    input.zip?.trim(),
  ]
    .filter(Boolean)
    .join(" ");
  if (!query) return null;

  const data = await postJson(key, `${BASE}/property/search`, {
    searchCriteria: { query },
    take: 10,
  });
  const props = allProperties(data);
  if (!props.length) return null;

  const wantApn = (input.parcelNumber ?? "").replace(/[-.\s]/g, "").toUpperCase();
  if (wantApn) {
    const hit = props.find((p) => {
      const ids = (p.ids ?? {}) as Record<string, unknown>;
      const apn = String(ids.apn ?? p.apn ?? "")
        .replace(/[-.\s]/g, "")
        .toUpperCase();
      return apn === wantApn;
    });
    if (hit) return mapProperty(hit, input);
    return null; // never attach a random search hit
  }

  // Address-only search: take first
  return mapProperty(props[0], input);
}

async function postJson(
  key: string,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const res = await fetchWithBackoff(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    { provider: "batchdata" },
  );

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (!res.ok) throw new Error(`batchdata ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const status = (data.status ?? {}) as { code?: number; message?: string; text?: string };
  const msg = `${status.message ?? status.text ?? ""}`.toLowerCase();

  if (res.status === 404) return null;

  if (res.status === 401 || res.status === 403) {
    if (msg.includes("insufficient balance") || msg.includes("balance")) {
      throw new Error(
        "batchdata: insufficient balance — add credits at https://app.batchdata.com/",
      );
    }
    throw new Error(`batchdata ${res.status}: ${status.message ?? status.text ?? text.slice(0, 200)}`);
  }

  if (!res.ok && status.code !== 200) {
    throw new Error(`batchdata ${res.status}: ${status.message ?? text.slice(0, 200)}`);
  }

  return data;
}

function allProperties(data: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!data) return [];
  const results = data.results;
  if (results && typeof results === "object") {
    const r = results as Record<string, unknown>;
    if (Array.isArray(r.properties)) return r.properties as Record<string, unknown>[];
    if (Array.isArray(r.results)) return r.results as Record<string, unknown>[];
  }
  if (Array.isArray(data.properties)) return data.properties as Record<string, unknown>[];
  if (Array.isArray(data.results)) return data.results as Record<string, unknown>[];
  return [];
}

function firstProperty(data: Record<string, unknown> | null): Record<string, unknown> | null {
  return allProperties(data)[0] ?? null;
}

function mapProperty(p: Record<string, unknown>, input: EnrichInput): PropertyRecord {
  const addr =
    ((p.address ?? p.propertyAddress) as Record<string, unknown> | undefined) ?? {};
  const assessment =
    ((p.assessment ?? p.taxAssessment ?? p.tax) as Record<string, unknown> | undefined) ?? {};
  const owner = ((p.owner ?? p.ownership) as Record<string, unknown> | undefined) ?? {};
  const building =
    ((p.building ?? p.structure ?? p.general) as Record<string, unknown> | undefined) ?? {};
  const lot = ((p.lot ?? p.lotInfo) as Record<string, unknown> | undefined) ?? {};
  const saleRaw = p.sale ?? p.lastSale ?? p.saleHistory;
  const saleObj = (
    Array.isArray(saleRaw) ? saleRaw[0] : saleRaw
  ) as Record<string, unknown> | undefined;
  const ids = ((p.ids ?? p.identifier) as Record<string, unknown> | undefined) ?? {};
  const valuation = ((p.valuation ?? p.avm) as Record<string, unknown> | undefined) ?? {};

  const street =
    str(addr.street) ??
    str(addr.line1) ??
    str(addr.address) ??
    cleanOneLine(str(addr.oneLine));

  const assessed =
    num(assessment.totalAssessedValue) ??
    num(assessment.assessedValue) ??
    num(assessment.assessedTotal) ??
    num(p.assessedValue) ??
    num(p.totalAssessedValue);

  const market =
    num(valuation.estimatedValue) ??
    num(valuation.value) ??
    num(p.estimatedValue) ??
    num(p.marketValue) ??
    num(p.avm);

  // Owner: prefer fullName, else join names[].full
  let ownerName = str(owner.fullName) ?? str(owner.name) ?? str(p.ownerName);
  if (!ownerName && Array.isArray(owner.names)) {
    const parts = (owner.names as Array<Record<string, unknown>>)
      .map((n) => str(n.full) ?? [str(n.first), str(n.last)].filter(Boolean).join(" "))
      .filter(Boolean);
    if (parts.length) ownerName = parts.join("; ");
  }

  return {
    source: "batchdata",
    parcelNumber: str(ids.apn) ?? str(p.apn) ?? str(p.parcelNumber) ?? undefined,
    addressLine: street,
    city: str(addr.city) ?? input.city ?? undefined,
    state: str(addr.state) ?? input.state,
    zip: str(addr.zip) ?? str(addr.zipCode) ?? input.zip ?? undefined,
    county: str(addr.county) ?? input.countyName,
    ownerName,
    assessedValue: assessed,
    marketValue: market,
    landValue: num(assessment.landValue) ?? num(assessment.assessedLandValue),
    improvementValue:
      num(assessment.improvementValue) ?? num(assessment.assessedImprovementValue),
    lastSaleAmount:
      num(saleObj?.amount) ?? num(saleObj?.price) ?? num(saleObj?.saleAmount) ?? num(p.lastSalePrice),
    lastSaleDate: dateStr(
      saleObj?.date ?? saleObj?.saleDate ?? saleObj?.recordingDate ?? p.lastSaleDate,
    ),
    beds: num(building.bedrooms) ?? num(building.beds) ?? num(p.bedrooms),
    baths: num(building.bathrooms) ?? num(building.baths) ?? num(p.bathrooms),
    buildingSqft:
      num(building.livingArea) ??
      num(building.buildingArea) ??
      num(building.squareFeet) ??
      num(p.squareFeet),
    lotSqft: num(lot.lotSizeSqFt) ?? num(lot.squareFeet) ?? num(p.lotSize),
    acreage: num(lot.lotSizeAcres) ?? num(lot.acres) ?? num(p.acres),
    yearBuilt: num(building.yearBuilt) ?? num(p.yearBuilt),
    landUse: str(p.landUse) ?? str(p.propertyType),
    propertyType: str(p.propertyType) ?? str(p.propertyUse),
    latitude: num(addr.latitude) ?? num(p.latitude),
    longitude: num(addr.longitude) ?? num(p.longitude),
    raw: p,
  };
}

function cleanOneLine(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const street = v.split(",")[0]?.trim();
  return street && /[A-Za-z0-9]/.test(street) ? street : undefined;
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
