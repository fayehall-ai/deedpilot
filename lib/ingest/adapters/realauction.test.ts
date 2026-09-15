/**
 * Host → county resolution for RealAuction captures.
 * Run: npx tsx lib/ingest/adapters/realauction.test.ts
 *
 * A capture carries a hostname and a date and nothing else, so this function is
 * the whole of the adapter's county assignment. Getting it wrong files a sale
 * under a county that never held it — the failure `zeus.ts` records, where a
 * misassigned index put 8,611 parcels in the wrong place — and nothing
 * downstream would catch it, because a sale under the wrong county looks
 * exactly like a sale.
 *
 * So the cases below are as much about refusing as resolving. The hosts are
 * real ones, taken from `data/county-directory.json` and RealAuction's own site
 * directory at `data/realauction-sites.json`.
 */
import { countyForHost } from "./realauction";

let failed = 0;
function check(host: string, expect: string | null, why: string) {
  return countyForHost(host).then((got) => {
    const actual = got ? `${got.fips} ${got.name}, ${got.state}` : null;
    if (actual !== expect) {
      failed++;
      console.error(`FAIL ${host}\n  expected ${expect}\n  got      ${actual}\n  (${why})`);
    }
  });
}

async function main() {
  await Promise.all([
    /* The ordinary case: the subdomain is the county's name. */
    check("duval.realtaxdeed.com", "12031 Duval, FL", "plain subdomain"),
    check("www.duval.realtaxdeed.com", "12031 Duval, FL", "www is stripped"),
    check("DUVAL.RealTaxDeed.com", "12031 Duval, FL", "case is not signal"),

    /* Punctuation and spaces the hostname cannot carry. */
    check("indian-river.realtaxdeed.com", "12061 Indian River, FL", "hyphen for a space"),
    check("indianriver.realtaxdeed.com", "12061 Indian River, FL", "no separator at all"),
    check("santarosa.realtaxdeed.com", "12113 Santa Rosa, FL", "two words run together"),
    check("palmbeach.realtaxdeed.com", "12099 Palm Beach, FL", "two words run together"),

    /* Names that are not the county's, and need the alias table. */
    check("miami.realtaxdeed.com", "12086 Miami-Dade, FL", "Miami is not a county"),
    check("myorangeclerk.realforeclose.com", "12095 Orange, FL", "the clerk's own brand"),

    /*
     * The one that matters most. El Paso is a county in Colorado and a much
     * larger one in Texas, and this host is the Colorado treasurer's sale.
     */
    check(
      "elpasoco.treasurersdeedsale.realtaxdeed.com",
      "08041 El Paso, CO",
      "Colorado, not the larger El Paso in Texas",
    ),

    /* Florida wins a name thirty-odd states share, because the platform is Florida's. */
    check("washington.realtaxdeed.com", "12133 Washington, FL", "Florida first"),
    check("jackson.realtaxdeed.com", "12063 Jackson, FL", "Florida first"),

    /* Refusals. A guess here is worse than no binding. */
    check("realtaxdeed.com", null, "no subdomain to read"),
    check("qq.realtaxdeed.com", null, "too short to be a name"),
    check("notacounty.realtaxdeed.com", null, "matches nothing, and is not invented"),
  ]);

  console.log(failed === 0 ? "realauction: all host cases pass" : `realauction: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
