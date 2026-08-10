/**
 * County office links, read from the OnlineSearches public-records directory.
 *
 * `lib/property/assessor-links.ts` is hand-authored: a switch on FIPS with a
 * URL builder per county, a handful of Florida counties deep. It is correct
 * where it exists and absent for the other three thousand, which is why most
 * lot pages offer a Google Maps search instead of the county's own assessor.
 * This module is where the rest come from.
 *
 * OnlineSearches is one of two directories with a readable robots.txt (see
 * `lib/ingest/policy.ts`). It is the one used here because NETR Online, the
 * better-known of the two, renders its county lists client-side: its
 * `/state/XX` pages serve 94 links, all of them navigation, and not one county
 * — verified 2026-08-10. A directory that requires a browser to read is not a
 * directory this fetcher can use, and running a headless browser at a host to
 * get around that is not a thing a crawl-delay makes polite.
 *
 * Nothing here fetches. `politeFetch` does that, which is what keeps the
 * policy layer, robots and the 5s delay in the path — this module only builds
 * URLs and parses what comes back.
 */
const BASE = "https://www.publicrecords.onlinesearches.com";

/**
 * What a link is for.
 *
 * `foreclosure` and `delinquent` are the two that matter beyond deep links:
 * they point at the page a county publishes its tax sale on, which is the
 * thing the prospector spends its time looking for.
 */
export type OfficeKind =
  | "assessor"
  | "collector"
  | "recorder"
  | "gis"
  | "tax_portal"
  | "foreclosure"
  | "delinquent"
  | "other";

export interface OfficeLink {
  kind: OfficeKind;
  label: string;
  url: string;
  /**
   * True when the host is a .gov/.us domain.
   *
   * Recorded rather than filtered on, because plenty of real county offices
   * are not — but where a county offers both, the government one is the source
   * of record and consumers should prefer it.
   */
  gov: boolean;
}

export interface CountyDirectory {
  fips: string;
  state: string;
  county: string;
  sourceUrl: string;
  links: OfficeLink[];
}

/**
 * The directory's own URL shape: `/AR_Washington.htm`.
 *
 * Deliberately not the alphabetical `/AR-A.htm` index pages — those are the
 * ones robots.txt disallows. The per-county pages are permitted, and this
 * builds them directly so nothing ever needs to walk the blocked index.
 */
export function countyPageUrl(state: string, countyName: string): string {
  // The directory spells county names without their noun and with spaces as
  // underscores: "St. Francis" → "St._Francis".
  const bare = countyName
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|City and Borough)$/i, "")
    .trim()
    .replace(/\s+/g, "_");
  return `${BASE}/${state.toUpperCase()}_${bare}.htm`;
}

/*
 * Label patterns, most specific first.
 *
 * Order matters and the first two are why: "Recorder, Circuit Clerk and
 * Judicial Foreclosures" contains both "recorder" and "foreclosure", and it is
 * a recorder — the office — rather than a page listing foreclosure sales.
 * Matching foreclosure first would file every Arkansas circuit clerk under the
 * heading the prospector reads as "here are the sales".
 */
const RULES: { kind: OfficeKind; test: RegExp }[] = [
  { kind: "recorder", test: /\brecorder\b|circuit clerk|register of deeds|recorded document/i },
  { kind: "assessor", test: /\bassessor\b|property appraiser|\bappraisal district\b/i },
  { kind: "delinquent", test: /delinquent/i },
  { kind: "foreclosure", test: /foreclosure|tax sale|tax deed|sheriff sale|land sale/i },
  { kind: "tax_portal", test: /pay (property )?tax|property tax (search|search and pay)/i },
  { kind: "collector", test: /tax collector|\bcollector\b|treasurer/i },
  { kind: "gis", test: /\bgis\b|parcel map|mapping|plat/i },
];

export function classifyLabel(label: string): OfficeKind {
  for (const r of RULES) if (r.test.test(label)) return r.kind;
  return "other";
}

/** Anchor tags, with their text, in document order. */
function anchors(html: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = decodeEntities(m[2].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (label) out.push({ url: m[1], label });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Affiliate and reference noise, however governmental the label looks.
 *
 * This is a drop list rather than a keep list, and that is a correction. The
 * first version kept only `.gov`/`.us` hosts on the theory that a county
 * office lives on a government domain. Arkansas County, Arkansas disproves it
 * in one page: its circuit clerk is `arcocircuitclerk.com` and its parcel data
 * is `arcountydata.com`. A TLD keep-list silently discarded both and reported
 * the county as having no offices at all — the crawl looked clean and returned
 * nothing.
 *
 * So the label decides what a link *is*, and the host only decides what is
 * definitely not an office. `census.gov` earns its place here for the same
 * reason: a .gov that is not a county office.
 */
const DROP_HOST =
  /intelius|goodhire|obitsarchive|wikipedia|ftc\.gov|census\.gov|onlinesearches|facebook|twitter|linkedin/i;

/** Government sources of record, preferred wherever a county offers both. */
const GOV_HOST = /\.(gov|us)(\/|$|:)/i;

/**
 * Parse one county page into classified office links.
 *
 * Returns links deduped by URL, keeping the first (most specific) label. Only
 * the kinds this product acts on are returned; "other" is dropped rather than
 * stored, because a county directory full of inmate rosters and election
 * results is noise in every consumer that reads it.
 */
export function parseCountyPage(opts: {
  html: string;
  fips: string;
  state: string;
  county: string;
  sourceUrl: string;
}): CountyDirectory {
  const seen = new Set<string>();
  const links: OfficeLink[] = [];

  for (const a of anchors(opts.html)) {
    if (!/^https?:\/\//i.test(a.url)) continue;
    if (DROP_HOST.test(a.url)) continue;
    if (a.label.length > 80) continue;

    const kind = classifyLabel(a.label);
    if (kind === "other") continue;
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    links.push({ kind, label: a.label, url: a.url, gov: GOV_HOST.test(a.url) });
  }

  return {
    fips: opts.fips,
    state: opts.state,
    county: opts.county,
    sourceUrl: opts.sourceUrl,
    links,
  };
}

/** Directory entries keyed by FIPS, as written to `data/county-directory.json`. */
export type DirectoryFile = Record<string, CountyDirectory>;

/**
 * Best link of a kind for a county, or null.
 *
 * Prefers a government host where the county offers both, which is the same
 * preference `lib/ingest/policy.ts` applies to fetching: the county is the
 * legal publisher, and a vendor page can go away or start charging.
 */
export function pickLink(entry: CountyDirectory | undefined, kind: OfficeKind): OfficeLink | null {
  const of = entry?.links.filter((l) => l.kind === kind) ?? [];
  return of.find((l) => l.gov) ?? of[0] ?? null;
}
