/**
 * RealEstateAPI PropertyDetail for every parcel the spend policy allows.
 *
 *   npm run enrich:reapi -- --dry-run          # count and cost, no calls
 *   npm run enrich:reapi                       # next 8 weeks of sales
 *   npm run enrich:reapi -- --days 28 --limit 500 --concurrency 5
 *   npm run enrich:reapi -- --auction <uuid>[,<uuid>]   # one sale's parcels
 *
 * The pass itself is `lib/property/reapi-detail-pass.ts`, shared with the
 * Sunday CAPE run on Vercel (`/api/cron/reapi-enrich`).
 */
import "../lib/env";
import { runReapiDetailPass } from "../lib/property/reapi-detail-pass";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

runReapiDetailPass({
  days: Number(arg("days") ?? 56),
  limit: arg("limit") ? Number(arg("limit")) : undefined,
  concurrency: Number(arg("concurrency") ?? 5),
  auctionIds: arg("auction")?.split(",").map((s) => s.trim()).filter(Boolean),
  dryRun: flag("dry-run"),
  onLog: (line) => console.log(line),
})
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
