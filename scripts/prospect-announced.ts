/**
 * Find sources for counties that have an announced sale and nowhere to crawl.
 *
 *   npm run prospect:announced -- --dry-run     # the target list, no requests
 *   npm run prospect:announced -- --limit 40    # the most urgent 40
 *   npm run prospect:announced                  # all of them, soonest sale first
 *
 * ## Why this target set is not the other two scripts'
 *
 * `prospect.ts` walks the counties carrying researched atlas links, and
 * `prospect-national.ts` walks the country round-robin. Both are the right
 * shape for building coverage in general and neither can express the set that
 * actually matters right now: *the counties holding a sale we know about and
 * cannot fetch*. That set only exists in the database — it is the announced
 * calendar minus everything already crawlable — so it is selected here.
 *
 * Ordered by soonest sale. A source found for a sale eleven days out can still
 * be crawled, priced and acted on; the same source found for a sale in October
 * can wait, and if the run is interrupted the work that survives should be the
 * urgent half.
 *
 * ## Why it writes as it goes
 *
 * Each county costs a web search and an LLM call, and several hundred of them
 * is a long run. `prospect.ts` writes once at the end, which is fine for a
 * handful and would throw away an hour of paid work here if the process died.
 * The registry is merged and flushed periodically and on the way out, so an
 * interrupted run keeps everything it found.
 */

import "../lib/env";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { buildRegistry, mergeRegistry, prospectCounty, registryCoverage } from "../lib/prospector";
import { isFreeMailDomain } from "../lib/prospector/discover";
import type { ProspectResult, SourceRegistry } from "../lib/prospector/types";

const OUT = "data/source-registry.json";
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

/** Flush every N counties. Small enough to lose little, large enough not to
 *  rewrite a 600KB file on every single county. */
