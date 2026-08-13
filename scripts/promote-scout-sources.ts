/**
 * Promote researched Scout rows into the source registry.
 *
 * The Auction Scout's findings currently die in `run_jobs.result` and a
 * spreadsheet. Nothing reads them back, so every research pass rediscovers the
 * same pages — the Arkansas COSL catalog is paid for again on every run — and
 * the 2,165 counties with an open crawl window and no source stay that way no
 * matter how much research is done.
 *
 * This is the missing link. A confirmed Scout row is already a `VerifiedSource`
 * in all but name:
 *
 *     officialSource  → isGovernment
 *     countyListUrl   → the listing page, which is what the crawler wants
 *     sourceUrl       → the page the row was actually read from
 *
 * ## Why the registry and not the database
 *
 * `data/source-registry.json` is version-controlled on purpose — the same
 * reasoning that keeps the atlas in code. A county's source-of-record changes
 * rarely, is worth reviewing when it does, and everything downstream is
 * worthless if it is wrong. Writing a file means promotion produces a **diff a
 * person reads**, which is the Cartographer's pattern rather than a silent
 * runtime write.
 *
 * It is also the only thing the crawler reads: `loadRegistry` in
 * `lib/ingest/adapters/generic.ts` reads this file, and the `source_overrides`
 * table — despite having a console form — is consulted by no adapter at all.
 *
 * ## What is refused
 *
 * - Rows that are not `verification: 'confirmed'`. An unconfirmed row is a lead.
 * - Rows whose county cannot be placed unambiguously (`lib/atlas/resolve-fips`).
 *   Six county/independent-city pairs share a name, and attaching a sale list to
 *   the wrong Baltimore is worse than leaving the county empty.
 * - Rows for counties that already have a government listing source, unless
 *   --replace is passed. Research should fill gaps, not churn reviewed entries.
 *
 * Everything refused is reported by reason, because the refusals are the work
 * queue: a municipal-state row is Connecticut behaving exactly as documented,
 * and an ambiguous one needs a person for thirty seconds.
 *
 *   npx tsx scripts/promote-scout-sources.ts [--dry-run] [--replace] [--state GA]
 */
import "../lib/env";
import { readFileSync, writeFileSync } from "node:fs";
import { desc, like } from "drizzle-orm";
import { db } from "../lib/db";
import { runJobs } from "../lib/db/schema";
/*
 * Types only. `lib/ai/scout-report.ts` and `lib/admin/scout-jobs.ts` are both
 * `server-only`, which throws under plain tsx — so this reads the queue by
 * adapter prefix rather than importing their state list. That is also more
 * correct: it promotes every state ever researched, including any since
 * dropped from SCAN_STATES.
 */
import type { ScoutRow, StateReportResult } from "../lib/ai/scout-report";
import { resolveFips, summarise, type FipsResolution } from "../lib/atlas/resolve-fips";
import type { SourceRegistry, VerifiedSource } from "../lib/prospector/types";

const SCOUT_PREFIX = "auction-scout:";
const scoutState = (adapter: string) => adapter.slice(SCOUT_PREFIX.length);
const REGISTRY_PATH = "data/source-registry.json";

