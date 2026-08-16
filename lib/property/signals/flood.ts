/**
 * FEMA flood hazard, at the parcel.
 *
 * ## Why this is the first signal after location
 *
 * Flood zone is the one environmental fact that converts directly into a
 * recurring cost and a financing constraint. A parcel inside a Special Flood
 * Hazard Area requires flood insurance for any federally backed mortgage, which
 * means the eventual retail buyer's payment includes a premium that has nothing
 * to do with the price — and on a low-value parcel that premium can exceed the
 * mortgage. It is also the fact most likely to be missing from a county tax
 * notice, which lists what is owed and nothing else.
 *
 * `lot_valuations.flood_zone` has existed as a column since the schema was
 * written and no provider has ever filled it. This fills it, from the authority
 * that publishes the maps.
 *
 * ## Measured
 *
 * The NFHL service answered in 80-255ms, keyless, for both a Houston parcel and
 * a rural Arkansas one. It is markedly faster and more reliable than Overpass,
 * which is why it is a separate source with its own freshness clock rather than
 * being folded in beside it.
 *
 * ## What SFHA_TF actually means
 *
 * `T` is inside a Special Flood Hazard Area — the 1%-annual-chance floodplain,
 * the one insurance is mandatory in. `F` is outside it, and outside is not the
 * same as safe: zone X carries a `ZONE_SUBTY` that distinguishes "minimal
 * hazard" from "0.2 percent annual chance", the 500-year floodplain. The
 * Arkansas parcel measured during development is exactly that second case, and
 * flattening both into "not in a flood zone" would have thrown away the
 * distinction that mattered.
 */

import {
  SignalSourceUnavailableError,
  type Signal,
  type SignalInput,
  type SignalSource,
} from "./types";

const NFHL_LAYER =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

interface FloodAttributes {
  FLD_ZONE?: string;
  ZONE_SUBTY?: string;
  SFHA_TF?: string;
  STATIC_BFE?: number;
}

/**
 * Plain-English zone descriptions.
 *
 * Written out rather than passed through, because "AE" is not information to
 * anyone who does not already know what it means, and the audience for a tax
 * deed auction is frequently a first-time buyer.
 */
const ZONE_MEANING: Record<string, string> = {
  A: "1% annual chance flood (100-year). Insurance mandatory with a federally backed loan; no base flood elevation published for this zone.",
  AE: "1% annual chance flood (100-year), with a published base flood elevation. Insurance mandatory with a federally backed loan.",
  AH: "1% annual chance shallow ponding, typically 1-3 feet. Insurance mandatory with a federally backed loan.",
  AO: "1% annual chance sheet flow flooding, typically 1-3 feet. Insurance mandatory with a federally backed loan.",
  AR: "Area temporarily protected by a flood control system being restored.",
  "A99": "1% annual chance flood, protected by a flood control system under construction.",
  V: "1% annual chance coastal flood with wave action. The most restrictive and most expensive to insure.",
  VE: "1% annual chance coastal flood with wave action and a published base flood elevation.",
  D: "Undetermined — no flood hazard analysis has been done here. Absence of a rating is not absence of risk.",
  X: "Outside the 1% annual chance floodplain.",
};

/** `-9999` is FEMA's null. Writing it as an elevation would be a 9,999-foot lie. */
const bfe = (v: number | undefined): number | undefined =>
  typeof v === "number" && v > -9000 && Number.isFinite(v) ? v : undefined;

export const floodSource: SignalSource = {
  name: "fema",
  configured: () => true,
  /*
   * FEMA revises panels continuously but any given community's map changes on
   * a multi-year cycle, and a remap is exactly the event worth catching — a
   * parcel moving into an SFHA changes what it is worth. Half a year is a
   * compromise between that and not re-asking a stable answer monthly.
   */
  ttlDays: 180,

  async fetch(input: SignalInput): Promise<Signal[]> {
    const { latitude, longitude } = input.location;
    const params = new URLSearchParams({
      geometry: `${longitude},${latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
      returnGeometry: "false",
      f: "json",
    });

    let data: { features?: { attributes: FloodAttributes }[]; error?: { message?: string } };
    try {
      const res = await fetch(`${NFHL_LAYER}?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new SignalSourceUnavailableError("fema", `HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      if (e instanceof SignalSourceUnavailableError) throw e;
      throw new SignalSourceUnavailableError("fema", e instanceof Error ? e.message : String(e));
    }

    if (data.error) {
      throw new SignalSourceUnavailableError("fema", data.error.message ?? "service error");
    }

    const a = data.features?.[0]?.attributes;
    /*
     * No feature means the point is outside every mapped panel, which is a real
     * and common state in unincorporated rural counties — not a failure, and
     * not a clean bill of health either. Returning nothing lets the caller
     * record an honest `empty`.
     */
    if (!a?.FLD_ZONE) return [];

    const zone = a.FLD_ZONE.toUpperCase();
    const subtype = a.ZONE_SUBTY ?? "";
    const inSFHA = a.SFHA_TF === "T";
    const elevation = bfe(a.STATIC_BFE);

    // The 500-year band, which reads as "zone X" and is not minimal hazard.
    const shadedX = /0\.2 PCT/i.test(subtype);

    const signal: Signal = {
      kind: inSFHA ? "flood.sfha" : shadedX ? "flood.moderate" : "flood.zone",
      source: "fema",
      // One flood answer per parcel, replaced in place on every refresh.
      featureKey: "nfhl-zone",
      direction: inSFHA ? "negative" : shadedX ? "negative" : "neutral",
      severity: inSFHA ? "high" : shadedX ? "low" : "low",
      label: inSFHA
        ? `FEMA flood zone ${zone} — special flood hazard area`
        : shadedX
          ? `FEMA zone ${zone} — 0.2% annual chance (500-year) band`
          : `FEMA flood zone ${zone}`,
      note: inSFHA
        ? `${ZONE_MEANING[zone] ?? "Special flood hazard area."} ` +
          `Flood insurance will be required for a federally backed mortgage, which is a permanent ` +
          `cost on any resale and can exceed the payment on a low-value parcel.` +
          (elevation !== undefined
            ? ` Base flood elevation ${elevation} ft — compare it to the parcel's own elevation.`
            : "")
        : shadedX
          ? `Outside the mandatory-insurance floodplain but inside the 0.2% annual chance band. ` +
            `Insurance is not required and is cheap here; lenders and buyers still ask.`
          : (ZONE_MEANING[zone] ?? "Outside the mapped special flood hazard area."),
      valueText: subtype ? `${zone} (${subtype})` : zone,
      value: elevation,
      raw: { ...a },
    };

    return [signal];
  },
};

export { ZONE_MEANING as FEMA_ZONE_MEANING };
