/**
 * Source Prospector — locate and verify each county's source of record.
 *
 * This is the bottleneck for national coverage. Adapters, world models and
 * schedules are all worthless for a county whose publishing URL is unknown, and
 * the standing resolution to the RealAuction policy block — prefer the
 * government source of record — only works once that source has been found.
 *
 * Output is a registry written to `data/source-registry.json`, reviewed and
 * committed like the atlas rather than written to Postgres. A county's tax
 * collector URL changes rarely and matters enormously when it does.
 */

import { getCounty } from "../atlas";
import { candidatesFor, countiesWithAtlasLinks } from "./discover";
import type {
  ProspectResult,
  RejectedCandidate,
  SourceRegistry,
  VerifiedSource,
} from "./types";
import { newBudget, verifyCandidate } from "./verify";

export * from "./types";
export { candidatesFor, countiesWithAtlasLinks } from "./discover";
export { inferKind, scoreContent, verifyCandidate } from "./verify";

/**
 * Rank one verified source against another for the same county.
 *
 * Government publishers dominate deliberately, and by a margin no confidence
 * score can close. That is the whole resolution to the RealAuction policy
 * block — the clerk is the legal publisher of the sale list, and a slicker
 * vendor page scoring higher on vocabulary does not change who the source of
 * record is. A kind match breaks ties below that, confidence below that.
 */
function rank(s: VerifiedSource, preferKind?: VerifiedSource["kind"]): number {
  return (
    (s.isGovernment ? 100 : 0) +
    (preferKind
      ? s.kind === preferKind
        ? 25
        : 0
      : s.kind === "listing"
        ? 10
        : s.kind === "results"
          ? 8
          : 0) +
    s.confidence * 10
  );
}

export interface ProspectOptions {
  useLlm?: boolean;
  /** Probe generated county domains. Off by default — most will not resolve. */
  includePatterns?: boolean;
  /** Total fetches allowed for this county across all candidates and hops. */
  fetchBudget?: number;
  /** Stop after this many candidates per county. */
  maxCandidates?: number;
  /** Report intent without fetching anything. */
  dryRun?: boolean;
}

/**
 * Prospect one county.
 *
 * `dryRun` returns the candidate plan without a single network request, which
 * is how this should be exercised in tests and in review — the live path talks
 * to government servers and deserves to be looked at before it runs.
 */
export async function prospectCounty(
  fips: string,
  opts: ProspectOptions = {},
): Promise<ProspectResult> {
  const county = getCounty(fips);
  if (!county) {
    return {
      fips,
      state: "",
      county: "",
      verified: [],
      rejected: [],
      isGap: true,
      note: "Unknown FIPS.",
    };
  }

  const candidates = candidatesFor(fips, {
    includePatterns: opts.includePatterns,
  }).slice(0, opts.maxCandidates ?? 8);

  if (opts.dryRun) {
    return {
      fips,
      state: county.state,
      county: county.name,
      verified: [],
      rejected: [],
      isGap: candidates.length === 0,
      note:
        candidates.length === 0
          ? "No candidates: county has no researched links and no state platform."
          : `Dry run — would verify ${candidates.length} candidate(s): ${candidates
              .map((c) => c.url)
              .join(", ")}`,
    };
  }

  const verified: VerifiedSource[] = [];
  const rejected: RejectedCandidate[] = [];
  // One allowance for the whole county, shared across every candidate and every
  // hop, so a county with many generated domains cannot cost more than one with
  // a single researched link.
  const budget = newBudget(opts.fetchBudget ?? 12);

  for (const candidate of candidates) {
    const result = await verifyCandidate(candidate, { useLlm: opts.useLlm, budget });
    if (budget.remaining <= 0 && "reason" in result) { rejected.push(result); break; }
    // One good government source is enough; probing the remaining generated
    // domains for a county we have already resolved is pure waste.
    if (!("reason" in result)) {
      verified.push(result);
      if (result.isGovernment && result.confidence >= 0.7) break;
      continue;
    }
    rejected.push(result);
    continue;
  }

  verified.sort((a, b) => rank(b) - rank(a));

  const hasGovSource = verified.some((v) => v.isGovernment);
  const blocked = rejected.filter((r) => r.reason === "policy_blocked");

  return {
    fips,
    state: county.state,
    county: county.name,
    verified,
    rejected,
    isGap: verified.length === 0,
    note: verified.length
      ? hasGovSource
        ? `${verified.length} verified, government source of record present.`
        : `${verified.length} verified, but none on a government host — prefer finding the clerk or tax collector.`
      : blocked.length
        ? `No usable source: ${blocked.length} candidate(s) policy-blocked. Visible on /coverage as blocked, not missing.`
        : "No usable source found.",
  };
}

