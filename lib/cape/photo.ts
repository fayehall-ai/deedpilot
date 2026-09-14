/*
 * No `server-only` guard — this runs from the producer CLI under tsx.
 */
import photos from "@/data/county-photos.json";
import type { CountyPhoto } from "./slides";

/**
 * A photograph of the county, for the slide after the title.
 *
 * ## Why a catalogue rather than a live search
 *
 * `scripts/build-county-photos.ts` resolves one image per county and records
 * its licence and credit. Production then only fetches bytes. Two reasons: a
 * briefing must not fail because Wikimedia is slow, and — more importantly —
 * the judgement about what is safe to publish is made deliberately, in one
 * place, rather than by whatever a search returns on the day.
 *
 * ## What is in the catalogue, and what is not
 *
 * Public domain, CC0 and CC BY only. Not CC BY-SA, which is most of what
 * Commons holds for county courthouses: ShareAlike arguably makes a video that
 * embeds the photograph a derivative work, and these ship into a paid course.
 * Declining 197 of 365 counties' first-choice photographs is the cost of not
 * taking that on, and the Commons fallback is what recovers much of it.
 *
 * The credit travels with the image and is drawn onto the slide by
 * `photoSlideSvg`. A video has no caption field, so a credit stored anywhere
 * else would not survive the export.
 */
interface CatalogueEntry {
  file: string;
  url: string;
  licence: string;
  credit: string;
  source: string;
}

/* v1 of the file held one entry per county; v2 holds a list. */
const RAW = photos as Record<string, CatalogueEntry | CatalogueEntry[]>;
const CATALOGUE: Record<string, CatalogueEntry[]> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
);

export function hasCountyPhoto(fips: string | null | undefined): boolean {
  return Boolean(fips && CATALOGUE[fips]?.length);
}

/**
 * Fetch it, or return null.
 *
 * Never throws. A county with no safely-licensed photograph, a slow mirror or
 * a file that has since been deleted must not cost a briefing its video — the
 * slide is simply not rendered, and the deck is the one it was before.
 */
export async function countyPhotos(
  fips: string | null | undefined,
  countyName: string | null,
  state: string | null,
  opts: { timeoutMs?: number; max?: number } = {},
): Promise<CountyPhoto[]> {
  if (!fips) return [];
  const entries = (CATALOGUE[fips] ?? []).slice(0, opts.max ?? 4);
  const out: CountyPhoto[] = [];
  for (const entry of entries) {
    const one = await fetchOne(entry, countyName, state, opts.timeoutMs ?? 20_000);
    if (one) out.push(one);
  }
  return out;
}

async function fetchOne(
  entry: CatalogueEntry,
  countyName: string | null,
  state: string | null,
  timeoutMs: number,
): Promise<CountyPhoto | null> {
  if (!entry.url) return null;
  try {
    const res = await fetch(entry.url, {
      headers: { "User-Agent": "deedpilot/1.0 (county briefing imagery)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // An error page served with an image type would otherwise be encoded in.
    if (buf.length < 5_000) return null;

    const where = [countyName ? `${countyName} County` : null, state].filter(Boolean).join(", ");
    return {
      dataUri: `data:${type};base64,${buf.toString("base64")}`,
      caption: where || "County courthouse",
      credit: entry.credit,
    };
  } catch {
    return null;
  }
}
