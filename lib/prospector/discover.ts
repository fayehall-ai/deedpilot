/**
 * Candidate generation for the Source Prospector.
 *
 * The cheapest source of candidates is the one already in the repo. 152 counties
 * have been researched by hand into `COUNTY_DATA`, each carrying up to five
 * `LinkRef`s — tax collector, clerk of court, auction platform, property
 * appraiser, GIS. Those *are* the sources of record for those counties; nobody
 * needs to go find them again. Harvesting the atlas first means the Prospector
 * starts with real, human-verified URLs and only searches where research is
 * genuinely absent.
 *
 * Anything not in the atlas falls back to state-level platform patterns — the
 * handful of hosts that publish for many counties at once (Title Check for
 * Michigan, LGBS for Texas). Those are high-yield precisely because one host
 * covers dozens of counties.
 */

import { COUNTY_DATA, getCounty } from "../atlas";
import type { CountyRule, LinkRef } from "../atlas/types";
import type { CandidateOrigin, SourceCandidate } from "./types";

/** Atlas LinkRef fields worth prospecting, most authoritative first. */
const LINK_FIELDS: { field: keyof CountyRule; label: string }[] = [
  { field: "taxCollector", label: "tax collector" },
  { field: "clerkOfCourt", label: "clerk of court" },
  { field: "auctionPlatform", label: "auction platform" },
  { field: "propertyAppraiser", label: "property appraiser" },
  { field: "gisMap", label: "GIS map" },
];

/**
 * Hosts that publish for many counties in a state.
 *
 * Deliberately not a URL template per county: guessing county-specific paths
 * produces 404s at scale and hammers government servers for nothing. These are
 * entry points the verifier can follow links from.
 */
const STATE_PLATFORMS: Record<string, { url: string; label: string }[]> = {
  MI: [{ url: "https://www.tax-sale.info/", label: "Title Check statewide auction host" }],
  TX: [{ url: "https://taxsales.lgbs.com/", label: "LGBS statewide sale listings" }],
  AZ: [{ url: "https://www.govease.com/", label: "GovEase lien auction platform" }],
};

function isHttp(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Candidate URLs for one county, deduplicated, atlas-first.
 *
 * Returns an empty array for a county with no researched links and no state
 * platform — that is a real gap, and reporting it as such is the point.
 */
export function candidatesFor(fips: string): SourceCandidate[] {
  const county = getCounty(fips);
  if (!county) return [];

  const rule = (COUNTY_DATA as Record<string, CountyRule | undefined>)[fips];
  const out: SourceCandidate[] = [];
  const seen = new Set<string>();

  const push = (url: string, origin: CandidateOrigin, label: string) => {
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ fips, state: county.state, url, origin, label });
  };

  if (rule) {
    for (const { field, label } of LINK_FIELDS) {
      const ref = rule[field] as LinkRef | undefined;
      if (ref && isHttp(ref.url)) push(ref.url, "atlas", `${label}: ${ref.label}`);
    }
    // Researched `sources` are the citations behind the county's rules — often
    // the statute or the sale-terms page, both useful to the Cartographer.
    for (const src of rule.sources ?? []) {
      if (isHttp(src)) push(src, "atlas", "county research citation");
    }
  }

  for (const p of STATE_PLATFORMS[county.state] ?? []) {
    push(p.url, "platform_pattern", p.label);
  }

  return out;
}

/** Counties that already carry researched links — the high-yield set. */
export function countiesWithAtlasLinks(): string[] {
  return Object.keys(COUNTY_DATA).filter((fips) =>
    candidatesFor(fips).some((c) => c.origin === "atlas"),
  );
}
