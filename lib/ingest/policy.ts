/**
 * Access policy for ingestion sources.
 *
 * Why this exists as a first-class module rather than a comment:
 * realtaxdeed.com and realforeclose.com (RealAuction) publish
 * `User-agent: * / Disallow: /`. RealAuction hosts most of Florida's tax deed
 * sales plus Dallas TX and Pima/Pinal AZ — i.e. a large share of the exact
 * data this product needs. Ignoring that is not a technical decision to make
 * silently in a fetch helper.
 *
 * The resolution is architectural: prefer the *government source of record*.
 * County clerks and tax collectors are the legal publishers of tax sale lists
 * (public records), their sites are robots-permissive, and they are not
 * behind a platform's terms of service. Auction platforms are used for live
 * bid state only, and only where policy allows or an agreement exists.
 */

export type PolicyDecision = "allow" | "deny" | "requires_agreement";

export interface SourcePolicy {
  /** Hostname or hostname suffix this rule covers. */
  host: string;
  decision: PolicyDecision;
  /** Minimum milliseconds between requests to this host. */
  minDelayMs: number;
  reason: string;
}

/**
 * Explicit, reviewed policy per source. Anything not listed falls back to
 * live robots.txt evaluation (see `checkRobots`), defaulting to polite.
 *
 * Set an entry to "requires_agreement" rather than "deny" when the data is
 * genuinely needed and a commercial/official data agreement is the correct
 * path — that keeps the county visible in the coverage UI as "blocked,
 * pending agreement" instead of quietly missing.
 */
