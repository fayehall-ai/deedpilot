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
      "MO, MS, OK, PA, TN, TX, WA), so this is the single largest blocked surface after RealAuction. " +
      "The marketing site (www.govease.com) is permissive but carries no parcel data. Correct paths " +
      "are a data agreement, or the county's own published list where one exists.",
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
  {
    host: "govease.com",
    decision: "allow",
    minDelayMs: 3000,
    reason: "robots.txt restricts only HubSpot preview paths; public auction listings are permitted.",
  },
  {
    host: "bid4assets.com",
    decision: "allow",
    minDelayMs: 3000,
    reason: "No robots.txt served. Rate-limited conservatively; public listing pages only.",
  },
];

/** Government sources of record — always preferred, always polite. */
const GOV_SUFFIXES = [".gov", ".us"];

export function isGovernmentSource(host: string): boolean {
  return GOV_SUFFIXES.some((s) => host.endsWith(s));
}

export function policyFor(host: string): SourcePolicy | null {
  const h = host.toLowerCase();
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
