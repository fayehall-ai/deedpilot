/**
 * Property enrichment CLI — fill address / assessed / beds from ATTOM or RentCast.
 *
 *   npm run enrich:lots -- --state FL --limit 20
 *   npm run enrich:lots -- --lot <uuid>
 *   npm run enrich:lots -- --state FL --force
 *   npm run enrich:lots -- --state AR --high-value-first --min-bid 500 --limit 1500
 *
 * Requires ATTOM_API_KEY (parcel/APN) and/or RENTCAST_API_KEY (needs address).
 */
import "../lib/env";
import {
  configuredEnrichmentProviders,
  enrichLotById,
  enrichLotsMissingAssessed,
} from "../lib/property/enrich";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const providers = configuredEnrichmentProviders();
  console.log(
    providers.length
      ? `Providers: ${providers.join(", ")}`
      : "No providers configured — set ATTOM_API_KEY and/or RENTCAST_API_KEY",
  );

  const lotId = arg("lot");
  if (lotId) {
    const r = await enrichLotById(lotId, { force: flag("force") });
    console.log(r);
    process.exit(r.updated ? 0 : 1);
  }

  const state = arg("state")?.toUpperCase();
  const limit = arg("limit") ? Number(arg("limit")) : 25;
  const summary = await enrichLotsMissingAssessed({
    state,
    limit,
    force: flag("force"),
    // Spend quota on parcels worth bidding on first — opening bid tracks
    // assessed value closely (r = 0.852 on Arkansas).
    highValueFirst: flag("high-value-first"),
    minOpeningBid: arg("min-bid") ? Number(arg("min-bid")) : undefined,
    onProgress: (m) => console.log(m),
  });
  console.log("\n=== summary ===");
  console.log(summary);
  process.exit(summary.updated > 0 || summary.attempted === 0 ? 0 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
