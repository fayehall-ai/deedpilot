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

/**
 * Safely licensed, of the right building, and still the wrong image.
 *
 * Shawnee County's first pick was "Shawnee County Courthouse, by Leonard &
 * Martin" — public domain, correctly named, genuinely the courthouse, and a
 * Victorian stereoscopic card: the same building printed twice side by side
 * with the mount's yellowed border in frame. It went into a 2026 briefing.
 *
 * Nothing in the filename says so. The signal is in the metadata Commons
 * already returns — the file sits in "Robert N. Dennis collection of
 * stereoscopic views" and "Topeka, Kansas, in the 19th century", is catalogued
 * as an artwork rather than a photograph, and carries a PD-scan tag and a date
 * of "1869?-1880?".
 *
 * So the test is over everything Commons says about the file, not just its
 * name. A scan of a physical artefact, an engraving, a postcard or a
 * nineteenth-century view is a fine thing and not what belongs behind a title
 * card about next month's auction.
 */
const NOT_A_USABLE_PHOTO =
  /stereo(scop|graph|view)|lithograph|engrav|woodcut|etching|\bdrawing\b|\bsketch\b|\bpainting\b|postcard|\bplate\b|illustration|pd-scan|artworks?\b|19th century|18[0-9]{2}s?\b|\bmap\b|\bseal\b|\bflag\b|coat of arms|\blogo\b/i;

/** Everything Commons will tell us about a file, as one string to test. */
function provenance(meta: Record<string, { value?: string }>, title: string): string {
  const field = (k: string) => String(meta[k]?.value ?? "").replace(/<[^>]+>/g, " ");
  return [
    title,
    field("Categories"),
    field("ObjectName"),
    field("ImageDescription"),
    field("DateTimeOriginal"),
    field("Credit"),
  ].join(" ");
}

interface Entry { file: string; url: string; licence: string; credit: string; source: "wikidata" | "commons"; }

/** How many photographs are worth keeping for one county. */
const PER_COUNTY = 4;

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
  /* Right building, wrong artefact — see NOT_A_USABLE_PHOTO. */
  if (NOT_A_USABLE_PHOTO.test(provenance(meta, title))) return null;
  const artist = strip(meta.Artist?.value ?? "") || "Wikimedia Commons";
  return {
    file: title.replace(/^File:/, ""),
    url: String(ii.thumburl ?? ii.url ?? "").split("?")[0],
    licence,
    credit: `${artist} — ${licence}, via Wikimedia Commons`,
    source,
  };
}

/**
 * Counties where Commons refused to answer, as distinct from counties with
 * nothing to find. Reported at the end so a throttled run can never again be
 * read as an empty one.
 */
const refused: string[] = [];

/**
 * The county seat, when the courthouse search comes back empty.
 *
 * Shawnee County, Kansas has exactly one usable modern photograph of its
 * courthouse on Commons and it is CC BY-SA, which this file refuses. What is
 * left is a Victorian stereoscopic card. Neither is what belongs behind a title
 * card, and "no image" was the honest third option until it was clear that
 * Topeka — the county seat, and a real city with a skyline — is photographed
 * plentifully and freely.
 *
 * A picture of the seat is not a picture of the courthouse, and that is fine:
 * the slide's job is to say where this sale is, and the county seat says it.
 *
 * Kept as a fallback rather than a peer, because the courthouse is the better
 * answer when it exists — it is the building the sale is usually held at.
 */
async function seatFallback(seat: string, state: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const q of [`${seat} ${state} downtown`, `${seat} ${state} skyline`, `${seat} ${state}`]) {
    for (const e of await searchCommons(q, seat)) {
      if (!out.some((x) => x.file === e.file)) out.push(e);
      if (out.length >= PER_COUNTY) return out;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  return out;
}

/** One Commons search, filtered. Shared by the courthouse and seat passes. */
async function searchCommons(q: string, mustName: string): Promise<Entry[]> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
    `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=25` +
    "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1920";
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, { headers: UA });
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (!res || !res.ok) { refused.push(`${q}${res ? ` (HTTP ${res.status})` : ""}`); return []; }
  const d = (await res.json()) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  const pages = Object.values(d.query?.pages ?? {});
  /*
   * Insist the file names the place. "Topeka Kansas courthouse" returns a
   * Wabaunsee County courthouse, and a briefing that opens on the wrong
   * county's building is worse than one that opens on type.
   */
  const named = pages.filter((p) =>
    String(p.title ?? "").toLowerCase().includes(mustName.toLowerCase()));
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const p of named) {
    const e = toEntry(p, "commons");
    if (e && !seen.has(e.file)) { seen.add(e.file); out.push(e); }
    if (out.length >= PER_COUNTY) break;
  }
  return out;
}

