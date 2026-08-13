/**
 * One coverage number, as a funnel.
 *
 * Coverage was counted in two places that could not see each other:
 * `/coverage` measured what the crawler ingests, and the Scout panel measured
 * what research had looked at. Same underlying gap, two denominators, so a
 * county missing a source appeared in neither as a *coverage* problem — it was
 * a research gap on one screen and an absent row on the other.
 *
 * The stages below are strictly nested, which is what makes the number honest:
 * each is a subset of the one before, so a single figure — priceable inventory
 * over all counties — cannot be inflated by counting a county at a stage it has
 * not reached.
 *
 *     all counties
 *       → has a verified source        (the Prospector's job)
 *         → has an adapter that parses it
 *           → produced a confirmed sale list
 *             → the state can be priced
 *
 * The last stage is the one that matters commercially and the one most easily
 * forgotten: Arkansas contributes 6,199 crawled parcels and zero priceable
 * inventory, because coverage is counties × priceable states and those multiply.
 */

import { sql } from "drizzle-orm";

async function conn() {
  const [{ db }] = await Promise.all([import("../db")]);
  return db;
}

export interface FunnelStage {
  key: "counties" | "sourced" | "parsed" | "confirmed" | "priceable";
  label: string;
  counties: number;
  /** Share of all counties, 0-1. */
  share: number;
  /** What the gap at this stage actually needs. */
  needs: string;
}

export interface CoverageFunnel {
  stages: FunnelStage[];
  totalCounties: number;
  /** The one number: counties whose inventory a subscriber can actually price. */
  headline: number;
}

export async function buildCoverageFunnel(): Promise<CoverageFunnel> {
  const db = await conn();
  const [{ ALL_COUNTIES }, { loadRegistry }, { ADAPTERS }, { STATUTE_PARAMS }] = await Promise.all([
    import("../atlas"),
    import("../ingest/adapters/generic"),
    import("../ingest/adapters"),
    import("../deal/statute"),
  ]);

  const totalCounties = ALL_COUNTIES.length;

  const registry = loadRegistry();
  const sourced = new Set(
    Object.entries(registry?.counties ?? {})
      .filter(([, entry]) => entry.sources.length > 0)
      .map(([fips]) => fips),
  );

  /*
   * Built from the adapters themselves rather than a second registry, so it
   * stays correct as adapters are added — the same reasoning `buildAdapterIndex`
   * uses in the Scout.
   */
  const parsed = new Set<string>();
  for (const adapter of ADAPTERS) {
    try {
      for (const b of await adapter.discoverCounties()) parsed.add(b.countyFips);
    } catch {
      /* An adapter that cannot enumerate today must not zero the whole funnel. */
    }
  }

  /*
   * Only `sale_list` + a county-published date counts as inventory anywhere in
   * this system. A delinquent roll under a projected date once made up 65% of
   * the headline lot count, which is exactly the inflation this stage refuses.
   */
  const confirmedRows = (await db.execute(sql`
    SELECT DISTINCT county_fips FROM auctions
    WHERE listing_kind = 'sale_list' AND sale_date_confirmed = true AND delisted_at IS NULL
  `)) as unknown as { county_fips: string }[];
  const confirmed = new Set(confirmedRows.map((r) => r.county_fips));

  const priceableStates = new Set(Object.keys(STATUTE_PARAMS));
  const priceable = new Set(
    [...confirmed].filter((fips) => {
      const county = ALL_COUNTIES.find((c) => c.fips === fips);
      return county ? priceableStates.has(county.state) : false;
    }),
  );

  const stage = (
    key: FunnelStage["key"],
    label: string,
    n: number,
    needs: string,
  ): FunnelStage => ({ key, label, counties: n, share: totalCounties ? n / totalCounties : 0, needs });

  return {
    totalCounties,
    headline: priceable.size,
    stages: [
      stage("counties", "Counties in the atlas", totalCounties, "—"),
      stage("sourced", "Have a verified source", sourced.size, "research — the Prospector backlog"),
      stage("parsed", "An adapter can parse it", parsed.size, "an adapter, or the generic one to reach it"),
      stage("confirmed", "Published a confirmed sale list", confirmed.size, "a crawl, or a real sale to exist"),
      stage(
        "priceable",
        "…in a state the engine can price",
        priceable.size,
        "statutory parameters — human-gated, one state at a time",
      ),
    ],
  };
}
