/**
 * Delete upcoming auctions with zero lots (coverage inflation).
 * Prefer: npm run flywheel:coverage -- --purge-skeletons
 */
import "../lib/env";
import { db } from "../lib/db";
import { auctions } from "../lib/db/schema";
import { isSkeletonAuction } from "../lib/db/inventory";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ id: auctions.id })
    .from(auctions)
    .where(isSkeletonAuction(today));
  console.log(`${rows.length} skeleton(s)`);
  if (!dry && rows.length) {
    await db.delete(auctions).where(isSkeletonAuction(today));
    console.log("deleted");
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
