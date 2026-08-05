/**
 * ATTOM property API — APN + FIPS lookup (works when we only have parcel #).
 * Docs: https://api.gateway.attomdata.com/
 *
 * Env: ATTOM_API_KEY
 *
 * Notes:
 * - HTTP 400 + SuccessWithoutResult means "no match" (not an auth failure).
 * - APN formatting varies by county; we try a few normalizations.
 * - Some sale lists (e.g. Brevard) publish account/file IDs that are not
 *   assessor APNs — those will not match until we have a real parcel #.
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";

const BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

/**
 * Candidate APN strings — keep short to protect trial quota.
 * Prefer the raw clerk value first; one normalization max.
 */
export function apnVariants(parcel: string): string[] {
  const p = parcel.trim();
  if (!p) return [];
  const out: string[] = [p];
  // Volusia-style compact 12-digit → AAAA-BB-CC-DDDD (ATTOM often stores dashed)
  const digits = p.replace(/\D/g, "");
  if (digits.length === 12 && !p.includes("-")) {
    out.push(
      `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`,
    );
  } else if (digits.length === 12 && p.includes("-")) {
    // also try compact form
    out.push(digits);
  } else if (/[-.\s]/.test(p)) {
    // only if original had separators — try stripped second
    const stripped = p.replace(/[-.\s]/g, "");
    if (stripped !== p) out.push(stripped);
  }
  // Columbia FL style 01438-069 → try zero-padded / compact variants lightly
  if (/^\d{5}-\d{3}$/.test(p)) {
    out.push(p.replace("-", ""));
    out.push(`${p}-000`);
  }
  if (/^\d{5}-\d{3,4}$/.test(p)) {
    out.push(p.replace(/-/g, ""));
  }
  return out;
}

export const attomProvider: PropertyProvider = {
  name: "attom",

  configured() {
    return (process.env.ATTOM_API_KEY ?? "").trim().length > 0;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const key = (process.env.ATTOM_API_KEY ?? "").trim();
    if (!key) return null;

    const headers = {
      apikey: key,
      Accept: "application/json",
    };

    // --- Parcel / APN path ------------------------------------------------
    // One endpoint (expandedprofile). Try raw APN then at most one alternate.
    // Multi-endpoint × multi-variant loops burned trial quota on Brevard misses.
    if (input.parcelNumber?.trim() && input.fips) {
      for (const apn of apnVariants(input.parcelNumber)) {
        const qs = new URLSearchParams({ apn, fips: input.fips });
        const rec = await fetchProperty(
          `${BASE}/property/expandedprofile?${qs}`,
          headers,
          input,
        );
        if (rec) return rec;
      }
    }

    // --- Address path -----------------------------------------------------
    if (input.addressLine?.trim()) {
      const qs = new URLSearchParams({
        address1: input.addressLine.trim(),
        address2: [input.city, input.state, input.zip].filter(Boolean).join(", "),
      });
      const rec = await fetchProperty(
        `${BASE}/property/expandedprofile?${qs}`,
        headers,
        input,
      );
      if (rec) return rec;
    }

    return null;
  },
};

