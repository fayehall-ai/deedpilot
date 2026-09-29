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
 * What to aim at, and how to name it on the page.
 *
 * The address when it can be used — a house number, and a city or ZIP to say
 * which street of that name; Google then turns the camera to the building. A
 * street name alone matches the whole road. Without one, the parcel's
 * coordinates, so an enriched parcel with no usable address — land, mostly —
 * still shows the road frontage nearest it.
 */
export function streetViewLocation(lot: {
  addressLine: string | null;
  city: string | null;
  zip: string | null;
  state: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
}): { query: string; label: string } | null {
  const street = lot.addressLine?.trim();
  const city = lot.city?.trim();
  const zip = lot.zip?.trim();
  if (street && /^[1-9]\d*[A-Z]?\s+\S/i.test(street) && (city || zip)) {
    const address = [street, city, [lot.state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return { query: address, label: address };
  }
  const lat = Number(lot.latitude);
  const lng = Number(lot.longitude);
  if (lot.latitude != null && lot.longitude != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { query: `${lat},${lng}`, label: "the road nearest this parcel" };
  }
  return null;
}

export interface StreetViewMeta {
  /** YYYY-MM when Google photographed it — shown, because a 2019 photo is not today. */
  date: string | null;
}

/** Whether Google has an outdoor photograph near the address. Free. */
export async function streetViewMetadata(location: string): Promise<StreetViewMeta | null> {
  const key = streetViewKey();
  if (!key) return null;
  const url = `${BASE}/metadata?${new URLSearchParams({ location, source: "outdoor", key })}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; date?: string };
    return body.status === "OK" ? { date: body.date ?? null } : null;
  } catch {
    return null;
  }
}

/** The image request. Billed per call. */
export function streetViewImageUrl(location: string, key: string): string {
  /*
   * The house, not the street. Google caps the image at 640 pixels, so they
   * are spent on the building: a 50° field of view framed 2201 Crossrail Dr
   * from roof to front steps, where 70° spread the same pixels across both
   * neighbours and read as a smudge. Tilted up a little for a two-storey front.
   */
  return `${BASE}?${new URLSearchParams({
    size: "640x480",
    location,
    source: "outdoor",
    fov: "50",
    pitch: "8",
    key,
  })}`;
}
