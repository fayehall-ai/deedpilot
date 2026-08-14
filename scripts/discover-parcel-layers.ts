/**
 * Find and verify parcel layers for counties that still have no valuations.
 *
 *   npx tsx scripts/discover-parcel-layers.ts --state LA
 *   npx tsx scripts/discover-parcel-layers.ts --state SC --state NM --state MO
 *
 * Discovery alone is worse than useless, because the wrong answers look exactly
 * like the right ones. Searching "Greenville County South Carolina parcels"
 * returns the town of Greenville, *Florida*; searching Jefferson Parish returns
 * "Jeffco_Parcels", which is Jefferson County, **Colorado** — 248,974 real
 * parcels with real values and real addresses, 1,500 miles from the lots it
 * would have priced.
 *
 * So every candidate here is verified before it is reported, and the verdict is
 * the only thing worth reading.
 *
 * ## Terminology is part of the search, not a detail
 *
 * The first sweep asked for "<name> County <state>" everywhere. Louisiana has
 * parishes and Alaska has boroughs, so for an entire state the query described
 * something that does not exist — which is one reason Louisiana's 1,638 lots
 * came back with nothing usable. Each state's own word is used, plus a bare form
 * with no noun at all.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { ALL_COUNTIES } from "../lib/atlas";

const args = (n: string) => {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${n}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
};

/** What a state calls its counties. Getting this wrong searches for nothing. */
function subdivision(state: string): string {
  if (state === "LA") return "Parish";
  if (state === "AK") return "Borough";
  return "County";
}

async function get(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  return (await r.json()) as Record<string, unknown>;
}

const VALUE_RE = /val|assess|appr|^jv$|^av_|fmv|mkt|land|improv|total/i;
const ID_RE = /parcel|^pin$|apn|tms|prop_?id|pid/i;

interface Candidate { title: string; url: string; owner: string }

async function search(term: string): Promise<Candidate[]> {
  const q = encodeURIComponent(`${term} AND type:"Feature Service"`);
  try {
    const j = await get(`https://www.arcgis.com/sharing/rest/search?q=${q}&f=json&num=6`);
    return ((j.results ?? []) as { title: string; url?: string; owner: string }[])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title, url: r.url!, owner: r.owner }));
  } catch {
    return [];
  }
}

/**
 * Does this layer answer for OUR parcels?
 *
 * The only question that matters. A layer can be public, populated, correctly
 * named and still be the wrong place — and the parcel numbers say so
 * immediately, where a name never will.
 */
async function verify(url: string, fips: string): Promise<{ ok: boolean; note: string }> {
  let layer = url;
  try {
    if (!/\/\d+$/.test(url)) {
      const svc = await get(`${url}?f=json`);
      if (svc.error) return { ok: false, note: "service error" };
      const layers = (svc.layers ?? []) as { id: number }[];
      if (!layers.length) return { ok: false, note: "no layers" };
      layer = `${url}/${layers[0].id}`;
    }
    const meta = await get(`${layer}?f=json`);
    if (meta.error) return { ok: false, note: "token required or unreadable" };

    const fields = ((meta.fields ?? []) as { name: string }[]).map((f) => f.name);
    const values = fields.filter((f) => VALUE_RE.test(f));
    const ids = fields.filter((f) => ID_RE.test(f));
    if (!values.length || !ids.length) return { ok: false, note: "no value or id field" };

    const ours = (await db.execute(sql`
      SELECT l.parcel_number FROM lots l JOIN auctions a ON a.id = l.auction_id
      WHERE a.county_fips = ${fips} AND l.parcel_number IS NOT NULL AND l.status = 'pending'
      LIMIT 3`)) as unknown as { parcel_number: string }[];
    if (!ours.length) return { ok: false, note: "no parcels on record to test" };

    for (const lot of ours) {
      const raw = String(lot.parcel_number).trim();
      for (const cand of [...new Set([raw, raw.replace(/\D/g, "")])]) {
        for (const idf of ids.slice(0, 3)) {
          const where = encodeURIComponent(`${idf}='${cand.replace(/'/g, "''")}'`);
          const r = await get(`${layer}/query?where=${where}&outFields=${idf},${values[0]}&returnGeometry=false&f=json`);
          if (((r.features ?? []) as unknown[]).length === 1) {
            return { ok: true, note: `matched on ${idf} — ${layer}` };
          }
        }
      }
    }
    return { ok: false, note: "reachable, but none of our parcels resolve" };
  } catch {
    return { ok: false, note: "unreachable" };
  }
}

async function main() {
  const states = args("state").map((s) => s.toUpperCase());
  if (!states.length) { console.error("usage: --state XX [--state YY]"); process.exit(1); }

  for (const state of states) {
    const fipsIn = ALL_COUNTIES.filter((c) => c.state === state).map((c) => c.fips);
    if (!fipsIn.length) continue;
    const rows = (await db.execute(sql`
      SELECT a.county_fips, count(*)::int lots
      FROM lots l JOIN auctions a ON a.id = l.auction_id
      WHERE l.status = 'pending' AND l.assessed_value IS NULL
        AND a.county_fips IN (${sql.join(fipsIn.map((f) => sql`${f}`), sql`, `)})
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)) as unknown as { county_fips: string; lots: number }[];

    console.log(`\n=== ${state} — ${rows.length} counties still without values`);
    for (const row of rows) {
      const c = ALL_COUNTIES.find((x) => x.fips === row.county_fips)!;
      const noun = subdivision(state);
      console.log(`\n  ${c.name} (${row.lots} lots)`);

      const seen = new Set<string>();
      let found = false;
      for (const term of [
        `${c.name} ${noun} ${state} parcels`,
        `${c.name} ${noun} parcels assessor`,
        `${c.name} parcels ${state}`,
      ]) {
        for (const cand of await search(term)) {
          if (seen.has(cand.url)) continue;
          seen.add(cand.url);
          const v = await verify(cand.url, row.county_fips);
          if (v.ok) { console.log(`    USABLE  ${cand.title.slice(0, 40)} — ${v.note}`); found = true; break; }
        }
        if (found) break;
      }
      if (!found) console.log(`    none of ${seen.size} candidate(s) resolved our parcels`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
