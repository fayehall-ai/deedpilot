/**
 * Enrich a county's lots straight from its cadastre layer.
 *
 *   npx tsx scripts/bulk-cadastre.ts --fips 13067
 *   npx tsx scripts/bulk-cadastre.ts --state AR    # every county at once
 *
 * Deliberately narrower than `enrich:lots`: it calls the cadastre provider only,
 * so a county with a registry entry is filled in minutes rather than walking the
 * whole provider chain and paying a searched call for each miss.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { cadastreProvider } from "../lib/property/providers/cadastre";
import { applyRecordToLot } from "../lib/property/enrich";
import { ALL_COUNTIES } from "../lib/atlas";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i>=0?process.argv[i+1]:undefined; };

async function main(){
  const one = arg("fips");
  const state = arg("state")?.toUpperCase();
  if (!one && !state) { console.error("usage: --fips <5-digit> | --state <XX>"); process.exit(1); }

  /*
   * A statewide cadastre covers every county, so running it county by county is
   * 45 process starts to do one job. `--state` walks them in a single run.
   */
  if (state && !one) {
    const counties = (await db.execute(sql`
      SELECT DISTINCT a.county_fips FROM lots l JOIN auctions a ON a.id=l.auction_id
      WHERE l.status='pending' AND l.assessed_value IS NULL AND l.parcel_number IS NOT NULL
        AND a.county_fips IN (${sql.join(
          ALL_COUNTIES.filter(c=>c.state===state).map(c=>sql`${c.fips}`), sql`, `)})
      `)) as unknown as {county_fips:string}[];
    console.log(`${state}: ${counties.length} counties with lots to try\n`);
    let tHit=0, tMiss=0;
    for (const c of counties) {
      const r = await runCounty(c.county_fips, Number(arg("limit") ?? 10_000));
      tHit += r.hit; tMiss += r.miss;
    }
    console.log(`\n${state} TOTAL: ${tHit} enriched, ${tMiss} missed (${Math.round(tHit/Math.max(1,tHit+tMiss)*100)}%)`);
    process.exit(0);
  }

  const FIPS: string = one!;
  const limit = Number(arg("limit") ?? 10_000);
  const r = await runCounty(FIPS, limit);
  console.log(`\ndone: ${r.hit} enriched, ${r.miss} missed (${Math.round(r.hit/Math.max(1,r.hit+r.miss)*100)}%)`);
  process.exit(0);
}

async function runCounty(FIPS: string, limit: number): Promise<{hit:number;miss:number}> {
  const county = ALL_COUNTIES.find(c=>c.fips===FIPS);
  /*
   * "Unvalued" means neither kind of value, not just a missing assessed one.
   *
   * Testing `assessed_value IS NULL` alone re-selected every lot the cadastre had
   * already answered with a market figure — which is most of them, since several
   * registry entries deliberately write no assessed value at all. A pass over
   * Arkansas reported "33 enriched" while the outstanding count did not move,
   * because the 33 were lots that already had a value and the genuinely missing
   * ones were missed.
   */
  const lots = await db.execute(sql`
    SELECT l.id, l.parcel_number FROM lots l
    JOIN auctions a ON a.id=l.auction_id
    LEFT JOIN lot_valuations v ON v.lot_id=l.id
    WHERE a.county_fips=${FIPS} AND l.status='pending'
      AND l.assessed_value IS NULL AND v.market_value IS NULL
      AND l.parcel_number IS NOT NULL LIMIT ${limit}`) as unknown as {id:string;parcel_number:string}[];
  console.log(`${county?.name ?? FIPS}: ${lots.length} lots to try`);
  /*
   * Concurrent, because serial was too slow to finish.
   *
   * One lot is an HTTP round trip plus a write — about 1.3 a second serially,
   * which put Cobb's 8,475 at nearly two hours and meant every interruption lost
   * most of the work. Eight at a time brings it under twenty minutes.
   *
   * Eight rather than more: these are county servers hosting a public service as
   * a courtesy, and the point is to read the whole county without being the
   * reason they start refusing.
   */
  const CONCURRENCY = 8;
  let hit=0, miss=0, done=0;
  async function worker(queue: typeof lots) {
    for (;;) {
      const lot = queue.pop();
      if (!lot) return;
      try {
        const rec = await cadastreProvider.lookup({
          state: county?.state ?? "", fips: FIPS, countyName: county?.name ?? "",
          parcelNumber: lot.parcel_number, addressLine: null, city: null, zip: null });
        if (rec) { await applyRecordToLot(lot.id, rec); hit++; } else miss++;
      } catch { miss++; }
      if (++done % 500 === 0) console.log(`  ${done}/${lots.length} — ${hit} enriched, ${miss} missed`);
    }
  }
  const queue = [...lots];
  await Promise.all(Array.from({length: CONCURRENCY}, () => worker(queue)));
  console.log(`  ${county?.name ?? FIPS}: ${hit} enriched, ${miss} missed`);
  return { hit, miss };
}
main().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
