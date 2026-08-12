/**
 * CAPE Component Two — source verification.
 *
 * The workflow's rule is that official county and government sources outrank
 * private or secondary ones, and that a researcher should be able to see which
 * kind they are looking at. This turns that into a tier a page can render and a
 * report can count.
 *
 * A TLD test is not enough, and getting that wrong is the whole reason this
 * file is separate from `isGovernmentSource` in `lib/ingest/policy.ts`. That
 * helper asks whether a host ends in `.gov` or `.us`, which is the right
 * question for crawl policy and the wrong one here: `cosl.org` is the Arkansas
 * Commissioner of State Lands, a state agency that is the statutory seller for
 * all 75 Arkansas counties and the source behind 6,063 of our parcels. On a
 * TLD test it reads as private. So does `franklinmo.org`, and so does
 * `calhounclerk.com`.
 *
 * The tiers are ordered by how close the publisher sits to the legal authority
 * for the sale, which is what a bidder is actually asking when they ask where a
 * number came from.
 */

export type SourceTier =
  /** The office that holds the sale, or the state agency that runs it. */
  | "government"
  /**
   * A law firm publishing the notice as counsel to the taxing unit.
   *
   * Not a vendor and not the county. Texas delinquent-tax firms publish sale
   * lists as a statutory public-notice function, so the list is authoritative
   * even though the domain is commercial.
   */
  | "statutory_agent"
  /** A platform or servicer the county hired to run the sale. */
  | "contracted_vendor"
  /** Not recognised. Never assumed to be official. */
  | "unverified";

export interface SourceClassification {
  tier: SourceTier;
  host: string;
  /** Why this tier — shown in the UI rather than left implicit. */
  basis: string;
}

/**
 * Hosts whose standing is a fact about who they are, not about their domain.
 *
 * Kept explicit rather than inferred. Every entry is a source we actually
 * ingest from, so the list stays short and reviewable, and anything unlisted
 * falls to the heuristics below and then to `unverified` — never to a guess.
 */
const KNOWN: { match: RegExp; tier: SourceTier; basis: string }[] = [
  {
    match: /(^|\.)cosl\.org$/i,
    tier: "government",
    basis: "Arkansas Commissioner of State Lands — the statutory seller for all 75 counties",
  },
  {
    match: /(^|\.)tax\.newmexico\.gov$/i,
    tier: "government",
    basis: "New Mexico Taxation and Revenue Department — the agency that conducts the sale",
  },
  {
    match: /(^|\.)taxsales\.lgbs\.com$/i,
    tier: "statutory_agent",
    basis: "Linebarger Goggan Blair & Sampson, publishing Texas sale lists as counsel to the taxing units",
  },
  {
    match: /(^|\.)mvbalaw\.com$/i,
    tier: "statutory_agent",
    basis: "McCreary Veselka Bragg & Allen, publishing Texas sale lists as counsel to the taxing units",
  },
  {
    match: /(^|\.)franklinmo\.org$/i,
    tier: "government",
    basis: "Franklin County, Missouri — the county government's own site",
  },
  {
    match: /(^|\.)tax-sale\.info$/i,
    tier: "contracted_vendor",
    basis: "Title Check LLC, the vendor Michigan counties contract to host foreclosure sales",
  },
  {
    match: /(^|\.)sriservices\.com$|(^|\.)zeusauction\.com$/i,
    tier: "contracted_vendor",
    basis: "SRI Inc., contracted sale agent, bidding hosted on Zeus",
  },
  {
    match: /(^|\.)govease\.com$|(^|\.)bid4assets\.com$|(^|\.)realtaxdeed\.com$|(^|\.)realforeclose\.com$/i,
    tier: "contracted_vendor",
    basis: "Commercial auction platform",
  },
];

/**
 * Government by domain shape.
 *
 * `.gov` and `.us` are unambiguous. Beyond those, only one shape is inferred:
 * a host named for an office, like `calhounclerk.com`. It has to *end* in the
 * office word so that a title company called "Jefferson County Abstract" is not
 * promoted for merely containing one.
 *
 * A county on a bare `.org` — `franklinmo.org` — is deliberately not inferred.
 * Any pattern loose enough to catch it is loose enough to catch a private site,
 * and labelling a vendor as the government is the expensive direction of the
 * error. Those go in the reviewed list above; everything unrecognised falls to
 * `unverified`, which is a prompt to look rather than a verdict.
 */
const GOV_TLD = /\.(gov|us)$/i;
const GOV_SHAPED = /^(www\.)?[a-z]+(clerk|treasurer|assessor|collector|sheriff|county)\.(com|org|net)$/i;

export function classifySource(url: string | null | undefined): SourceClassification {
  const host = hostOf(url);
  if (!host) {
    return { tier: "unverified", host: "", basis: "No source URL recorded for this auction" };
  }

  for (const k of KNOWN) {
    if (k.match.test(host)) return { tier: k.tier, host, basis: k.basis };
  }
  if (GOV_TLD.test(host)) {
    return { tier: "government", host, basis: "Government domain" };
  }
  if (GOV_SHAPED.test(host)) {
    return { tier: "government", host, basis: "County office domain" };
  }
  return {
    tier: "unverified",
    host,
    basis: "Not a recognised county office, statutory agent or contracted vendor",
  };
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Ranked best-first, so a report can sort or threshold on it. */
export const TIER_RANK: Record<SourceTier, number> = {
  government: 0,
  statutory_agent: 1,
  contracted_vendor: 2,
  unverified: 3,
};

export const TIER_LABEL: Record<SourceTier, string> = {
  government: "Government source of record",
  statutory_agent: "Statutory publishing agent",
  contracted_vendor: "Contracted vendor",
  unverified: "Unverified source",
};
