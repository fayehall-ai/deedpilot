/**
 * Seed the `counties` table from the rules atlas.
 *
 * Idempotent: re-running updates names/population/coverage in place rather
 * than duplicating. Safe to run on every deploy.
 *
 *   npm run db:seed
 */
import "../lib/env";
import { db } from "../lib/db";
import { counties } from "../lib/db/schema";
import { ALL_COUNTIES, COUNTY_DATA, isCovered, toSaleType } from "../lib/atlas";
import { sql } from "drizzle-orm";

type Platform = typeof counties.$inferInsert["platform"];

/**
 * Infer which ingestion adapter services a county from the auction platform
 * URL recorded during atlas research. Counties we haven't researched fall to
 * null and are picked up by the per-state discovery adapters instead.
 */
function inferPlatform(fips: string): { platform: Platform; config: Record<string, unknown> | null } {
  const rule = COUNTY_DATA[fips];
  const url = rule?.auctionPlatform?.url?.toLowerCase() ?? "";
  const label = rule?.auctionPlatform?.label?.toLowerCase() ?? "";
  const format = rule?.auctionFormat?.toLowerCase() ?? "";

  if (url.includes("realtaxdeed.com")) {
    // RealAuction's Florida tax deed product is per-county subdomains:
    // https://<county>.realtaxdeed.com
    const sub = url.match(/https?:\/\/([a-z0-9-]+)\.realtaxdeed\.com/)?.[1];
    return { platform: "realtaxdeed", config: sub ? { subdomain: sub } : null };
  }
  if (url.includes("realforeclose.com")) {
    const sub = url.match(/https?:\/\/([a-z0-9-]+)\.realforeclose\.com/)?.[1];
    return { platform: "realforeclose", config: sub ? { subdomain: sub } : null };
  }
  if (url.includes("govease.com") || label.includes("govease")) {
    return { platform: "govease", config: url ? { url } : null };
  }
  if (url.includes("bid4assets.com")) return { platform: "bid4assets", config: { url } };
  if (url.includes("zeusauction.com") || label.includes("zeus")) {
    return { platform: "zeus", config: url ? { url } : null };
  }
  if (url.includes("lienhub.com")) return { platform: "lienhub", config: { url } };
  if (url.includes("tax-sale.info")) return { platform: "taxsaleinfo", config: { url } };
  if (url.includes("mvbalaw.com")) return { platform: "mvba", config: { url } };
  if (url.includes("lgbs.com")) return { platform: "lgbs", config: { url } };
  if (url.includes("grantstreet") || url.includes("taxsale.com")) {
    return { platform: "grantstreet", config: { url } };
  }

  // No platform URL. If the research says the sale happens in person (sheriff's
  // sale, courthouse steps), record that honestly — it is not a gap to fill
  // with a scraper, it is a sale we can only get a list for, never live bids.
  if (format.includes("in person") || label.includes("sheriff") || label.includes("courthouse")) {
    return { platform: "in_person", config: null };
  }
  if (url) return { platform: "county_site", config: { url } };
  return { platform: null, config: null };
}

async function main() {
  const rows = ALL_COUNTIES.map((c) => {
    const { platform, config } = inferPlatform(c.fips);
    return {
      fips: c.fips,
      name: c.name,
      state: c.state,
      stateName: c.stateName,
      population: c.population,
      covered: isCovered(c.state),
      platform,
      adapterConfig: config,
    };
  });

  // Chunked to stay well under Postgres' 65535 bind-parameter limit.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await db
      .insert(counties)
      .values(batch)
      .onConflictDoUpdate({
        target: counties.fips,
        set: {
          name: sql`excluded.name`,
          state: sql`excluded.state`,
          stateName: sql`excluded.state_name`,
          population: sql`excluded.population`,
          covered: sql`excluded.covered`,
          platform: sql`excluded.platform`,
          adapterConfig: sql`excluded.adapter_config`,
        },
      });
    written += batch.length;
  }

  const covered = rows.filter((r) => r.covered).length;
  const withPlatform = rows.filter((r) => r.covered && r.platform).length;
  const byPlatform = rows
    .filter((r) => r.covered && r.platform)
    .reduce<Record<string, number>>((a, r) => ((a[r.platform!] = (a[r.platform!] ?? 0) + 1), a), {});

  console.log(`seeded ${written} counties`);
  console.log(`  covered (FL/GA/TX/AZ/MI): ${covered}`);
  console.log(`  covered with a known platform: ${withPlatform}`);
  for (const [p, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p}: ${n}`);
  }
  console.log(`  researched atlas entries: ${Object.keys(COUNTY_DATA).length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