async function fallback(county: string, state: string): Promise<Entry[]> {
  const q = `${county} County ${state} courthouse`;
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
    `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=25` +
    "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1920";

  /*
   * Retry, and say so when it still fails.
   *
   * This file's header already recorded that Commons throttles a fast run —
   * 87 hits in 3,146 attempts — and the response was to slow down. That was
   * not enough: a 192-county pass at 400ms found 16, and every one of the 176
   * misses looked identical to a county with no photograph. Shawnee, Harris
   * and Brevard all shipped a briefing with no imagery on that basis, and all
   * three have a safely-licensed courthouse photo that the same request
   * returns on the next try.
   *
   * A refusal and an absence are different facts. Retrying turns most refusals
   * into answers; recording the rest stops the remainder being mistaken for
   * absence.
   */
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, { headers: UA });
    if (res.ok) break;
    /* 429 and 5xx are worth waiting out; a 404 is not. */
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (!res || !res.ok) {
    refused.push(`${county}, ${state}${res ? ` (HTTP ${res.status})` : ""}`);
    return [];
  }
  const d = (await res.json()) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  const pages = Object.values(d.query?.pages ?? {});
  /*
   * Prefer something that names the county: a search for "Foo County
   * courthouse" will happily return a courthouse in the next state over.
   *
   * Every safe hit is kept, not just the first. One search is one request
   * against a service that throttles, so taking four photographs from it
   * instead of one is the difference between a county having a sequence and
   * having a single card.
   */
  const named = pages.filter((p) => String(p.title ?? "").toLowerCase().includes(county.toLowerCase()));
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const p of [...named, ...pages]) {
    const e = toEntry(p, "commons");
    if (e && !seen.has(e.file)) { seen.add(e.file); out.push(e); }
    if (out.length >= PER_COUNTY) break;
  }
  return out;
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

  const raw = existsSync("data/county-photos.json")
    ? (JSON.parse(readFileSync("data/county-photos.json", "utf8")) as Record<string, Entry | Entry[]>)
    : {};
  // The first version of this file held one entry per county.
  const out: Record<string, Entry[]> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v : [v];
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
      if (e) out[f] = [e, ...(out[f] ?? []).filter((x) => x.file !== e.file)].slice(0, PER_COUNTY);
      // A county with a usable primary still benefits from a few more.
      if (!e || (out[f]?.length ?? 0) < PER_COUNTY) needFallback.push(f);
    }
    if (i % 450 === 0) process.stdout.write(`  primary pass ${i}/${fips.length}\r`);
  }
  console.log(`\nsafe from the Wikidata image: ${Object.keys(out).length}`);
  console.log(`needing a Commons fallback:   ${needFallback.length}`);

  // Only chase a fallback where a seat exists — those are the counties we ship.
  needFallback = needFallback.filter((f) => seats[f] && (out[f]?.length ?? 0) < PER_COUNTY);

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
    let found_ = await fallback(county, state);
    if (!found_.length) {
      const seat = seats[f]?.seat;
      if (seat) {
        await new Promise((r) => setTimeout(r, 900));
        found_ = await seatFallback(seat, state);
        if (found_.length) console.log(`\n  ${county}, ${state}: no usable courthouse photo — used ${seat}`);
      }
    }
    if (found_.length) {
      const merged = [...(out[f] ?? [])];
      for (const e of found_) if (!merged.some((x) => x.file === e.file)) merged.push(e);
      out[f] = merged.slice(0, PER_COUNTY);
      found++;
    }
    if (n % 25 === 0) process.stdout.write(`  fallback ${n}/${needFallback.length} (found ${found})\r`);
    await new Promise((r) => setTimeout(r, 900)); // Commons throttles below about this
  }
  console.log(`\nfallback found: ${found}`);
  if (refused.length) {
    console.log(
      `\n${refused.length} county(s) were REFUSED by Commons, not found empty — ` +
      `re-run to pick them up:`);
    for (const r of refused.slice(0, 12)) console.log(`  ${r}`);
    if (refused.length > 12) console.log(`  …and ${refused.length - 12} more`);
  }
  writeFileSync("data/county-photos.json", JSON.stringify(out));
  const total = Object.values(out).reduce((n, v) => n + v.length, 0);
  console.log(`counties with a safe photo: ${Object.keys(out).length}   photographs: ${total}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
