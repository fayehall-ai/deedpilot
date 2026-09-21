/**
 * Source-of-record discovery types.
 *
 * The registry this produces is version-controlled content, not database rows:
 * a county's tax collector URL changes rarely, is reviewed when it does, and
 * everything downstream (Scout, Archivist) is worthless if it is wrong. Same
 * reasoning that keeps the rules atlas in `lib/atlas/`.
 */

/** What a source page is actually for. */
export type SourceKind =
  /** Upcoming sale list — parcels, minimum bids, sale date. */
  | "listing"
  /** Past sale results — sold prices, struck-off parcels. */
  | "results"
  /** Rules, terms, bidder registration, deposit requirements. */
  | "rules"
  /** Sale calendar / schedule of upcoming auctions. */
  | "calendar"
  /** Looks relevant but the page did not identify itself. */
  | "unknown";

/** Where a candidate URL came from. Provenance for the registry. */
export type CandidateOrigin =
  /** Already researched into the county atlas as a LinkRef. */
  | "atlas"
  /** Derived from a known per-state platform pattern. */
  | "platform_pattern"
  /**
   * The domain of a county contact's email address.
   *
   * A fact, not a guess. The sale calendar names a person at the county and
   * gives their address — `swhitehead@grantcountyar.com` — and the domain is
   * where that county actually publishes, stated by the county itself. That
   * makes it strictly better evidence than a generated hostname, which is why
   * it ranks above `platform_pattern`.
   */
  | "contact_email"
  /** Followed from a link on an already-verified page. */
  | "link_followed"
  /**
   * A county property-list link the Auction Scout found — its research, or
   * Ed's workbook — held in `county_sources` and merged in at runtime rather
   * than committed. See `lib/ingest/county-sources.ts`.
   */
  | "auction_scout";

export interface SourceCandidate {
  fips: string;
  state: string;
  url: string;
  origin: CandidateOrigin;
  /** The atlas field or pattern that produced it, for auditing. */
  label: string;
}

/** Why a candidate was rejected. Kept so coverage gaps are explainable. */
export type RejectionReason =
  | "policy_blocked"
  | "fetch_failed"
  | "not_tax_sale_content"
  | "duplicate";

export interface VerifiedSource {
  fips: string;
  state: string;
  url: string;
  host: string;
  origin: CandidateOrigin;
  kind: SourceKind;
  /** True when the host is a .gov/.us government publisher. */
  isGovernment: boolean;
  /**
   * 0-1. Driven by deterministic signals (government host, tax-sale vocabulary
   * density, presence of a parcel list) — not by model self-report, which is
   * not evidence.
   */
  confidence: number;
  /** Vocabulary matches that earned the score, so a low score is explainable. */
  signals: string[];
  /** Sale-timing hint found on the page, feeding calendar research. */
  scheduleHint?: string;
  /** YYYY-MM-DD this URL was last fetched successfully. */
  verifiedOn: string;
  httpStatus: number;
}

export interface RejectedCandidate extends SourceCandidate {
  reason: RejectionReason;
  detail: string;
}

export interface ProspectResult {
  fips: string;
  state: string;
  county: string;
  verified: VerifiedSource[];
  rejected: RejectedCandidate[];
  /** True when no usable government source was found — a real coverage gap. */
  isGap: boolean;
  note: string;
}

/** The persisted registry shape. */
export interface SourceRegistry {
  builtAt: string;
  nCounties: number;
  nVerified: number;
  nGaps: number;
  /** Keyed by FIPS. */
  counties: Record<
    string,
    {
      state: string;
      county: string;
      sources: VerifiedSource[];
      isGap: boolean;
    }
  >;
}
