/**
 * Resolve one safely-licensed photograph per county, once, into
 * `data/county-photos.json`.
 *
 *   npx tsx scripts/build-county-photos.ts
 *
 * ## Why a catalogue and not a lookup at produce time
 *
 * A briefing must not depend on Wikimedia answering. Resolving licences here
 * means the producer only ever fetches image bytes by URL, and the decision
 * about what is safe to use was made deliberately rather than per run.
 *
 * ## What counts as safe
 *
 * Public domain, CC0 and CC BY. Deliberately NOT CC BY-SA: ShareAlike
 * arguably makes a briefing that embeds the photo a derivative work, which
 * would oblige licensing the whole video CC BY-SA. These ship into a paid
 * course. 197 of 365 counties in the current window have a ShareAlike photo as
 * their Wikidata image, which is exactly why the Commons fallback exists.
 *
 * Attribution is captured for every entry, including the public-domain ones
 * where it is courtesy rather than obligation.
 *
 * ## Pace
 *
 * `--window` restricts the fallback search to counties with a confirmed sale
 * in the next eight weeks — a few hundred requests rather than three thousand.
 * The first run of this script did the latter at 120ms apart and Commons
 * throttled it: 87 hits in 3,146 attempts, where the same search by hand
 * succeeds immediately. `!res.ok` returning null made that look like absence
 * rather than refusal. Results merge into any existing catalogue, so a scoped
 * run tops up rather than replacing.
 */
import "../lib/env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const UA = { "User-Agent": "deedpilot/1.0 (county briefing imagery; contact via thetaxdeedcollective.com)" };
const SAFE = /^(public domain|cc0|cc by [0-9.]+|no restrictions|copyrighted free use|attribution)$/i;
/* Commons holds books and scans in the same namespace; only bitmaps are usable. */
const IS_PHOTO = /\.(jpe?g|png)$/i;

interface Entry { file: string; url: string; licence: string; credit: string; source: "wikidata" | "commons"; }

const strip = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

async function imageinfo(titles: string[]) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
    "&iiprop=url|extmetadata&iiurlwidth=1920&titles=" + encodeURIComponent(titles.join("|"));
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const d = (await res.json()) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  return Object.values(d.query?.pages ?? {});
}

function toEntry(p: Record<string, unknown>, source: Entry["source"]): Entry | null {
  const ii = (p.imageinfo as Record<string, unknown>[] | undefined)?.[0];
  if (!ii) return null;
  const meta = (ii.extmetadata ?? {}) as Record<string, { value?: string }>;
  const licence = strip(meta.LicenseShortName?.value ?? "");
  if (!SAFE.test(licence)) return null;
  const title = String(p.title ?? "");
  if (!IS_PHOTO.test(title)) return null;
  const artist = strip(meta.Artist?.value ?? "") || "Wikimedia Commons";
  return {
    file: title.replace(/^File:/, ""),
    url: String(ii.thumburl ?? ii.url ?? "").split("?")[0],
    licence,
    credit: `${artist} — ${licence}, via Wikimedia Commons`,
    source,
  };
}

async function fallback(county: string, state: string): Promise<Entry | null> {
  const q = `${county} County ${state} courthouse`;
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
    `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=25` +
    "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1920";
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const d = (await res.json()) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  const pages = Object.values(d.query?.pages ?? {});
  // Prefer something that names the county: a search for "Foo County courthouse"
  // will happily return a courthouse in the next state over.
  const named = pages.filter((p) => String(p.title ?? "").toLowerCase().includes(county.toLowerCase()));
  for (const p of [...named, ...pages]) {
    const e = toEntry(p, "commons");
    if (e) return e;
  }
  return null;
}

async function main() {
  const seats = (await import("../data/county-seats.json")).default as Record<string, { seat: string }>;
  const q = "SELECT ?fips ?img ?cLabel ?sLabel WHERE { ?c wdt:P882 ?fips . ?c wdt:P18 ?img . ?c wdt:P131 ?s . SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". } } LIMIT 5000";
  const res = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: UA });
  const sparql = (await res.json()) as { results: { bindings: Record<string, { value: string }>[] } };

  const primary = new Map<string, { file: string; county: string; state: string }>();
  for (const r of sparql.results.bindings) {
    const fips = String(r.fips.value).padStart(5, "0");
    if (primary.has(fips)) continue;
    primary.set(fips, {
      file: "File:" + decodeURIComponent(r.img.value.split("/").pop()!).replace(/_/g, " "),
      county: (r.cLabel?.value ?? "").replace(/ County$/i, ""),
      state: r.sLabel?.value ?? "",
    });
  }
  console.log(`counties with a Wikidata image: ${primary.size}`);

  const out: Record<string, Entry> = existsSync("data/county-photos.json")
    ? (JSON.parse(readFileSync("data/county-photos.json", "utf8")) as Record<string, Entry>)
    : {};
  console.log(`existing catalogue entries: ${Object.keys(out).length}`);
  const fips = [...primary.keys()];
  let needFallback: string[] = [];

  for (let i = 0; i < fips.length; i += 45) {
    const batch = fips.slice(i, i + 45);
    const pages = await imageinfo(batch.map((f) => primary.get(f)!.file));
    const byTitle = new Map(pages.map((p) => [String(p.title ?? ""), p]));
    for (const f of batch) {
      const p = byTitle.get(primary.get(f)!.file);
      const e = p ? toEntry(p, "wikidata") : null;
      if (e) out[f] = e;
      else needFallback.push(f);
    }
    if (i % 450 === 0) process.stdout.write(`  primary pass ${i}/${fips.length}\r`);
  }
  console.log(`\nsafe from the Wikidata image: ${Object.keys(out).length}`);
  console.log(`needing a Commons fallback:   ${needFallback.length}`);

  // Only chase a fallback where a seat exists — those are the counties we ship.
  needFallback = needFallback.filter((f) => seats[f] && !out[f]);

  if (process.argv.includes("--window")) {
    const { db } = await import("../lib/db");
    const { auctions } = await import("../lib/db/schema");
    const { hasParcels, isConfirmedInventory } = await import("../lib/db/inventory");
    const { and, gte, lte, sql: dsql } = await import("drizzle-orm");
    const rows = await db
      .selectDistinct({ fips: auctions.countyFips })
      .from(auctions)
      .where(
        and(
          gte(auctions.saleDate, dsql`current_date`),
          lte(auctions.saleDate, dsql`current_date + 56`),
          hasParcels(),
          isConfirmedInventory(),
        ),
      );
    const window = new Set(rows.map((r) => r.fips));
    needFallback = needFallback.filter((f) => window.has(f));
    console.log(`scoped to the eight-week window: ${needFallback.length} county(s) to search`);
  }
  let found = 0;
  for (const [n, f] of needFallback.entries()) {
    const { county, state } = primary.get(f)!;
    if (!county || !state) continue;
    const e = await fallback(county, state);
    if (e) { out[f] = e; found++; }
    if (n % 25 === 0) process.stdout.write(`  fallback ${n}/${needFallback.length} (found ${found})\r`);
    await new Promise((r) => setTimeout(r, 400)); // polite to Commons, and not throttled
  }
  console.log(`\nfallback found: ${found}`);
  writeFileSync("data/county-photos.json", JSON.stringify(out));
  console.log(`total counties with a safe photo: ${Object.keys(out).length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