export const SOURCE_POLICIES: SourcePolicy[] = [
  {
    host: "realtaxdeed.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "RealAuction robots.txt is `Disallow: /`. Florida tax deed lists are public records available " +
      "directly from each county Clerk of Court — ingest those instead. Use RealAuction only under a " +
      "data agreement or the subscriber's own authenticated session.",
  },
  {
    host: "realforeclose.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason: "Same RealAuction platform and robots policy as realtaxdeed.com.",
  },
  {
    host: "govease.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "liveauctions.govease.com/robots.txt is `User-agent: * / Disallow: /` — verified 2026-08-05. " +
      "GovEase is the widest-reach platform in the researched set (59 counties across AL, CA, IA, IN, " +
      "MO, MS, OK, PA, TN, TX, WA). The data itself is public — no login — but this entry stays " +
      "`requires_agreement` so nothing in the ingest path can crawl it by default. The `govease` " +
      "adapter takes the browser-capture route instead: pages are opened in the operator's own " +
      "browser and read from data/govease-capture/, and the adapter imports node:fs rather than " +
      "politeFetch, so there is no code path from it to this host. See docs/govease-capture.md.",
  },
  {
    host: "bid4assets.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "Returns 403 Access Denied on robots.txt itself — verified 2026-08-05 — so the crawl posture " +
      "cannot even be read without defeating an active edge control. Same stance as RealAuction. " +
      "40 counties across CA, FL, LA, NV, PA, WA.",
  },
  {
    host: "tax-sale.info",
    decision: "allow",
    minDelayMs: 2000,
    reason: "Title Check LLC, Michigan's county foreclosure auction host. robots.txt permits crawling.",
  },
  {
    host: "cosl.org",
    decision: "allow",
    minDelayMs: 2000,
    reason:
      "Arkansas Commissioner of State Lands, the statutory publisher of every tax-delinquent sale in " +
      "the state (A.C.A. §26-37-101 et seq.). Serves no robots.txt. Government source of record.",
  },
  {
    host: "sriservices.com",
    decision: "allow",
    minDelayMs: 2000,
    reason:
      "SRI Inc, contracted sale agent for Indiana and other county tax sales. robots.txt is " +
      "`Disallow:` (empty — permits all). Verified 2026-08-05.",
  },
  {
    host: "taxsales.lgbs.com",
    decision: "allow",
    minDelayMs: 2000,
    reason:
      "Linebarger Goggan Blair & Sampson publishes Texas delinquent-tax sale lists as a public notice " +
      "function. robots.txt permits crawling.",
  },
  // Removed 2026-08-09: duplicate `allow` entries for govease.com and
  // bid4assets.com sat below the `requires_agreement` ones above. `policyFor`
  // returns the first match, so they never applied — but they recorded the
  // opposite conclusion from the same file, and a reordering or a switch to
  // last-match-wins would have silently started crawling two hosts the project
  // had decided not to. The earlier belief ("robots.txt restricts only HubSpot
  // preview paths") was superseded by the 2026-08-05 verification that
  // liveauctions.govease.com serves `User-agent: * / Disallow: /`.
  {
    host: "tax.newmexico.gov",
    decision: "allow",
    minDelayMs: 2000,
    reason:
      "New Mexico Taxation and Revenue Department — the state agency that conducts these sales, " +
      "publishing the statutory notices required by NMSA 1978 § 7-38-65. robots.txt is " +
      "`User-agent: * / Disallow:` (empty Disallow — everything permitted), verified 2026-08-09. " +
      "This is the government source of record, which is the route the policy prefers; the " +
      "notices are 300KB+ PDFs, hence the delay despite the permission.",
  },

  // --- Parcel-data aggregators and record directories, added 2026-08-10 -----
  //
  // None of these four publishes a tax sale list. Two are directories of links
  // to county assessor/recorder/GIS sites, and two are commercial parcel-data
  // products. They belong to the *discovery* and *enrichment* paths, never to
  // the auction ingest path — an adapter pointed at one of them would produce
  // parcels that are not for sale, which is the failure `listing_kind` exists
  // to catch. The entries are here because policy is decided per host, before
  // anyone writes the code that fetches.
  {
    host: "datascoutpro.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "Serves an Azure WAF JavaScript challenge on every request including /robots.txt, which " +
      "returns HTTP 403 — verified 2026-08-10. The crawl posture cannot be read without executing " +
      "the challenge, i.e. without defeating an active edge control, so the same stance as " +
      "bid4assets applies. DataScout resells county assessor data that is a public record at " +
      "source; where a specific county's parcel data is needed, go to that county's assessor " +
      "instead. A subscription here comes with terms, and those terms are the route in.",
  },
  {
    host: "propwire.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "Behind DataDome bot detection — /robots.txt returns HTTP 403 with a captcha-delivery " +
      "challenge, verified 2026-08-10. Crawl posture unreadable without defeating the control. " +
      "Propwire is a free front end over a commercial property database; its value here would be " +
      "comps and AVM, which is the job ATTOM already does under an API key and a contract. Use an " +
      "account and a documented API, not the web app.",
  },
  {
    host: "publicrecords.netronline.com",
    decision: "allow",
    minDelayMs: 10_000,
    reason:
      "NETR Online's public records directory — per-county links to assessor, recorder, and GIS " +
      "sites. robots.txt explicitly keeps the state/county directory pages crawlable for SEO and " +
      "declares `Crawl-delay: 10`, which is where the 10s here comes from; verified 2026-08-10. " +
      "Denied entirely to named SEO scrapers, and off-limits under `*` are the dynamic search " +
      "endpoints (/search_results, /map_search, /zip_search, /city_state_search), the parcel and " +
      "map endpoints its own comments call the primary scraping targets (/map, /geo_image, " +
      "/parcel, /parcel_loc, /plss, /fetch_meridian_info), and the admin/user/stripe routes. " +
      "`politeFetch` reads those paths off live robots.txt, so this entry grants the host, not " +
      "those paths. Usable surface is /state/XX and the county pages under it.",
  },
  {
    host: "publicrecords.onlinesearches.com",
    decision: "allow",
    minDelayMs: 5000,
    reason:
      "OnlineSearches public records directory — same shape as NETR, per-county links to official " +
      "record sites. robots.txt is readable and permissive at the root, with the state indexes " +
      "(/arkansas, /michigan, …) allowed; verified 2026-08-10. Disallowed under `*`: /maps/, " +
      "/view/, the alphabetical /*-A.htm … /*-Z.htm listing pages, and any URL carrying stlinks, " +
      "guidelinks or cnguide query params — which is a meaningful share of the directory, so " +
      "expect to reach counties through the state pages rather than the A-Z indexes. No " +
      "Crawl-delay is declared; 5s is set here because this is a commercial aggregator rather " +
      "than a government source of record.",
  },
  {
    host: "ustla.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "uls.ustla.com/robots.txt is `User-agent: * / Disallow: /` — verified 2026-08-12. The auction " +
      "calendar also sits behind a paid subscription login, and the aggregated list of which " +
      "counties sell on a given day is the product US Tax Lien Association sells. Which counties " +
      "hold a sale is a public fact each county advertises under O.C.G.A. § 9-13-161, so use it as " +
      "a lead on where to look and take the parcels from the county's own site; do not copy the " +
      "calendar itself into this database.",
  },
  {
    host: "georgiapublicnotice.com",
    decision: "requires_agreement",
    minDelayMs: 5000,
    reason:
      "The statutory source of record for Georgia tax sales — O.C.G.A. § 9-13-140 requires the ad " +
      "to run in the county legal organ, and the Georgia Press Association aggregates all 159 " +
      "counties here with the full parcel list in the body. robots.txt reads `Allow: /`, which is " +
      "misleading: every notice detail page is behind a click-through agreement stating the reader " +
      "'may not use the content of this site in any database, compilation, archive or cache' and " +
      "'may not engage in ... screen scraping, database scraping, or spidering', plus a Cloudflare " +
      "challenge — verified 2026-08-12. Ingesting a notice is precisely the prohibited use, so " +
      "robots is not the governing document. This is the single highest-leverage Georgia source " +
      "and the correct path to it is a licence from the GPA, not a crawler.",
  },
];