/**
 * Prospect many counties.
 *
 * Defaults to the counties that already carry researched atlas links, because
 * those are the highest-yield set and cost the least to confirm. Sequential by
 * design — `politeFetch` enforces per-host delays, and parallelising across
 * counties that share a host would defeat them.
 */
export async function prospectCounties(
  fipsList?: readonly string[],
  opts: ProspectOptions = {},
): Promise<ProspectResult[]> {
  const targets = fipsList ?? countiesWithAtlasLinks();
  const out: ProspectResult[] = [];
  for (const fips of targets) {
    out.push(await prospectCounty(fips, opts));
  }
  return out;
}

/** Fold results into the persisted registry shape. */
export function buildRegistry(results: ProspectResult[]): SourceRegistry {
  const counties: SourceRegistry["counties"] = {};
  let nVerified = 0;
  let nGaps = 0;

  for (const r of results) {
    counties[r.fips] = {
      state: r.state,
      county: r.county,
      sources: r.verified,
      isGap: r.isGap,
    };
    nVerified += r.verified.length;
    if (r.isGap) nGaps++;
  }

  return {
    builtAt: new Date().toISOString(),
    nCounties: results.length,
    nVerified,
    nGaps,
    counties,
  };
}

/**
 * Merge a partial prospect run into an existing registry without deleting
 * other counties. Partial state runs used to overwrite the whole file with
 * 3 counties and wipe national coverage — this is the fix.
 *
 * New results win for the same FIPS (they are fresher). Untouched FIPS keep
 * their previous sources.
 */
export function mergeRegistry(
  base: SourceRegistry | null,
  patch: SourceRegistry,
): SourceRegistry {
  const counties: SourceRegistry["counties"] = {
    ...(base?.counties ?? {}),
    ...patch.counties,
  };
  let nVerified = 0;
  let nGaps = 0;
  for (const entry of Object.values(counties)) {
    nVerified += entry.sources.length;
    if (entry.isGap) nGaps++;
  }
  return {
    builtAt: new Date().toISOString(),
    nCounties: Object.keys(counties).length,
    nVerified,
    nGaps,
    counties,
  };
}

/**
 * The best source of a given kind for a county, for the Scout and Archivist.
 *
 * Ranks rather than taking the first match, so it does not depend on the stored
 * array order and cannot be made to prefer a vendor over the clerk by a lucky
 * sort. Falls back across kinds rather than returning nothing: a `listing`
 * request that finds only a `calendar` page is still a better lead than none.
 */
export function bestSource(
  registry: SourceRegistry,
  fips: string,
  kind: VerifiedSource["kind"],
): VerifiedSource | null {
  const entry = registry.counties[fips];
  if (!entry?.sources.length) return null;
  return [...entry.sources].sort((a, b) => rank(b, kind) - rank(a, kind))[0];
}

/** Coverage accounting, mirroring how the atlas reports inheritance honestly. */
export function registryCoverage(registry: SourceRegistry): {
  nCounties: number;
  nVerified: number;
  nGaps: number;
  govShare: number;
  byKind: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  let gov = 0;
  let total = 0;
  for (const entry of Object.values(registry.counties)) {
    for (const s of entry.sources) {
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
      if (s.isGovernment) gov++;
      total++;
    }
  }
  return {
    nCounties: registry.nCounties,
    nVerified: registry.nVerified,
    nGaps: registry.nGaps,
    govShare: total ? Math.round((gov / total) * 100) / 100 : 0,
    byKind,
  };
}
