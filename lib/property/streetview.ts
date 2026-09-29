/**
 * Google Street View of a parcel's front, for the parcel page.
 *
 * Env: GOOGLE_MAPS_API_KEY — restrict it to the Street View Static API.
 *
 * Aimed by address, not by coordinates. Aiming from the panorama at the
 * parcel's coordinates framed the gap between 2201 Crossrail Dr and its
 * neighbour: a parcel point is the lot's centroid, not its front door. Given an
 * address and no heading, Google turns the camera to the building itself.
 *
 * Nothing here is stored. Google's terms do not allow keeping the images, so
 * the page asks the free metadata endpoint whether there is a photograph, and
 * the image itself is fetched through `/api/lots/[id]/streetview` on each view,
 * which keeps the key off the page. Metadata calls are free; images are billed.
 */

const BASE = "https://maps.googleapis.com/maps/api/streetview";

export function streetViewKey(): string | null {
  return (process.env.GOOGLE_MAPS_API_KEY ?? "").trim() || null;
}

/**
 * The address to aim at, or null when there is nothing a camera can face: no
 * house number, or no city or ZIP to say which street of that name it is. A
 * street name alone matches the whole road.
 */
export function streetViewLocation(lot: {
  addressLine: string | null;
  city: string | null;
  zip: string | null;
  state: string;
}): string | null {
  const street = lot.addressLine?.trim();
  if (!street || !/^[1-9]\d*[A-Z]?\s+\S/i.test(street)) return null;
  const city = lot.city?.trim();
  const zip = lot.zip?.trim();
  if (!city && !zip) return null;
  return [street, city, [lot.state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

export interface StreetViewMeta {
  /** YYYY-MM when Google photographed it — shown, because a 2019 photo is not today. */
  date: string | null;
  panoId: string | null;
  /** Where the camera stood. */
  lat: number | null;
  lng: number | null;
}

/**
 * Key for the interactive Street View embed, which sits in the page's HTML.
 *
 * A separate key from the server's on purpose: this one must be restricted to
 * the site's domain, and a domain-restricted key refuses server calls, which
 * send no referrer — so the metadata check needs the other. Unset, the page
 * falls back to the static photograph.
 */
export function streetViewEmbedKey(): string | null {
  return (process.env.GOOGLE_MAPS_EMBED_KEY ?? "").trim() || null;
}

/**
 * Compass bearing from the camera to the parcel, so the panorama opens facing
 * the house. The parcel point is the lot's centroid, not its front door, so it
 * can sit a little off — the viewer can be turned.
 */
export function headingTo(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const y = Math.sin((to.lng - from.lng) * r) * Math.cos(to.lat * r);
  const x =
    Math.cos(from.lat * r) * Math.sin(to.lat * r) -
    Math.sin(from.lat * r) * Math.cos(to.lat * r) * Math.cos((to.lng - from.lng) * r);
  return Math.round(((Math.atan2(y, x) / r + 360) % 360) * 10) / 10;
}

/** The interactive panorama, free under the Maps Embed API. */
export function streetViewEmbedUrl(opts: { panoId: string; heading?: number; key: string }): string {
  const q = new URLSearchParams({ key: opts.key, pano: opts.panoId, pitch: "0", fov: "80" });
  if (opts.heading !== undefined) q.set("heading", String(opts.heading));
  return `https://www.google.com/maps/embed/v1/streetview?${q}`;
}

/** Whether Google has an outdoor photograph near the address. Free. */
export async function streetViewMetadata(location: string): Promise<StreetViewMeta | null> {
  const key = streetViewKey();
  if (!key) return null;
  const url = `${BASE}/metadata?${new URLSearchParams({ location, source: "outdoor", key })}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      date?: string;
      pano_id?: string;
      location?: { lat?: number; lng?: number };
    };
    return body.status === "OK"
      ? {
          date: body.date ?? null,
          panoId: body.pano_id ?? null,
          lat: body.location?.lat ?? null,
          lng: body.location?.lng ?? null,
        }
      : null;
  } catch {
    return null;
  }
}

/** The image request. Billed per call. */
export function streetViewImageUrl(location: string, key: string): string {
  return `${BASE}?${new URLSearchParams({
    size: "640x400",
    location,
    source: "outdoor",
    fov: "70",
    pitch: "5",
    key,
  })}`;
}
