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
  /**
   * Assessor's assessed value — the ratio input.
   *
   * Empty where a state assesses in classes and no single ratio applies, in
   * which case the market figure carries the parcel on its own. Better to price
   * from a market value than to divide by a ratio that is wrong for the class.
   */
  assessedField: string;
  /** Appraised market value, where published. */
  marketField?: string;
  landField?: string;
  ownerField?: string;
  /** Situs address, where the layer carries one. */
  addressField?: string;
  /**
   * Fields to add together for a market value, where the assessor splits it.
   *
   * Lincoln County NM publishes `GTVALL` for land and `GTVALI` for improvements
   * and no total anywhere — a parcel with a house on it reads as land-only
   * unless the two are added. Summing is the layer's own arithmetic, not an
   * estimate, so it is safe in a way that inferring a total never would be.
   */
  marketSumFields?: string[];
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
  /*
   * Keyed by 5-digit county FIPS where a county publishes its own layer, and by
   * state where the state does. County entries win, because a county service is
   * the assessor's own and a statewide one is a roll-up of the same records.
   *
   * Cobb County alone holds 8,475 of Georgia's 8,730 stranded lots — 97% — so
   * one county entry unlocks the state in practice. Georgia publishes no
   * statewide parcel service; the concentration is what makes that survivable.
   */
  "13067": {
    url: "https://gis.cobbcounty.gov/gisserver/rest/services/cobbpublic/Parcels/MapServer/3/query",
    parcelField: "PIN",
    assessedField: "ASV_TOTAL",
    marketField: "FMV_TOTAL",
    landField: "FMV_LAND",
    ownerField: "OWNER_NAM1",
    addressField: "SITUS_ADDR",
    note: "Cobb County GA — public parcel layer, FMV and assessed value",
  },

  /*
   * Greenville County, South Carolina — 3,461 lots, and the county I twice
   * reported as having no queryable layer.
   *
   * The first hunt only probed the county's own domain. The second found
   * "Greenville_Parcels" on ArcGIS Online and I announced the earlier call
   * wrong; that layer turned out to be the town of Greenville, *Florida* — 197
   * rows of Florida DOR fields at 30.3°N. This one is the real thing: 215,484
   * rows, extent at 34.5°N / -82.75°W, and PIN values that match the sale list
   * verbatim.
   *
   * `FAIRMKTVAL` only, and deliberately no assessed value. South Carolina
   * assesses in classes — 4% owner-occupied, 6% other, 10.5% manufacturing —
   * so there is no single ratio to divide by and `compute_maxbid` would apply
   * the wrong one. A fair market value prices the parcel directly and skips the
   * question, which is what the SC statute proposal recommended before any of
   * this existed. `TAXMKTVAL` is left alone because it is not established here
   * whether it is net of exemptions.
   */
  "45045": {
    url: "https://services.arcgis.com/zTM0LZtJeE1HzO09/arcgis/rest/services/kx_greenville_county_sc_tax_parcel_SHP/FeatureServer/0/query",
    parcelField: "PIN",
    assessedField: "",
    marketField: "FAIRMKTVAL",
    landField: "LANDVAL",
    note: "Greenville County SC — tax parcels, fair market value (classified ratios: no single assessed ratio)",
  },

  /*
   * Lincoln County, New Mexico. Surfaced by verified discovery and left unwired
   * for a day because the verifier reported `VALIDATIONSTATUS` as its value
   * field — the field regex matched "val" inside "VALIDATION". The real figures
   * are GTVALL and GTVALI, populated on 38,807 of 39,223 rows.
   *
   * No assessed value is written. New Mexico's own ratio is unsettled — the
   * Cartographer found the statute defines a market value and a separate 33 1/3%
   * tax ratio, with a 3% annual cap distorting the base — so a market figure
   * priced directly is the honest input and skips the question.
   */
  "35027": {
    url: "https://services.arcgis.com/4YineAQdtmx0tv46/arcgis/rest/services/Parcel_LincolnNM/FeatureServer/0/query",
    parcelField: "PIN",
    assessedField: "",
    marketField: "",
    marketSumFields: ["GTVALL", "GTVALI"],
    landField: "GTVALL",
    note: "Lincoln County NM — parcels; land + improvement values summed",
  },

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

/** An Esri geometry, in the two shapes these layers actually return. */
type EsriGeometry =
  | { x: number; y: number }
  | { rings: [number, number][][] }
  | Record<string, unknown>;

/**
 * Where the parcel is, from the geometry the layer was already sending.
 *
 * ## Why this exists
 *
 * Every cadastre lookup used to pass `returnGeometry: "false"`, and 16,001
 * parcels were matched under that setting. The assessed values were kept and
 * the coordinates — in the same response, at no extra cost, from a service
 * that charges nothing and meters nothing — were discarded on the way past.
 *
 * That was not a small omission. Only 4,002 of 25,702 lots carry a location,
 * and a location is the precondition for every question about what surrounds a
 * parcel: the flood zone it sits in, the rail line behind it, the substation
 * next door. Turning the flag on recovers all of it retroactively, because the
 * layer will answer the same query again for free.
 *
 * ## Both shapes, because both are published
 *
 * Arkansas's statewide service returns `{x, y}` — the assessor's parcel
 * *centroid*, which is all it holds. Cobb County GA returns `rings`, a real
 * boundary polygon, 77 points for a suburban lot. Polygons are worth more than
 * their centroid: a distance measured from a boundary is the distance a person
 * standing on the parcel would experience, and on a forty-acre tract the
 * centroid can be a quarter-mile from the thing that matters.
 *
 * So the ring is kept as well as reduced. `boundary` records that the polygon
 * is available for a real edge distance later; `centroid` admits the number is
 * the best the source published.
 */
