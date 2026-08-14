/**
 * Enrich a county's lots straight from its cadastre layer.
 *
 *   npx tsx scripts/bulk-cadastre.ts --fips 13067
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
  const fips = arg("fips"); if(!fips){ console.error("usage: --fips <5-digit>"); process.exit(1); }
  const limit = Number(arg("limit") ?? 10_000);
  const county = ALL_COUNTIES.find(c=>c.fips===fips);
  const lots = await db.execute(sql`
    SELECT l.id, l.parcel_number FROM lots l JOIN auctions a ON a.id=l.auction_id
    WHERE a.county_fips=${fips} AND l.status='pending' AND l.assessed_value IS NULL
      AND l.parcel_number IS NOT NULL LIMIT ${limit}`) as unknown as {id:string;parcel_number:string}[];
  console.log(`${county?.name ?? fips}: ${lots.length} lots to try`);
  let hit=0, miss=0;
  for (const [i, lot] of lots.entries()) {
    try {
      const rec = await cadastreProvider.lookup({
        state: county?.state ?? "", fips, countyName: county?.name ?? "",
        parcelNumber: lot.parcel_number, addressLine: null, city: null, zip: null });
      if (rec) { await applyRecordToLot(lot.id, rec); hit++; } else miss++;
    } catch { miss++; }
    if ((i+1) % 250 === 0) console.log(`  ${i+1}/${lots.length} — ${hit} enriched, ${miss} missed`);
  }
  console.log(`\ndone: ${hit} enriched, ${miss} missed (${Math.round(hit/(hit+miss)*100)}%)`);
  process.exit(0);
}
main().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
