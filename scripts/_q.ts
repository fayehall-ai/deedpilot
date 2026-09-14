import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
async function main() {
  console.log("jobs:", JSON.stringify(await db.execute(sql`select status, count(*) n from run_jobs where adapter like 'cape-script:%' group by 1`)));
  console.log("finished 15m:", JSON.stringify(await db.execute(sql`select count(*) n from run_jobs where adapter like 'cape-script:%' and finished_at > now() - interval '15 minutes'`)));
  console.log("halves:", JSON.stringify(await db.execute(sql`select count(*) n, sum(used_count) uses from cape_county_scripts`)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
