/*
 * No `server-only` guard — this runs from the producer CLI under tsx.
 */
import { aerialUrl } from "@/lib/property/imagery";
import seats from "@/data/county-seats.json";

/**
 * The opening shot: an aerial of the county seat, behind the title card.
 *
 * ## Why the county seat and not the courthouse
 *
 * The ask was a photo of the courthouse, and that is not a thing this can
 * honestly supply. A photograph of a building belongs to whoever took it;
 * Wikimedia's courthouse pictures are mostly CC BY-SA, which is usable only
 * with the credit rendered on screen, and Google Street View's terms exclude
 * downloadable video outright. A briefing that ships into a paid course cannot
 * rest on either.
 *
 * What is free of all that is federal aerial imagery — the same USGS source
 * `lib/property/imagery.ts` already chose for parcels, and for the same reason:
 * public domain, no key, no metering, nationwide. Framed on the county seat it
 * shows the town the sale is administered from, which is what an establishing
 * shot is for.
 *
 * ## Why not the county centroid
 *
 * Because it is usually a field. A centroid is a geometric convenience, not a
 * place; for most counties it lands in farmland and says nothing. The seat is
 * where the courthouse, the treasurer and the sale itself actually are.
 *
 * ## Why it is the title card's backdrop rather than its own slide
 *
 * `video.ts` cuts the encode at the narration's own length. Slide time beyond
 * that is discarded from the end, so an extra silent slide would not add three
 * seconds — it would take three seconds off the closing slide. Behind the title
 * it costs no time at all.
 */
const SEATS = seats as Record<string, { seat: string; lat: number; lon: number }>;

/** Metres across. Wide enough to read as a town rather than a street. */
const SPAN_M = 1400;

export interface EstablishingShot {
  /** `data:` URI, since the SVG is rasterised without a base URL to resolve against. */
  dataUri: string;
  seat: string;
  /** Rendered on the card. Federal imagery still has to say what it is. */
  credit: string;
}

export function countySeat(fips: string | null | undefined): { seat: string; lat: number; lon: number } | null {
  if (!fips) return null;
  return SEATS[fips] ?? null;
}

/**
 * Fetch the shot, or return null.
 *
 * Never throws. A missing seat, a refused tile or a slow server must not cost a
 * briefing its video — the card renders perfectly well without a backdrop, and
 * a production run that fails on decoration is worse than a plain title.
 */
export async function establishingShot(
  fips: string | null | undefined,
  opts: { width?: number; height?: number; timeoutMs?: number } = {},
): Promise<EstablishingShot | null> {
  const seat = countySeat(fips);
  if (!seat) return null;

  const url = aerialUrl({
    latitude: seat.lat,
    longitude: seat.lon,
    span: SPAN_M,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
  });
  if (!url) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A tile server that answers with an error page would otherwise be encoded
    // into the video as a broken image.
    if (buf.length < 5_000) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return null;

    return {
      dataUri: `data:${type};base64,${buf.toString("base64")}`,
      seat: seat.seat,
      credit: "Aerial: USGS, public domain — flown on a cycle, not a current view",
    };
  } catch {
    return null;
  }
}
