/**
 * County list pages found at runtime, merged into the Prospector's registry.
 *
 * The registry the crawler reads is a committed file, `data/source-registry.json`,
 * and it changes only with a commit and a redeploy. That is right for what the
 * Prospector writes — reviewed, version-controlled source-of-record research —
 * and wrong for a list the Auction Scout finds on a Sunday: the sale it belongs
 * to is days away, and nothing would crawl it until a developer shipped a file.
 *
 * So `county_sources` holds those pages, and `mergeCountySources` lays them over
 * the file's registry, ahead of the county's existing sources. A county the file
 * marked as a gap — no government source found — stops being one. Everything
 * that reads the registry through `loadRegistry` sees the merged view: the
 * generic adapter's bindings, the planner's source index, import enrichment.
 *
 * Rows are loaded into memory by `primeCountySources`, the same way policy
 * overrides are: whatever is about to do ingest work loads them first, and a
 * process that never does sees exactly the committed file.
 */
import { eq, sql } from "drizzle-orm";
import { countySources, type CountySource } from "../db/schema";
import type { SourceKind, SourceRegistry, VerifiedSource } from "../prospector/types";
import { getCounty } from "../atlas";
import { policyFor } from "./policy";

let rows: CountySource[] = [];
let loadedAt = 0;
/** Bumped on every load, so the merged registry is rebuilt only when rows change. */
let version = 0;
/** Re-read at most this often; the table changes a few times a week. */
const TTL_MS = 60_000;

export async function primeCountySources(opts: { force?: boolean } = {}): Promise<number> {
  if (!opts.force && Date.now() - loadedAt < TTL_MS) return rows.length;
  /* Imported here, not at the top: the generic adapter loads this module, and
   * its unit tests run without a database. */
  const { db } = await import("../db");
  rows = await db.select().from(countySources).where(eq(countySources.enabled, true));
  loadedAt = Date.now();
  version++;
  return rows.length;
}

export const countySourcesVersion = () => version;

const hostOf = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};
const isGovernment = (host: string) => /\.(gov|us)$/.test(host) || /\.(gov|us)\./.test(host);

/**
 * The registry with runtime sources laid over it. Pure: the input is not changed.
 */
export function mergeCountySources(base: SourceRegistry, extra: CountySource[] = rows): SourceRegistry {
  if (extra.length === 0) return base;
  const counties = { ...base.counties };
  for (const r of extra) {
    const county = getCounty(r.countyFips);
    const entry = counties[r.countyFips] ?? {
      state: county?.state ?? "",
      county: county?.name ?? "",
      sources: [],
      isGap: true,
    };
    if (entry.sources.some((s) => s.url === r.url)) continue;
    const host = hostOf(r.url);
    const source: VerifiedSource = {
      fips: r.countyFips,
      state: entry.state,
      url: r.url,
      host,
      origin: "auction_scout",
      kind: r.kind as SourceKind,
      isGovernment: isGovernment(host),
      confidence: 0.75,
      signals: [r.origin],
      verifiedOn: r.updatedAt.toISOString().slice(0, 10),
      httpStatus: 0,
    };
    counties[r.countyFips] = { ...entry, sources: [source, ...entry.sources], isGap: false };
  }
  return { ...base, counties };
}

export type RecordSourceOutcome = "added" | "known" | `refused: ${string}`;

/**
 * Record a county's list page, unless policy forbids fetching it.
 *
 * A link in a report is not permission to fetch it: hosts the crawler has been
 * told to leave alone — capture-only platforms, robots refusals — are refused
 * here rather than queued and refused at fetch time, where the refusal is
 * harder to see.
 */
export async function recordCountySource(input: {
  countyFips: string;
  url: string;
  origin: string;
  note?: string;
  addedBy?: string;
}): Promise<RecordSourceOutcome> {
  const host = hostOf(input.url);
  if (!host || !/^https?:$/.test(new URL(input.url).protocol)) return "refused: not a web address";
  const policy = policyFor(host);
  if (policy && policy.decision !== "allow") return `refused: ${host} is ${policy.decision} (${policy.reason})`;

  const { db } = await import("../db");

  const inserted = await db
    .insert(countySources)
    .values({
      countyFips: input.countyFips,
      url: input.url,
      origin: input.origin,
      note: input.note ?? null,
      addedBy: input.addedBy ?? "system",
    })
    .onConflictDoUpdate({
      target: [countySources.countyFips, countySources.url],
      set: { updatedAt: sql`now()` },
    })
    .returning({ created: sql<boolean>`(xmax = 0)` });
  if (inserted[0]?.created) loadedAt = 0;
  return inserted[0]?.created ? "added" : "known";
}