/** Government sources of record — always preferred, always polite. */
const GOV_SUFFIXES = [".gov", ".us"];

export function isGovernmentSource(host: string): boolean {
  return GOV_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Operator overrides, loaded once per process.
 *
 * `policyFor` is called from inside `politeFetch` on every request, so it has
 * to stay synchronous — making it async to read a table would push `await`
 * through the whole fetch path for a value that changes perhaps twice a month.
 * Instead the overrides are loaded deliberately, by whatever is about to do
 * ingest work, and consulted from memory.
 *
 * A process that never calls `loadPolicyOverrides` sees exactly the decisions
 * in this file. That is the safe direction to fail: the code is the
 * conservative baseline, and an override can only be applied by something that
 * went looking for it.
 */
const overrides = new Map<string, SourcePolicy>();

export function setPolicyOverrides(rows: SourcePolicy[]): void {
  overrides.clear();
  for (const r of rows) overrides.set(r.host.toLowerCase(), r);
}

export function policyOverrideCount(): number {
  return overrides.size;
}

export function policyFor(host: string): SourcePolicy | null {
  const h = host.toLowerCase();
  // An override wins over the compiled-in decision for the same host, matched
  // on the same suffix rule so subdomains inherit either way.
  for (const [key, p] of overrides) {
    if (h === key || h.endsWith(`.${key}`)) return p;
  }
  return SOURCE_POLICIES.find((p) => h === p.host || h.endsWith(`.${p.host}`)) ?? null;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

const robotsCache = new Map<string, RobotsRules | null>();

/**
 * Minimal robots.txt parser covering the directives that actually appear on
 * these sources: User-agent, Allow, Disallow, Crawl-delay.
 *
 * Groups matching our UA token win over `*`; longest-match wins between an
 * Allow and a Disallow, per the usual convention.
 */
function parseRobots(text: string, uaToken: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { disallow: [], allow: [], crawlDelayMs: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === "disallow" && value) current.rules.disallow.push(value);
    else if (field === "allow" && value) current.rules.allow.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.rules.crawlDelayMs = n * 1000;
    }
  }

  const ua = uaToken.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  return specific?.rules ?? wildcard?.rules ?? { disallow: [], allow: [], crawlDelayMs: null };
}

/** Longest matching rule wins; Allow beats Disallow at equal length. */
function robotsPermits(rules: RobotsRules, path: string): boolean {
  const match = (patterns: string[]) =>
    patterns.reduce((best, p) => {
      // Only `*` and `$` are meaningful wildcards in robots.txt.
      const rx = new RegExp(
        "^" +
          p
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\\\$$/, "$"),
      );
      return rx.test(path) && p.length > best ? p.length : best;
    }, -1);

  const d = match(rules.disallow);
  const a = match(rules.allow);
  if (d === -1) return true;
  return a >= d;
}

export async function checkRobots(
  url: string,
  uaToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ allowed: boolean; crawlDelayMs: number | null }> {
  const u = new URL(url);
  const origin = u.origin;

  if (!robotsCache.has(origin)) {
    try {
      const res = await fetchImpl(`${origin}/robots.txt`, {
        headers: { "user-agent": uaToken },
        signal: AbortSignal.timeout(10_000),
      });
      // A non-200 (or an HTML 404 page, as Bid4Assets serves) means no stated
      // policy — treat as permissive but keep the conservative rate limit.
      const ct = res.headers.get("content-type") ?? "";
      robotsCache.set(
        origin,
        res.ok && !ct.includes("html") ? parseRobots(await res.text(), uaToken) : null,
      );
    } catch {
      robotsCache.set(origin, null);
    }
  }

  const rules = robotsCache.get(origin) ?? null;
  if (!rules) return { allowed: true, crawlDelayMs: null };
  return { allowed: robotsPermits(rules, u.pathname), crawlDelayMs: rules.crawlDelayMs };
}

/** Test seam — lets the policy tests start from a clean cache. */
export function __clearRobotsCache() {
  robotsCache.clear();
}