const FLUSH_EVERY = 5;

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig} — finishing this county, flushing the registry, then stopping.`);
  });
}

function readRegistry(): SourceRegistry | null {
  if (!existsSync(OUT)) return null;
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as SourceRegistry;
  } catch {
    return null;
  }
}

function flush(base: SourceRegistry | null, results: ProspectResult[]): SourceRegistry {
  const patch = buildRegistry(results);
  const merged = base ? mergeRegistry(base, patch) : patch;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(merged, null, 2));
  return merged;
}

async function main(): Promise<void> {
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const dryRun = flag("dry-run");
  /*
   * Domain patterns on by default here, unlike everywhere else.
   *
   * `candidatesFor` draws on two things: links someone researched into the
   * atlas, and generated county-domain patterns that are off by default because
   * most do not resolve. This script's target set is *defined* by having no
   * researched link — that is why these counties have no source — so with
   * patterns off `candidatesFor` returns nothing and every county is an instant
   * gap. The first run did exactly that: 306 counties queued, five checked, five
   * "no source found", no fetch and no LLM call behind any of them.
   *
   * Patterns are the mechanism built for this case. They resolve a homepage
   * rather than a sale page, which `verify.ts` then crawls for the sale — a
   * homepage alone scores below the relevance threshold and is rejected, so a
   * wrong guess costs a fetch and is not mistaken for a source.
   */
  const includePatterns = !flag("no-patterns");

  const base = readRegistry();
  /* A county already carrying a verified source is not a gap and does not need
   * prospecting again — that is exactly the set the crawler can already serve. */
  const located = new Set(
    Object.entries(base?.counties ?? {})
      .filter(([, e]) => !e.isGap && e.sources.length > 0)
      .map(([fips]) => fips),
  );

  /*
   * Where each county's own mail domain comes from.
   *
   * The sale calendar names a person at the county and gives their address, and
   * the domain of that address is where the county actually publishes — stated
   * by the county rather than generated from its name. 42 of the counties in
   * this target set carry `publicrecords.onlinesearches.com` as their source,
   * which is a records directory that was never one, while holding a contact
   * like `swhitehead@grantcountyar.com` that names the real domain. No pattern
   * generator produces `grantcountyar.com` from "Grant County, AR".
   *
   * Free addresses are dropped: a clerk using gmail tells us nothing about
   * where the county publishes.
   */
  const contactDomains = new Map<string, string[]>();
  for (const r of (await db.execute(sql`
    SELECT county_fips, logistics -> 'contact' ->> 'email' AS email
    FROM auctions
    WHERE logistics -> 'contact' ->> 'email' IS NOT NULL
      AND sale_date >= current_date
  `)) as unknown as { county_fips: string; email: string }[]) {
    const domain = r.email.split("@")[1]?.toLowerCase().trim();
    if (!domain || isFreeMailDomain(domain)) continue;
    const list = contactDomains.get(r.county_fips) ?? [];
    if (!list.includes(domain)) list.push(domain);
    contactDomains.set(r.county_fips, list);
  }
  console.log(`${contactDomains.size} county/counties carry a usable contact domain`);

  const rows = (await db.execute(sql`
    SELECT a.county_fips,
           c.name  AS county,
           c.state AS state,
           min(a.sale_date)::text                  AS soonest,
           count(*)::int                            AS sales,
           coalesce(sum(a.announced_parcel_count), 0)::int AS parcels
    FROM auctions a
    JOIN counties c ON c.fips = a.county_fips
    WHERE a.announced_parcel_count > 0
      AND a.lot_count = 0
      AND a.sale_date >= current_date
      AND a.delisted_at IS NULL
    GROUP BY 1, 2, 3
    ORDER BY min(a.sale_date) ASC
  `)) as unknown as {
    county_fips: string;
    county: string;
    state: string;
    soonest: string;
    sales: number;
    parcels: number;
  }[];

  const targets = rows.filter((r) => !located.has(r.county_fips)).slice(0, limit ?? rows.length);

  console.log(
    `${rows.length} counties have an announced sale with no parcel list; ` +
      `${rows.length - targets.length} already have a located source.`,
  );
  console.log(
    `prospecting ${targets.length}, soonest sale first` + (dryRun ? " (dry run)" : "") + "\n",
  );

  if (dryRun) {
    /*
     * Routed through `prospectCounty` rather than just listing the targets, so
     * the output is the candidate plan — the thing worth checking before a paid
     * run. A dry run makes no network requests.
     */
    let withCandidates = 0;
    for (const t of targets.slice(0, 25)) {
      const r = await prospectCounty(t.county_fips, {
        dryRun: true,
        includePatterns,
        contactDomains: contactDomains.get(t.county_fips),
      });
      if (!r.isGap) withCandidates++;
      console.log(
        `  ${t.state} ${t.county} (${t.county_fips}, ${t.parcels.toLocaleString()} parcels) — ${r.note.slice(0, 150)}`,
      );
    }
    console.log(
      `\n${withCandidates}/${Math.min(25, targets.length)} sampled counties have candidates to verify.`,
    );
    process.exit(0);
  }

  let registry = base;
  const found: ProspectResult[] = [];
  const pending: ProspectResult[] = [];
  let verified = 0;
  let gaps = 0;
  const started = Date.now();

  for (const [i, t] of targets.entries()) {
    if (stopping) break;
    try {
      const r = await prospectCounty(t.county_fips, {
        useLlm: true,
        includePatterns,
        contactDomains: contactDomains.get(t.county_fips),
      });
      found.push(r);
      pending.push(r);
      if (r.isGap) gaps++;
      else verified++;
      const best = r.verified[0];
      console.log(
        `[${i + 1}/${targets.length}] ${t.state} ${t.county} — ` +
          (r.isGap
            ? "no source found"
            : `${r.verified.length} source(s), best ${best.confidence.toFixed(2)} ${best.url.slice(0, 80)}`),
      );
    } catch (e) {
      // One county's failure is not the run's. It stays a gap and is retried by
      // the next invocation, which is cheaper than losing the whole batch.
      console.log(
        `[${i + 1}/${targets.length}] ${t.state} ${t.county} — error: ` +
          (e instanceof Error ? e.message : String(e)).slice(0, 90),
      );
    }

    if (pending.length >= FLUSH_EVERY) {
      registry = flush(registry, pending);
      pending.length = 0;
    }
  }

  if (pending.length) registry = flush(registry, pending);

  console.log(
    `\n${found.length} counties prospected in ${((Date.now() - started) / 60000).toFixed(1)} min — ` +
      `${verified} with a source, ${gaps} still gaps`,
  );
  if (registry) {
    const cov = registryCoverage(registry);
    console.log(
      `${OUT}: ${cov.nCounties} counties, ${cov.nVerified} verified sources, ${cov.nGaps} gaps, ` +
        `${Math.round(cov.govShare * 100)}% on government hosts`,
    );
  }
  console.log(
    "\nNewly located counties become crawlable through the generic adapter; " +
      "queue them with `npm run queue:drain` after re-running the import's enrichment.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
