/**
 * Candidate generation — the actual bottleneck for national coverage.
 *
 * The Prospector can only verify URLs it is handed, and the atlas carries links
 * for the 152 counties someone researched by hand. That left **2,647 of 3,142
 * counties with zero candidates**, which is why coverage stalled: not a parsing
 * problem, not a scheduling problem, just nothing to fetch.
 *
 * Two sources of candidates, in descending order of leverage:
 *
 * 1. **Statewide publishers.** Some states run tax sales centrally — Arkansas
 *    through the Commissioner of State Lands, West Virginia through the State
 *    Auditor, New Mexico through Taxation & Revenue. One URL covers every county
 *    in the state, and West Virginia's is a *results* page, which is the scarce
 *    thing. These were found by looking for hosts already serving several
 *    counties in the researched atlas rather than by guessing.
 *
 * 2. **County domain patterns.** US county governments use a small set of
 *    conventions (`co.<name>.<st>.us`, `<name>county.gov`, `<name>county<st>.gov`),
 *    which the researched counties confirm. Generating and probing these needs no
 *    search API and no third-party directory.
 *
 * Patterns produce a *homepage*, not a sale page, so they feed the two-stage
 * discovery in `verify.ts`: resolve the county site, then crawl it for the tax
 * sale. A homepage on its own scores below the relevance threshold and is
 * correctly rejected as a source.
 */

import type { County } from "../atlas/types";
import type { SourceCandidate } from "./types";

/**
 * States whose sales are published centrally.
 *
 * `coversAllCounties` marks a genuine statewide publisher; NYC's lien sale
 * covers five boroughs and is not New York State, so it is scoped honestly.
 */
export interface StatewideSource {
  url: string;
  label: string;
  /** True when one URL genuinely serves every county in the state. */
  coversAllCounties: boolean;
  /** Present when this publishes past results — the scarce input. */
  publishesResults?: boolean;
  /** Restrict to these FIPS when the source is not truly statewide. */
  onlyFips?: string[];
}

export const STATEWIDE_SOURCES: Record<string, StatewideSource[]> = {
  AR: [
    {
      url: "https://www.cosl.org/",
      label: "Arkansas Commissioner of State Lands — statewide tax-delinquent sales",
      coversAllCounties: true,
      publishesResults: true,
    },
  ],
  WV: [
    {
      url: "https://www.wvsao.gov/CountyCollections/delinquentlandresults",
      label: "WV State Auditor — statewide delinquent land sale RESULTS",
      coversAllCounties: true,
      publishesResults: true,
    },
  ],
  NM: [
    {
      url: "https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/",
      label: "New Mexico Taxation & Revenue — delinquent property tax auctions",
      coversAllCounties: true,
    },
  ],
  MI: [
    {
      url: "https://www.tax-sale.info/",
      label: "Title Check — Michigan county foreclosure auctions",
      coversAllCounties: true,
      publishesResults: true,
    },
  ],
  TX: [
    {
      url: "https://taxsales.lgbs.com/",
      label: "Linebarger Goggan — Texas delinquent tax sale listings",
      coversAllCounties: false,
    },
  ],
  AZ: [
    {
      url: "https://www.govease.com/",
      label: "GovEase — Arizona lien auction platform",
      coversAllCounties: false,
    },
  ],
  NJ: [
    {
      url: "https://www.tctanj.org/",
      label: "NJ Tax Collectors & Treasurers Association — municipal sale directory",
      coversAllCounties: true,
    },
  ],
  RI: [
    {
      url: "https://dor.ri.gov/municipal-finance",
      label: "RI Division of Municipal Finance",
      coversAllCounties: true,
    },
  ],
  NY: [
    {
      url: "https://www.nyc.gov/site/finance/property/property-lien-sales.page",
      label: "NYC Department of Finance — lien sale (five boroughs only)",
      coversAllCounties: false,
      onlyFips: ["36005", "36047", "36061", "36081", "36085"],
    },
  ],
};

/** Normalise a county name into the slug used in government hostnames. */
export function countySlugForHost(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(county|parish|borough|census area|city and borough|municipality)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Candidate homepages for a county, most likely first.
 *
 * Ordering matters because probing stops at the first host that resolves, and
 * `co.<name>.<st>.us` plus `<name>county.gov` between them cover the large
 * majority of US counties.
 */
export function countyDomainPatterns(county: County): string[] {
  const slug = countySlugForHost(county.name);
  if (!slug) return [];
  const st = county.state.toLowerCase();

  const hosts = [
    `co.${slug}.${st}.us`,
    `${slug}county.gov`,
    `${slug}county${st}.gov`,
    `www.${slug}county.gov`,
    `${slug}county.org`,
    `${slug}county.com`,
    `${slug}.${st}.us`,
    `${slug}countytreasurer.com`,
    `${slug}countyclerk.org`,
    `${slug}county.${st}.gov`,
  ];

  return [...new Set(hosts)].map((h) => `https://${h}/`);
}

/**
 * Statewide candidates applicable to a county.
 *
 * A source scoped to specific FIPS (NYC) is only offered to those counties, so
 * a Buffalo parcel is never told to look at the New York City lien sale.
 */
export function statewideCandidatesFor(county: County): SourceCandidate[] {
  const sources = STATEWIDE_SOURCES[county.state] ?? [];
  return sources
    .filter((s) => !s.onlyFips || s.onlyFips.includes(county.fips))
    .map((s) => ({
      fips: county.fips,
      state: county.state,
      url: s.url,
      origin: "platform_pattern" as const,
      label: s.label,
    }));
}

/** How many counties a statewide source is claimed to serve, for reporting. */
export function statewideCoverage(): { state: string; label: string; results: boolean }[] {
  const out: { state: string; label: string; results: boolean }[] = [];
  for (const [state, sources] of Object.entries(STATEWIDE_SOURCES)) {
    for (const s of sources) {
      if (!s.coversAllCounties) continue;
      out.push({ state, label: s.label, results: Boolean(s.publishesResults) });
    }
  }
  return out.sort((a, b) => a.state.localeCompare(b.state));
}
