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

import { countyDomainPatterns, statewideCandidatesFor } from "./candidates";

/**
 * Mail hosts that say nothing about where a county publishes.
 *
 * A clerk using a personal address is ordinary — De Baca County, New Mexico
 * lists one on `live.com` — and turning that into `https://live.com/` puts
 * Microsoft's homepage at the top of a county's candidate list. Checked as a
 * suffix so `mail.live.com` and the like are caught too.
 */
const FREE_MAIL = [
  "gmail.com", "yahoo.com", "hotmail.com", "aol.com", "outlook.com", "live.com",
  "msn.com", "me.com", "icloud.com", "comcast.net", "att.net", "bellsouth.net",
  "sbcglobal.net", "verizon.net", "cox.net", "charter.net", "windstream.net",
  "frontier.com", "protonmail.com", "proton.me", "mail.com", "gmx.com",
  "yandex.com", "zoho.com", "embarqmail.com", "centurylink.net", "earthlink.net",
];

/** True when a domain is a mail provider rather than an organisation's own. */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  return FREE_MAIL.some((f) => d === f || d.endsWith(`.${f}`));
}

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
 * Candidate URLs for one county, deduplicated, in descending order of trust:
 * researched atlas links, then statewide publishers, then generated county
 * domains.
 *
 * `includePatterns` is off by default because generated domains are *probes*,
 * not known sources — most will not resolve, and callers doing a cheap pass
 * should not pay for them. The national discovery run turns them on.
 */
export function candidatesFor(
  fips: string,
  opts: {
    includePatterns?: boolean;
    /**
     * Domains taken from a county contact's email address.
     *
     * Passed in rather than looked up because they live in the database, on
     * `auctions.logistics`, and this module is deliberately static — it reads
     * the atlas and nothing else so it can be exercised without a connection.
     */
    contactDomains?: string[];
  } = {},
): SourceCandidate[] {
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

  /*
   * The county's own mail domain, ahead of anything generated.
   *
   * 42 of the counties in this set list `publicrecords.onlinesearches.com` as
   * their source — a records directory that was never a county source — while
   * carrying a contact address like `swhitehead@grantcountyar.com` that names
   * the real domain. The pattern generator cannot produce `grantcountyar.com`
   * from "Grant County, AR"; the county already told us.
   */
  for (const domain of opts.contactDomains ?? []) {
    const clean = domain.trim().toLowerCase().replace(/^www\./, "");
    if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) continue;
    /* Checked here as well as at the call site: a free host reaching this far
       would rank a mail provider's homepage above the county's own. */
    if (isFreeMailDomain(clean)) continue;
    push(`https://${clean}/`, "contact_email", `domain of a county contact's email`);
  }

  // Statewide publishers: one URL serving every county in the state. Highest
  // leverage available — Arkansas, West Virginia and New Mexico each run their
  // sales centrally, and West Virginia's is a results page.
  for (const c of statewideCandidatesFor(county)) {
    push(c.url, c.origin, c.label);
  }

  // Generated county domains. These are homepages, not sale pages, so they only
  // become sources via the two-stage discovery in `verify.ts`.
  if (opts.includePatterns) {
    for (const url of countyDomainPatterns(county)) {
      push(url, "platform_pattern", "generated county domain (probe)");
    }
  }

  return out;
}

/** Counties that already carry researched links — the high-yield set. */
export function countiesWithAtlasLinks(): string[] {
  return Object.keys(COUNTY_DATA).filter((fips) =>
    candidatesFor(fips).some((c) => c.origin === "atlas"),
  );
}
