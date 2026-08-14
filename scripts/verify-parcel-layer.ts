/**
 * Check whether a parcel layer is really this county's, before trusting it.
 *
 *   npx tsx scripts/verify-parcel-layer.ts --fips 13067 \
 *     --url https://gis.cobbcounty.gov/gisserver/rest/services/cobbpublic/Parcels/MapServer/3
 *
 * ## Why this exists
 *
 * Searching ArcGIS for "<county> County <state> parcels" finds candidates fast,
 * and the first one it found for Greenville County, South Carolina was the town
 * of Greenville, **Florida** — 197 rows, Florida DOR field names, county code 43
 * (Madison County FL), and an extent at 30.3°N when Greenville SC sits at 34.8°N.
 *
 * Wired in unchecked, that layer would have supplied valuations for the wrong
 * state. It is the exact failure the cadastre provider is built to avoid, arriving
 * through the front door instead: not a fuzzy match on a parcel id, but a
 * confident exact match against an entirely different county's data.
 *
 * So discovery proposes and this disposes. The checks run cheapest-first and the
 * last one is the only one that actually settles it.
 *
 * ## The checks
 *
 * 1. **Reachable and public.** Several candidates return `Token Required` — a
 *    layer indexed publicly but readable only with credentials.
 * 2. **Has a value field and an id field.** Without both it cannot answer the
 *    question, whatever else it holds.
 * 3. **Row count is plausible.** 197 rows is not a county of 200,000 parcels;
 *    27,033 is not Fulton County either, and that mismatch is the tell that the
 *    layer belongs to a city inside it.
 * 4. **Our own parcel numbers match.** The decisive one. A layer can be the right
 *    county and still be unusable, because the tax-sale notice and the GIS often
 *    number parcels differently — Jefferson Parish publishes `0300004663` on its
 *    sale list and `30-332-01-012` in its GIS. Both are real, neither converts to
 *    the other by any rule worth writing.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { ALL_COUNTIES } from "../lib/atlas";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function get(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return (await r.json()) as Record<string, unknown>;
}

/*
 * Anchored, because a loose /val/ matched VALIDATIONSTATUS on the Lincoln NM
 * layer and reported a status column as the parcel's value — which passed
 * verification and would have written nulls for a whole county.
 */
const VALUE_RE = /(^|_)(val|value|assess\w*|appr\w*|jv|av|fmv|mkt|market|land|improv\w*|total)(_|$)|value$|val[lic]$/i;
const ID_RE = /parcel|^pin$|apn|tms|prop_?id|pid/i;

async function main() {
  const fips = arg("fips");
  const url = arg("url")?.replace(/\/$/, "");
  if (!fips || !url) {
    console.error("usage: --fips <5-digit> --url <layer or service url>");
    process.exit(1);
  }

  const county = ALL_COUNTIES.find((c) => c.fips === fips);
  console.log(`\nVerifying against ${county ? `${county.name}, ${county.state}` : fips}\n${url}\n`);

  // Accept a service url and pick its first layer, or a layer url directly.
  let layer = url;
  if (!/\/\d+$/.test(url)) {
    const svc = await get(`${url}?f=json`);
    if (svc.error) return fail(`service error: ${JSON.stringify(svc.error).slice(0, 100)}`);
    const layers = (svc.layers ?? []) as { id: number; name: string }[];
    if (!layers.length) return fail("service exposes no layers");
    layer = `${url}/${layers[0].id}`;
    console.log(`  layer: ${layers[0].id} — ${layers[0].name}`);
  }

  const meta = await get(`${layer}?f=json`);
  if (meta.error) return fail(`layer error: ${JSON.stringify(meta.error).slice(0, 100)}`);

  const fields = ((meta.fields ?? []) as { name: string }[]).map((f) => f.name);
  const values = fields.filter((f) => VALUE_RE.test(f));
  const ids = fields.filter((f) => ID_RE.test(f));
  console.log(`  value fields: ${values.slice(0, 8).join(", ") || "(none)"}`);
  console.log(`  id fields:    ${ids.slice(0, 6).join(", ") || "(none)"}`);
  if (!values.length || !ids.length) return fail("missing a value field or an id field");

  const count = await get(`${layer}/query?where=1%3D1&returnCountOnly=true&f=json`);
  console.log(`  rows: ${(count.count as number)?.toLocaleString() ?? "?"}`);

  /*
   * Extent is a cheap sanity check against the wrong-state case. Reported as
   * information rather than enforced — a county centroid is not in the atlas, and
   * a wrong extent will fail the parcel test below anyway.
   */
  const ext = (count.extent ?? meta.extent) as { xmin: number; ymin: number } | undefined;
  if (ext) {
    // Only degrees when the numbers can be degrees. Layers commonly report Web
    // Mercator metres, and printing 3994433.50°N as a latitude is worse than
    // printing nothing — it looks like a checked fact and is not one.
    const degrees =
      Math.abs(ext.ymin) <= 90 && Math.abs(ext.xmin) <= 180
        ? `${ext.ymin.toFixed(2)}°N ${ext.xmin.toFixed(2)}°W`
        : `${Math.round(ext.xmin)}, ${Math.round(ext.ymin)} (projected, not degrees)`;
    console.log(`  extent origin: ${degrees}`);
  }

  const ours = (await db.execute(sql`
    SELECT l.parcel_number FROM lots l JOIN auctions a ON a.id = l.auction_id
    WHERE a.county_fips = ${fips} AND l.parcel_number IS NOT NULL AND l.status = 'pending'
    LIMIT 5`)) as unknown as { parcel_number: string }[];

  if (!ours.length) return fail("no pending parcels on record for this county to test against");
  console.log(`\n  our parcel ids: ${ours.map((o) => o.parcel_number).join(" | ")}`);

  let matched = 0;
  for (const lot of ours) {
    const raw = String(lot.parcel_number).trim();
    // Verbatim then digits-only, matching what the provider itself will try.
    for (const candidate of [...new Set([raw, raw.replace(/\D/g, "")])]) {
      let hit = false;
      for (const idf of ids.slice(0, 3)) {
        const where = encodeURIComponent(`${idf}='${candidate.replace(/'/g, "''")}'`);
        const r = await get(
          `${layer}/query?where=${where}&outFields=${idf},${values[0]}&returnGeometry=false&f=json`,
        );
        const feats = (r.features ?? []) as { attributes: Record<string, unknown> }[];
        if (feats.length === 1) {
          matched++;
          hit = true;
          console.log(`  MATCH ${idf}='${candidate}' -> ${JSON.stringify(feats[0].attributes)}`);
          break;
        }
      }
      if (hit) break;
    }
  }

  const theirs = await get(
    `${layer}/query?where=1%3D1&outFields=${ids[0]}&returnGeometry=false&resultRecordCount=3&f=json`,
  );
  const sample = ((theirs.features ?? []) as { attributes: Record<string, unknown> }[]).map(
    (f) => f.attributes[ids[0]],
  );
  console.log(`  their parcel ids: ${sample.join(" | ")}`);

  console.log(
    `\n  VERDICT: ${matched}/${ours.length} matched — ${
      matched === 0
        ? "DO NOT WIRE. Either the wrong county, or the sale list and the GIS number parcels differently."
        : matched < ours.length
          ? "partial; usable, expect this hit rate"
          : "usable"
    }`,
  );
  process.exit(0);
}

function fail(msg: string): never {
  console.log(`  VERDICT: unusable — ${msg}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