async function fetchProperty(
  url: string,
  headers: Record<string, string>,
  input: EnrichInput,
): Promise<PropertyRecord | null> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: {
    status?: { code?: number; msg?: string; total?: number };
    property?: Array<Record<string, unknown>>;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    if (!res.ok) throw new Error(`attom ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const msg = (data.status?.msg ?? "").toLowerCase();
  // ATTOM returns HTTP 400 + SuccessWithoutResult when the APN/address misses.
  if (
    msg.includes("successwithoutresult") ||
    data.status?.total === 0 ||
    res.status === 404
  ) {
    return null;
  }

  if (!res.ok || (data.status?.code !== undefined && data.status.code !== 0)) {
    // Real errors (auth, quota, bad request shape)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`attom ${res.status}: invalid or unauthorized API key`);
    }
    throw new Error(`attom ${res.status}: ${text.slice(0, 200)}`);
  }

  const p = data.property?.[0];
  if (!p) return null;
  return mapProperty(p, input);
}

function mapProperty(p: Record<string, unknown>, input: EnrichInput): PropertyRecord {
  const addr = (p.address ?? {}) as Record<string, unknown>;
  const summary = (p.summary ?? {}) as Record<string, unknown>;
  const building = (p.building ?? {}) as Record<string, unknown>;
  const rooms = (building.rooms ?? {}) as Record<string, unknown>;
  const size = (building.size ?? {}) as Record<string, unknown>;
  const assessment = (p.assessment ?? {}) as Record<string, unknown>;
  const assessed = (assessment.assessed ?? {}) as Record<string, unknown>;
  const market = (assessment.market ?? {}) as Record<string, unknown>;
  const sale = (p.sale ?? {}) as Record<string, unknown>;
  const saleAmount = (sale.amount ?? sale.saleAmountInfo ?? {}) as Record<string, unknown>;
  const owner = (p.owner ?? {}) as Record<string, unknown>;
  const lot = (p.lot ?? {}) as Record<string, unknown>;
  const geo = (p.location ?? {}) as Record<string, unknown>;

  // Prefer street line; oneLine is often "street, city, ST zip" — use only when line1 empty.
  // Never keep ATTOM junk like ", , FL" or ", ORANGE CITY, FL" (missing street).
  const street = cleanAddress(str(addr.line1));
  const oneLine = cleanAddress(str(addr.oneLine));
  let addressLine = street;
  if (!addressLine && oneLine) {
    const first = oneLine.split(",")[0]?.trim() ?? "";
    // Reject leading-comma / city-only first segments
    if (first && /[0-9]/.test(first)) addressLine = first;
    else if (first && !/^(FL|FLORIDA)$/i.test(first) && first.length > 3 && /[A-Za-z]/.test(first) && !first.startsWith(",")) {
      // street without house number (e.g. "MCBRIDE AVE") — keep
      if (!/^[A-Z][a-z]+(\s[A-Z][a-z]+)?$/.test(first) || first.split(" ").length >= 2) {
        addressLine = first;
      }
    }
  }

  return {
    source: "attom",
    parcelNumber: str(p.identifier ? (p.identifier as { apn?: string }).apn : undefined),
    addressLine,
    city: str(addr.locality),
    state: str(addr.countrySubd) ?? input.state,
    zip: str(addr.postal1),
    county: str(addr.countrySecSubd) ?? input.countyName,
    ownerName: str(
      (owner.owner1 as { fullName?: string; lastName?: string } | undefined)?.fullName ??
        (owner.owner1 as { lastName?: string } | undefined)?.lastName,
    ),
    assessedValue: num(assessed.assdTtlValue) ?? num(assessed.ttlassessedvalue),
    marketValue: num(market.mktttlvalue) ?? num(market.mktTtlValue),
    landValue: num(assessed.assdLandValue),
    improvementValue: num(assessed.assdImpValue),
    lastSaleAmount: num(saleAmount.saleamt) ?? num(saleAmount.saleAmt),
    lastSaleDate: dateStr(sale.salesearchdate ?? sale.saleTransDate),
    beds: num(rooms.beds),
    baths: num(rooms.bathstotal) ?? num(rooms.bathsTotal),
    buildingSqft: num(size.universalsize) ?? num(size.bldgsize),
    lotSqft: num(lot.lotsize1) ?? num(lot.lotSize1),
    acreage: num(lot.lotsize2) ?? num(lot.lotSize2),
    yearBuilt: num(summary.yearbuilt) ?? num(summary.yearBuilt),
    landUse: str(summary.proptype) ?? str(summary.propType),
    propertyType: str(summary.propsubtype),
    latitude: num(geo.latitude),
    longitude: num(geo.longitude),
    raw: p,
  };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

/** Drop empty / punctuation-only / ", , FL" style garbage. */
function cleanAddress(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  // only commas/spaces/state leftovers
  if (/^[,\s.]*$/.test(t)) return undefined;
  if (/^,\s*,/.test(t)) return undefined;
  // no alphanumerics at all
  if (!/[A-Za-z0-9]/.test(t)) return undefined;
  return t;
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
