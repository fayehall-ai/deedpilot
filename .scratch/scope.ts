import "../lib/env";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
async function main(){
  const r=(await db.execute(sql`
    select count(*)::int total,
           count(distinct a.county_fips)::int counties,
           count(*) filter (where a.sale_date_confirmed)::int confirmed
    from auctions a where a.sale_date >= current_date and a.delisted_at is null`)) as any[];
  console.log(`upcoming sales ${r[0].total} across ${r[0].counties} counties (${r[0].confirmed} with a confirmed date)`);
  const s=(await db.execute(sql`
    select c.state, count(distinct a.county_fips)::int n
    from auctions a join counties c on c.fips=a.county_fips
    where a.sale_date >= current_date and a.delisted_at is null
    group by 1 order by 2 desc limit 12`)) as any[];
  console.log('top states:', s.map((x:any)=>`${x.state} ${x.n}`).join('  '));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e?.cause?.message??e);process.exit(1);});
