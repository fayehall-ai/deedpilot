/**
 * Repoint imported auctions at county sources, and rename their id namespace.
 *
 *   npx tsx scripts/repoint-import-citations.ts            # dry run, prints the plan
 *   npx tsx scripts/repoint-import-citations.ts --apply    # writes, in one transaction
 *
 * 559 of 826 auctions arrived by calendar upload, and every one of them cited
 * the exporter's own per-row research page: a subscription host, not the county
 * that published the sale, and not a page a bidder can open. `source_url` is
 * NOT NULL, so those rows could not simply have the citation removed — they
 * needed a better one.
 *
 * `resolveSourceUrl` supplies it from what this repo already knows about each
 * county: the sale's own auction site as carried in the uploaded row, the
 * researched tax-collector page, the crawled county office directory, and — as
 * a floor no county falls through — that county's public records page. The
 * `--apply` run prints the tier mix rather than a single count, because a
 * citation that lands on a records directory is a weaker claim than one that
 * lands on the county's own deed-sale portal and should not be reported as if
 * they were the same thing.
 *
 * The id prefix moves in the same transaction. `import:` says what the marker
 * has always meant — this row was uploaded, not crawled — without naming a
 * vendor on 559 rows.
 *
 * Idempotent: re-running finds nothing left to do. `raw` is deliberately left
 * alone. It is the record of the file that was actually uploaded, nothing
 * renders it, and rewriting it would edit the audit trail rather than the data.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { resolveSourceUrl, type SourceTier } from "../lib/import/source-url";
import { IMPORT_ID_PREFIX } from "../lib/import/provenance";

/** The namespace these rows were minted under before this script existed. */
const LEGACY_ID_PREFIX = "ustla:";
/** The host every one of these citations pointed at. Never written back. */
const LEGACY_HOST = /ustla\.com/i;

const TIER_LABEL: Record<SourceTier, string> = {
  sale_site: "the county's own auction site, from the uploaded row",
  atlas_collector: "researched county tax collector page",
  directory_office: "crawled county office page (delinquent, collector, recorder…)",
  atlas_office: "researched clerk, platform or appraiser page",
  directory_county: "county public records directory page",
};

interface Row {
  id: string;
  external_id: string;
  source_url: string;
  county_fips: string;
  name: string;
  state: string;
  raw: Record<string, unknown> | null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = (await db.execute(sql`
    SELECT a.id, a.external_id, a.source_url, a.county_fips, c.name, c.state, a.raw
    FROM auctions a JOIN counties c ON c.fips = a.county_fips
    WHERE a.source_url ILIKE '%ustla.com%'
       OR a.external_id LIKE ${LEGACY_ID_PREFIX + "%"}
    ORDER BY c.state, c.name
  `)) as unknown as Row[];

  if (rows.length === 0) {
    console.log("nothing to do — no imported row still cites the aggregator");
    process.exit(0);
  }

  const plan = rows.map((r) => {
    const picked = resolveSourceUrl({
      countyFips: r.county_fips,
      state: r.state,
      countyName: r.name,
      raw: r.raw,
    });
    return {
      id: r.id,
      county: `${r.name}, ${r.state}`,
      externalId: r.external_id.startsWith(LEGACY_ID_PREFIX)
        ? IMPORT_ID_PREFIX + r.external_id.slice(LEGACY_ID_PREFIX.length)
        : r.external_id,
      ...picked,
    };
  });

  /*
   * The one check worth failing on. Every tier reads from data this repo holds,
   * and if any of it still carries the host being removed then the migration
   * would launder it into a column that is supposed to be free of it.
   */
  const leaked = plan.filter((p) => LEGACY_HOST.test(p.url));
  if (leaked.length > 0) {
    console.error(`REFUSING: ${leaked.length} resolved citation(s) still point at the aggregator`);
    for (const l of leaked.slice(0, 10)) console.error(`  ${l.county}: ${l.url}`);
    process.exit(1);
  }

  const byTier = new Map<SourceTier, number>();
  for (const p of plan) byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + 1);

  console.log(`${rows.length} imported auction(s) to repoint\n`);
  console.log("NEW CITATIONS BY SOURCE");
  for (const tier of Object.keys(TIER_LABEL) as SourceTier[]) {
    const n = byTier.get(tier) ?? 0;
    if (!n) continue;
    console.log(`  ${String(n).padStart(4)}  ${TIER_LABEL[tier]}`);
    const eg = plan.find((p) => p.tier === tier)!;
    console.log(`        e.g. ${eg.county} → ${eg.url}`);
  }
  const renamed = plan.filter((p) => p.externalId.startsWith(IMPORT_ID_PREFIX)).length;
  console.log(`\nexternal ids moving to the "${IMPORT_ID_PREFIX}" namespace: ${renamed}`);

  if (!apply) {
    console.log("\ndry run — nothing written. Re-run with --apply to write.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const p of plan) {
      await tx.execute(sql`
        UPDATE auctions
        SET source_url = ${p.url}, external_id = ${p.externalId}
        WHERE id = ${p.id}::uuid
      `);
    }
  });

  const [left] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM auctions
    WHERE source_url ILIKE '%ustla.com%' OR external_id LIKE ${LEGACY_ID_PREFIX + "%"}
  `)) as unknown as { n: number }[];

  console.log(`\nwrote ${plan.length} row(s). Rows still citing the aggregator: ${left.n}`);
  process.exit(left.n === 0 ? 0 : 1);
}

main();
