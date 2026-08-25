/**
 * Property enrichment CLI — fill address / assessed / beds from ATTOM or RentCast.
 *
 *   npm run enrich:lots -- --state FL --limit 20
 *   npm run enrich:lots -- --lot <uuid>
 *   npm run enrich:lots -- --state FL --force
 *   npm run enrich:lots -- --state AR --high-value-first --min-bid 500 --limit 1500
 *
 * Fill the AVM gap rather than the assessment gap — lots that already carry a
 * county assessment but no market value, which the default filter cannot see:
 *   npm run enrich:avm -- --high-value-first --limit 500
 *
 * Requires REALESTATEAPI_API_KEY (parcel/APN + AVM); ATTOM_API_KEY and
 * RENTCAST_API_KEY still contribute where their keys are live.
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
    missingMarketValue: flag("missing-market"),
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