export function parcelLocation(geometry: EsriGeometry | undefined | null):
  | { latitude: number; longitude: number; basis: "centroid" | "boundary"; ring?: [number, number][] }
  | undefined {
  if (!geometry) return undefined;

  const g = geometry as { x?: unknown; y?: unknown; rings?: unknown };

  // A point layer: the assessor's own centroid, used verbatim.
  if (typeof g.x === "number" && typeof g.y === "number") {
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return undefined;
    /*
     * Guarded because a layer that ignores `outSR` returns Web Mercator metres
     * (±20,000,000) rather than degrees, and writing those into a lat/lon
     * column puts the parcel in the Gulf of Guinea — a silent, plausible,
     * completely wrong answer of exactly the kind the parcel-id matcher
     * refuses to make.
     */
    if (Math.abs(g.y) > 90 || Math.abs(g.x) > 180) return undefined;
    return { latitude: g.y, longitude: g.x, basis: "centroid" };
  }

  if (Array.isArray(g.rings) && g.rings.length > 0) {
    const ring = g.rings[0] as [number, number][];
    const pts = ring.filter(
      (p) =>
        Array.isArray(p) &&
        typeof p[0] === "number" &&
        typeof p[1] === "number" &&
        Math.abs(p[1]) <= 90 &&
        Math.abs(p[0]) <= 180,
    );
    if (pts.length < 3) return undefined;
    /*
     * The mean of the vertices, not the centre of the bounding box.
     *
     * Both are approximations of a polygon centroid and neither is exact, but
     * the mean degrades gracefully on the shape that dominates rural
     * inventory: a long thin strip along a road, where the bounding-box centre
     * routinely falls outside the parcel entirely — on a neighbour's land, or
     * in the middle of the road. A point that is not on the parcel would
     * measure every distance from the wrong place.
     */
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { latitude: lat, longitude: lon, basis: "boundary", ring: pts };
  }

  return undefined;
}

export const cadastreProvider: PropertyProvider = {
  name: "cadastre",

  configured() {
    // No key. Availability is a property of the state, checked per lookup.
    return true;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    // County first, then state — a county publishes the assessor's own layer and
    // a statewide service is a roll-up of the same records.
    const src =
      (input.fips ? CADASTRE_SOURCES[input.fips] : undefined) ??
      CADASTRE_SOURCES[input.state?.toUpperCase() ?? ""];
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
        outFields: [
          src.parcelField,
          src.assessedField || undefined,
          src.marketField || undefined,
          ...(src.marketSumFields ?? []),
          src.landField,
          src.ownerField,
          src.addressField,
        ]
          .filter(Boolean)
          .join(","),
        /*
         * On, and free. See `parcelLocation` — this flag was `false` for the
         * first 16,001 matches and the coordinates in every one of those
         * responses were dropped on the floor.
         */
        returnGeometry: "true",
        // Degrees, explicitly. A layer left to its own default returns Web
        // Mercator metres, which `parcelLocation` rejects rather than misplace
        // the parcel by several thousand miles.
        outSR: "4326",
        f: "json",
      });

      let data: {
        features?: { attributes: Record<string, unknown>; geometry?: unknown }[];
        error?: unknown;
      };
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
      const assessed = src.assessedField ? num(a[src.assessedField]) : undefined;
      /*
       * A summed market value counts as present when ANY part is, because a
       * vacant lot legitimately has improvements of zero — requiring both would
       * discard every unimproved parcel, which is most of a tax sale.
       */
      const summed = src.marketSumFields?.length
        ? src.marketSumFields.reduce<number | undefined>((total, f) => {
            const v = num(a[f]);
            return v === undefined ? total : (total ?? 0) + v;
          }, undefined)
        : undefined;
      const market = (src.marketField ? num(a[src.marketField]) : undefined) ?? summed;
      if (assessed === undefined && market === undefined) continue;

      const located = parcelLocation(rows[0].geometry as never);

      return {
        source: "cadastre",
        parcelNumber: String(a[src.parcelField] ?? input.parcelNumber),
        assessedValue: assessed,
        marketValue: market,
        landValue: src.landField ? num(a[src.landField]) : undefined,
        ownerName: src.ownerField ? (a[src.ownerField] as string) || undefined : undefined,
        /*
         * The parcel's own coordinates, which every downstream site-intel
         * question depends on. Flowing through `PropertyRecord` rather than a
         * side channel because `applyRecordToLot` already writes these two
         * fields — the plumbing was there the whole time and had nothing to
         * carry.
         */
        latitude: located?.latitude,
        longitude: located?.longitude,
        // Situs addresses arrive column-aligned from the assessor's mainframe —
        // "195   FOWLER  CIR  NE". Collapsed, or every downstream match fails on
        // whitespace.
        addressLine: src.addressField
          ? ((a[src.addressField] as string) || "").replace(/\s+/g, " ").trim() || undefined
          : undefined,
      };
    }

    return null;
  },
};
