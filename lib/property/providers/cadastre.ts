/**
 * Assessed values straight from a state's own parcel service.
 *
 * ## Why this sits above the paid providers
 *
 * ATTOM is an aggregator. Its raw material is county assessor rolls and recorder
 * transfers — public records, bought or scraped, then normalised across three
 * thousand counties. What a subscription buys is the normalising, not the
 * access. When ATTOM returned 401 and BatchData ran out of credit, 20,358 of
 * 24,934 parcels had no valuation and every statute promotion downstream became
 * pointless.
 *
 * Several states publish the same underlying data themselves, as a standard
 * ArcGIS REST service: free, unauthenticated, and queryable by parcel id.
 * Arkansas's is the County Assessor Mapping Program cadastre, carrying
 * `assessvalue`, `landvalue` and `totalvalue` for the whole state.
 *
 * So this provider is ordered **first**, ahead of the paid ones. It is not a
 * fallback for when they fail; where it has coverage it is the better source,
 * because it is the assessor's own layer rather than a copy of it.
 *
 * ## The measurement that justified building it
 *
 * Six Arkansas parcels with no assessed value, queried against the state
 * cadastre: three exact matches, each under a second. The values are internally
 * coherent in a way that is hard to fake —
 *
 *     assessed 164,940 / total 824,700 = 0.2000
 *     assessed   8,610 / total  43,050 = 0.2000
 *
 * which is exactly the 20% ratio the Cartographer verified against
 * A.C.A. § 26-26-303 and merged into `STATUTE_PARAMS.AR`. Two independent routes
 * to the same constant is good evidence that both are right.
 *
 * ## Why this one may write `assessedValue`
 *
 * Unlike the searched provider, which is barred from that field, this is a
 * genuine assessor figure — the exact input `compute_maxbid` expects to divide
 * by `assessmentRatio`. It also supplies `totalvalue`, the appraised market
 * figure, which prices a parcel without needing the ratio at all and is the
 * better input where a state's ratio is classified (South Carolina) or disputed
 * (New Mexico).
 *
 * ## Coverage is uneven, and that is the honest limit
 *
 * Not every state publishes one. Greenville County, South Carolina — 3,461 of
 * our stranded lots — has no queryable parcel layer at all: its cadastral
 * sublayer errors with "Geodatabase client is incompatible". A county-by-county
 * hunt is the wrong shape; a state-level service covers every county at once, so
 * the registry below is keyed by state and grows one entry at a time.
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";

interface CadastreSource {
  /** Layer query endpoint, without a query string. */
  url: string;
  /** Field holding the parcel identifier. */
  parcelField: string;
  /** Field holding the 5-digit county FIPS, when the layer is statewide. */
  countyField?: string;
  /** Assessor's assessed value — the ratio input. */
  assessedField: string;
  /** Appraised market value, where published. */
  marketField?: string;
  landField?: string;
  ownerField?: string;
  note: string;
}

/**
 * One entry per state that publishes a queryable parcel layer.
 *
 * Deliberately explicit rather than discovered at runtime. A wrong field mapping
 * writes a land value into an assessed-value column and misprices every parcel
 * in the state, so each entry is something a person checked once.
 */
export const CADASTRE_SOURCES: Record<string, CadastreSource> = {
  AR: {
    url: "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/0/query",
    parcelField: "parcelid",
    countyField: "countyfips",
    assessedField: "assessvalue",
    marketField: "totalvalue",
    landField: "landvalue",
    ownerField: "ownername",
    note: "Arkansas GIS Office — County Assessor Mapping Program parcel centroids",
  },
};

/**
 * Parcel ids as published by a tax notice and by a cadastre rarely agree on
 * punctuation. Both forms are tried: the id verbatim, then digits only.
 *
 * Nothing looser than that. A partial or fuzzy match would return a *different
 * parcel's* assessed value, which is the one failure mode that matters here —
 * it would be silent, plausible, and would misprice a bid.
 */
function candidates(parcel: string): string[] {
  const raw = parcel.trim();
  const digits = raw.replace(/\D/g, "");
  return [...new Set([raw, digits].filter((s) => s.length >= 4))];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

export const cadastreProvider: PropertyProvider = {
  name: "cadastre",

  configured() {
    // No key. Availability is a property of the state, checked per lookup.
    return true;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const src = CADASTRE_SOURCES[input.state?.toUpperCase() ?? ""];
    if (!src || !input.parcelNumber) return null;

    for (const candidate of candidates(input.parcelNumber)) {
      const clauses = [`${src.parcelField}='${candidate.replace(/'/g, "''")}'`];
      if (src.countyField && input.fips) {
        // Scoped to the county even on a statewide layer: parcel ids are only
        // unique within a county, and a bare id can collide across them.
        clauses.push(`${src.countyField}='${input.fips}'`);
      }

      const params = new URLSearchParams({
        where: clauses.join(" AND "),
        outFields: [src.parcelField, src.assessedField, src.marketField, src.landField, src.ownerField]
          .filter(Boolean)
          .join(","),
        returnGeometry: "false",
        f: "json",
      });

      let data: { features?: { attributes: Record<string, unknown> }[]; error?: unknown };
      try {
        const res = await fetch(`${src.url}?${params}`, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) continue;
        data = await res.json();
      } catch {
        // A slow or unreachable state service is not a fact about the parcel.
        continue;
      }

      if (data.error) continue;
      const rows = data.features ?? [];
      // Exactly one row, or we do not know which parcel this is.
      if (rows.length !== 1) continue;

      const a = rows[0].attributes;
      const assessed = num(a[src.assessedField]);
      const market = src.marketField ? num(a[src.marketField]) : undefined;
      if (assessed === undefined && market === undefined) continue;

      return {
        source: "cadastre",
        parcelNumber: String(a[src.parcelField] ?? input.parcelNumber),
        assessedValue: assessed,
        marketValue: market,
        landValue: src.landField ? num(a[src.landField]) : undefined,
        ownerName: src.ownerField ? (a[src.ownerField] as string) || undefined : undefined,
      };
    }

    return null;
  },
};
