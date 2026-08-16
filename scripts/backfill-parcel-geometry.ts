/**
 * Recover the coordinates the cadastre already gave us.
 *
 *   npm run intel:locate -- --state AR --limit 200
 *   npm run intel:locate -- --plan            # what is reachable, per state
 *   npm run intel:locate                      # every state with a layer
 *
 * ## What this is repairing
 *
 * `cadastreProvider` matched 16,001 parcels against state and county assessor
 * layers while passing `returnGeometry: "false"`. Those services return the
 * parcel's geometry in the same response, at no extra cost, with no key and no
 * metering — and every one of those coordinates was parsed past and discarded.
 *
 * The result is that 21,700 of 25,702 lots have no location, and a location is
 * the precondition for every question about a parcel's surroundings: the flood
 * zone it sits in, the rail line behind it, the substation up the road. The
 * intel loop has almost nothing to work on until this runs.
 *
 * The repair is free because the layer will answer the same query again.
 *
 * ## Why it does not go through `enrichLotById`
 *
 * That path is about valuations, and it skips a parcel whose value it already
 * has — which is exactly the 16,001 parcels that need this. It also refuses a
 * feature with no assessed or market value, and a parcel with coordinates and
 * no value is still a parcel we can research. So this asks the narrower
 * question directly: where is it.
 */

import "../lib/env";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { counties, lots } from "../lib/db/schema";
import { CADASTRE_SOURCES, parcelLocation } from "../lib/property/providers/cadastre";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same two forms the valuation path tries: verbatim, then digits only. */
function candidates(parcel: string): string[] {
  const raw = parcel.trim();
  const digits = raw.replace(/\D/g, "");
  return [...new Set([raw, digits].filter((s) => s.length >= 4))];
}

/** Ask a layer only where the parcel is. */
async function locate(
  fips: string,
  state: string,
  parcelNumber: string,
): Promise<{ latitude: number; longitude: number; basis: string } | null> {
  const src = CADASTRE_SOURCES[fips] ?? CADASTRE_SOURCES[state.toUpperCase()];
  if (!src) return null;

  for (const candidate of candidates(parcelNumber)) {
    const clauses = [`${src.parcelField}='${candidate.replace(/'/g, "''")}'`];
    if (src.countyField) clauses.push(`${src.countyField}='${fips}'`);

    const params = new URLSearchParams({
      where: clauses.join(" AND "),
      // Only the id. The values are already in `lot_valuations` and asking for
      // them again would make a wide response out of a narrow question.
      outFields: src.parcelField,
      returnGeometry: "true",
      outSR: "4326",
      f: "json",
    });

    try {
      const res = await fetch(`${src.url}?${params}`, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        features?: { geometry?: unknown }[];
        error?: unknown;
      };
      if (data.error) continue;
      const rows = data.features ?? [];
      // Exactly one, or we do not know which parcel this is — the same rule the
      // valuation path uses, and for the same reason: a plausible wrong
      // coordinate is worse than none.
      if (rows.length !== 1) continue;

      const located = parcelLocation(rows[0].geometry as never);
      if (located) return located;
    } catch {
      // A slow state service is not a fact about the parcel.
      continue;
    }
  }

  return null;
}

async function plan() {
  const rows = await db
    .select({
      state: counties.state,
      fips: counties.fips,
      county: counties.name,
      total: sql<number>`count(*)::int`,
      located: sql<number>`count(${lots.latitude})::int`,
      withParcel: sql<number>`count(${lots.parcelNumber})::int`,
    })
    .from(lots)
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .groupBy(counties.state, counties.fips, counties.name);

  const byState = new Map<string, { total: number; located: number; reachable: number }>();
  for (const r of rows) {
    const hasLayer = Boolean(CADASTRE_SOURCES[r.fips] ?? CADASTRE_SOURCES[r.state]);
    const cur = byState.get(r.state) ?? { total: 0, located: 0, reachable: 0 };
    cur.total += r.total;
    cur.located += r.located;
    if (hasLayer) cur.reachable += Math.max(0, Math.min(r.total - r.located, r.withParcel));
    byState.set(r.state, cur);
  }

  console.log("\nParcel location coverage, and what a cadastre layer can still reach\n");
  console.table(
    [...byState.entries()]
      .sort((a, b) => b[1].reachable - a[1].reachable)
      .map(([state, v]) => ({
        state,
        lots: v.total,
        located: v.located,
        missing: v.total - v.located,
        "reachable by layer": v.reachable,
      })),
  );
  const totalReachable = [...byState.values()].reduce((s, v) => s + v.reachable, 0);
  console.log(
    `${totalReachable.toLocaleString()} parcel(s) can be located for free from a layer already in the registry.`,
  );
}

async function main() {
  if (flag("plan")) {
    await plan();
    return;
  }

  const state = arg("state")?.toUpperCase();
  const limit = Number(arg("limit") ?? 250);

  const conditions = [isNull(lots.latitude), isNotNull(lots.parcelNumber)];
  if (state) conditions.push(eq(counties.state, state));

  const targets = await db
    .select({
      id: lots.id,
      parcelNumber: lots.parcelNumber,
      fips: counties.fips,
      state: counties.state,
      county: counties.name,
    })
    .from(lots)
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(and(...conditions))
    /*
     * Parcels that already have a valuation first. Those are the ones the
     * cadastre demonstrably matched, so their geometry is the highest-yield
     * ask in the table — this run is recovering data we know exists.
     */
    .orderBy(sql`${lots.assessedValue} is null`, sql`${lots.openingBid} desc nulls last`)
    .limit(limit);

  const workable = targets.filter(
    (t) => CADASTRE_SOURCES[t.fips] ?? CADASTRE_SOURCES[t.state.toUpperCase()],
  );

  console.log(
    `${targets.length} parcel(s) without coordinates; ${workable.length} in a county or state ` +
      `with a registered layer.`,
  );

  let located = 0;
  let missed = 0;

  for (const [i, t] of workable.entries()) {
    const point = await locate(t.fips, t.state, t.parcelNumber!);
    if (point) {
      await db
        .update(lots)
        .set({
          latitude: String(point.latitude),
          longitude: String(point.longitude),
        })
        .where(eq(lots.id, t.id));
      located++;
      console.log(
        `[${i + 1}/${workable.length}] ${t.parcelNumber} (${t.county}, ${t.state}) → ` +
          `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)} (${point.basis})`,
      );
    } else {
      missed++;
      if (missed % 25 === 0) console.log(`[${i + 1}/${workable.length}] ${missed} unmatched so far`);
    }
    // The state services are free and unmetered; that is a reason to be polite
    // with them, not a reason to hammer them.
    await sleep(250);
  }

  console.log(`\nLocated ${located}, unmatched ${missed}, of ${workable.length} attempted.`);
}

/*
 * Explicit exit, matching `scripts/enrich-lots.ts`. The shared client in
 * `lib/db` is a long-lived pool with no close on it — correct for a server,
 * and it keeps a CLI process alive indefinitely after the work is done.
 */
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
