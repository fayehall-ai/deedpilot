/**
 * Types for the national tax-sale rules atlas.
 *
 * The atlas is the free tier and the SEO surface: every U.S. county resolves
 * to a rule set, either researched individually (COUNTY_DATA) or inherited
 * from its state's defaults (STATE_DATA). The inheritance is surfaced to the
 * user rather than hidden — see `ResolvedCountyRule.inherited`.
 */

/** The four systems states use to sell tax-defaulted property. */
export type SaleType = "Tax Lien" | "Tax Deed" | "Redeemable Deed" | "Hybrid";

/**
 * A contact or resource: county office, auction platform, GIS portal.
 *
 * `url` is optional because some references genuinely have no web presence —
 * "Sheriff's sale" on the courthouse steps is a real auction venue, not a
 * missing link. 147 of the researched refs are label-only.
 */
export interface LinkRef {
  label: string;
  url?: string;
  phone?: string;
}

/** A neighborhood trend note — directional, dated, sourced. Never a guarantee. */
export interface GrowthArea {
  name: string;
  why: string;
}

/** State-level defaults. Every state + DC has an entry. */
export interface StateRule {
  type: SaleType;
  /** How long the prior owner can reclaim the property, in prose. */
  redemption: string;
  /** Investor return if redeemed — interest rate, penalty, or "N/A" for deeds. */
  returns: string;
  statute: string;
  notes: string;
}

/**
 * County-level research. Every field is optional: a county entry overrides
 * only what has actually been verified for that county, and anything unset
 * falls back to the state default rather than being invented.
 */
export interface CountyRule {
  /**
   * The county's own sale-type label, where it differs from the state.
   *
   * Free-form rather than `SaleType` because counties run finer-grained
   * systems than the four national buckets — "Tax Lien Assignment" and
   * "Hybrid (Lien Assignment / Judicial Foreclosure)" are both real. Use
   * `toSaleType()` to get the canonical bucket for map colour and filtering.
   */
  type?: string;
  notes?: string;
  auctionFormat?: string;
  auctionPlatform?: LinkRef;
  auctionFrequency?: string;
  depositRules?: string;
  taxCollector?: LinkRef;
  clerkOfCourt?: LinkRef;
  propertyAppraiser?: LinkRef;
  /** Which liens survive the sale — the single most expensive thing to get wrong. */
  survivingLiens?: string;
  /** Whether a quiet title action is needed, and the realistic cost/duration. */
  quietTitle?: string;
  gisMap?: LinkRef;
  growthNeighborhoods?: GrowthArea[];
  /** YYYY-MM the auction logistics and contacts were last verified. */
  asOf?: string;
  sources?: string[];
}

/** A county as identified everywhere in the system: 5-digit FIPS is the key. */
export interface County {
  /** 5-digit FIPS: 2-digit state + 3-digit county. Canonical join key. */
  fips: string;
  name: string;
  /** 2-letter postal abbreviation. */
  state: string;
  stateName: string;
  population: number | null;
}

/**
 * A county's rules after state-default inheritance is applied.
 *
 * `inherited` lists the fields that came from the state rather than county
 * research, so the UI can label them honestly instead of implying a level of
 * verification that hasn't happened.
 */
export interface ResolvedCountyRule extends CountyRule {
  county: County;
  /** Display label — the county's own wording when it has one. */
  type: string;
  /** Canonical bucket for map colour, filtering, and deal maths. */
  saleType: SaleType;
  redemption: string;
  returns: string;
  statute: string;
  /** True when no county-specific research exists at all. */
  isStateDefault: boolean;
  /** Field names whose values came from the state, not county research. */
  inherited: string[];
}