const flag = (n: string) => process.argv.includes(`--${n}`);
function arg(n: string): string | null {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** The latest landed report per state, which is what the console shows too. */
async function latestReports(): Promise<StateReportResult[]> {
  const rows = await db
    .select()
    .from(runJobs)
    .where(like(runJobs.adapter, `${SCOUT_PREFIX}%`))
    .orderBy(desc(runJobs.createdAt))
    .limit(200);

  const seen = new Set<string>();
  const out: StateReportResult[] = [];
  for (const job of rows) {
    if (job.status !== "done" || seen.has(job.adapter)) continue;
    seen.add(job.adapter);
    const result = job.result as StateReportResult | null;
    if (result?.report?.rows?.length) out.push(result);
    else if (result) console.log(`  ${scoutState(job.adapter)}: report landed with no rows`);
  }
  return out;
}

/**
 * Turn a row into a registry source.
 *
 * `countyListUrl` wins over `sourceUrl` when present, because the list is what
 * a crawler needs — a page merely mentioning the sale is where a human read it.
 * `verifiedOn` carries the report's own date rather than today's, so the entry
 * says when the page was actually seen.
 */
function toVerifiedSource(row: ScoutRow, fips: string, seenOn: string): VerifiedSource {
  const url = row.countyListUrl ?? row.sourceUrl;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  return {
    fips,
    state: row.state.toUpperCase(),
    url,
    host,
    origin: "atlas",
    kind: row.countyListUrl ? "listing" : "calendar",
    isGovernment: row.officialSource,
    /*
     * 0.75, not the 0.9+ a fetch-verified Prospector entry earns. This page was
     * read by a model during research, not probed for tax-sale vocabulary and a
     * parcel table, and the confidence should say so — the generic adapter uses
     * this ordering to pick which source to crawl.
     */
    confidence: 0.75,
    signals: ["auction scout", row.saleKind].filter(Boolean),
    verifiedOn: seenOn.slice(0, 10),
    httpStatus: 200,
  } as VerifiedSource;
}

interface Refusal {
  state: string;
  county: string;
  reason: string;
  detail: string;
}

async function main() {
  const dry = flag("dry-run");
  const replace = flag("replace");
  const onlyState = arg("state")?.toUpperCase() ?? null;

  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as SourceRegistry;
  const reports = await latestReports();
  if (reports.length === 0) {
    console.log("No landed Scout reports to promote. Run the Auction Scout first.");
    process.exit(0);
  }
  console.log(`${reports.length} landed report(s): ${reports.map((r) => r.state).join(", ")}\n`);

  const refusals: Refusal[] = [];
  const resolutions: FipsResolution[] = [];
  let added = 0;
  let replaced = 0;
  let alreadyCovered = 0;

  for (const report of reports) {
    if (onlyState && report.state !== onlyState) continue;

    for (const row of report.report.rows) {
      if (row.verification !== "confirmed") {
        refusals.push({
          state: row.state,
          county: row.county,
          reason: "unconfirmed",
          detail: "row is a lead, not a verified sale",
        });
        continue;
      }

      const res = resolveFips(row.county, row.state);
      resolutions.push(res);
      if (!res.ok) {
        refusals.push({ state: row.state, county: row.county, reason: res.reason, detail: res.detail });
        continue;
      }

      const fips = res.fips;
      const entry = registry.counties[fips];
      const source = toVerifiedSource(row, fips, report.generatedAt);

      if (!entry) {
        registry.counties[fips] = {
          state: res.county.state,
          county: res.county.name,
          sources: [source],
          isGap: false,
        } as SourceRegistry["counties"][string];
        added++;
        continue;
      }

      const hasGovListing = entry.sources.some((s) => s.isGovernment && s.kind === "listing");
      if (hasGovListing && !replace) {
        alreadyCovered++;
        continue;
      }

      const dupe = entry.sources.findIndex((s) => s.url === source.url);
      if (dupe >= 0) {
        entry.sources[dupe] = source;
        replaced++;
      } else {
        entry.sources.push(source);
        added++;
      }
      entry.isGap = false;
    }
  }

  // --- report ---------------------------------------------------------------

  const summary = summarise(resolutions);
  console.log(`counties placed:      ${summary.resolved}`);
  console.log(`  new sources added:  ${added}`);
  console.log(`  sources replaced:   ${replaced}`);
  console.log(`  already covered:    ${alreadyCovered}${replace ? "" : " (pass --replace to overwrite)"}`);
  console.log(`\ncould not place:      ${refusals.length}`);

  const byReason = new Map<string, Refusal[]>();
  for (const r of refusals) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
  for (const [reason, rows] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${reason.padEnd(16)} ${String(rows.length).padStart(4)}`);
    // Named, not just counted: an ambiguous county is thirty seconds of a
    // person's time, and a list nobody can see is a list nobody works.
    for (const r of rows.slice(0, 6)) console.log(`      ${r.state} ${r.county} — ${r.detail}`);
    if (rows.length > 6) console.log(`      … and ${rows.length - 6} more`);
  }

  if (dry) {
    console.log("\n(dry run — registry not written)");
    process.exit(0);
  }

  if (added === 0 && replaced === 0) {
    console.log("\nNothing to write.");
    process.exit(0);
  }

  /*
   * Recomputed exactly as `buildRegistry` in lib/prospector/index.ts does.
   * A first pass here read `nVerified` as "counties holding a source" and cut
   * it from 921 to 747 — it is the total number of verified *sources*, summed
   * across counties, and several counties carry more than one.
   */
  const entries = Object.values(registry.counties);
  registry.nCounties = entries.length;
  registry.nVerified = entries.reduce((n, c) => n + c.sources.length, 0);
  registry.nGaps = entries.filter((c) => c.isGap).length;

  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`\nWrote ${REGISTRY_PATH} — review the diff before committing.`);
  console.log("The generic adapter reads this file, so a wrong URL becomes a wrong crawl target.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
