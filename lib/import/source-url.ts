/**
 * The citation an imported sale gets: a county page, never the aggregator.
 *
 * `auctions.source_url` is NOT NULL because a row nobody can trace back to
 * what published it is not worth storing. For rows that arrive by calendar
 * import that used to mean the exporter's own auction page — one URL per row,
 * on a subscription host, which is neither where the sale was published nor
 * somewhere a bidder can read it. 559 of 826 auctions carried one.
 *
 * The county published the sale. So the citation is rebuilt from sources that
 * lead there, in descending order of how specific each one is to *this* sale:
 *
 *   1. The sale's own auction site, which the export already carried per row
 *      in `Online Site (Deed|Lien|Foreclosure)` — polk.realtaxdeed.com for a
 *      Polk County FL deed sale. This is the actual official listing.
 *   2. The county's tax collector page from the researched rules atlas.
 *   3. A county office page from the crawled OnlineSearches directory —
 *      delinquent tax first, then foreclosure, collector, tax portal,
 *      recorder, assessor.
 *   4. Clerk of court, then the platform the county sells on.
 *   5. The county's own page in the OnlineSearches directory — a list of that
 *      county's official record sites. Weakest of the five, and still a real
 *      per-county page rather than a paywall.
 *
 * Tier 5 is why this returns a string and not null: every U.S. county has a
 * directory page, so every row gets a citation and the NOT NULL holds without
 * anything being invented. The `tier` comes back with the URL so a caller can
 * report the mix rather than presenting all five as equally direct.
 */
import { COUNTY_DATA } from "@/lib/atlas/county-rules";
import directory from "@/data/county-directory.json";
import { pickLink, countyPageUrl, type CountyDirectory } from "@/lib/directory/onlinesearches";

const DIRECTORY = directory as unknown as Record<string, CountyDirectory>;

/** Where a resolved URL came from, for reporting. Ordered best to weakest. */
export type SourceTier =
  | "sale_site"
  | "atlas_collector"
  | "directory_office"
  | "atlas_office"
  | "directory_county";

export interface ResolvedSource {
  url: string;
  tier: SourceTier;
  /** Human label for the ledger the migration writes. */
  label: string;
}

export interface SourceInput {
  countyFips: string;
  /** 2-letter postal abbreviation. */
  state: string;
  countyName: string;
  /** The exported row, when there is one — tier 1 lives in here. */
  raw?: Record<string, unknown> | null;
}

/**
 * The per-row auction site the export already carried.
 *
 * Deed before lien before foreclosure only because a row that has more than
 * one is a county running more than one kind of sale, and the deed sale is the
 * one these imports are overwhelmingly about.
 */
function saleSite(raw: Record<string, unknown> | null | undefined): string | null {
  for (const key of ["Online Site (Deed)", "Online Site (Lien)", "Online Site (Foreclosure)"]) {
    const v = String(raw?.[key] ?? "").trim();
    if (/^https?:\/\//i.test(v)) return v;
  }
  return null;
}

export function resolveSourceUrl(input: SourceInput): ResolvedSource {
  const rules = COUNTY_DATA[input.countyFips];
  const dir = DIRECTORY[input.countyFips];

  const site = saleSite(input.raw);
  if (site) return { url: site, tier: "sale_site", label: "county sale site" };

  const collector = rules?.taxCollector;
  if (collector?.url) {
    return { url: collector.url, tier: "atlas_collector", label: collector.label };
  }

  /*
   * Ordered by how close the office is to the sale itself. The last two are a
   * long way from it — an assessor's parcel search is not where a tax sale is
   * advertised — but they are still that county's own site, which beats
   * handing a bidder a third-party records directory in tier 5.
   */
  const OFFICES = [
    "delinquent",
    "foreclosure",
    "collector",
    "tax_portal",
    "recorder",
    "assessor",
  ] as const;
  for (const kind of OFFICES) {
    const hit = pickLink(dir, kind);
    if (hit) return { url: hit.url, tier: "directory_office", label: hit.label };
  }

  for (const ref of [rules?.clerkOfCourt, rules?.auctionPlatform, rules?.propertyAppraiser]) {
    if (ref?.url) return { url: ref.url, tier: "atlas_office", label: ref.label };
  }

  return {
    url: countyPageUrl(input.state, input.countyName),
    tier: "directory_county",
    label: `${input.countyName} County public records directory`,
  };
}
