/**
 * Delete upcoming auctions with zero lots (coverage inflation).
 * Prefer: npm run flywheel:coverage -- --purge-skeletons
 */
import "../lib/env";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions } from "../lib/db/schema";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ id: auctions.id })
    .from(auctions)
    .where(and(gte(auctions.saleDate, today), eq(auctions.lotCount, 0)));
  console.log(`${rows.length} skeleton(s)`);
  if (!dry && rows.length) {
    await db.delete(auctions).where(and(gte(auctions.saleDate, today), eq(auctions.lotCount, 0)));
    console.log("deleted");
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
