/**
 * Aerial imagery for a parcel, from federal public-domain sources.
 *
 * ## Why aerial rather than a street photo
 *
 * The obvious reading of "photo of a property" is a picture of the house, and
 * for a normal listing it would be. Tax deed inventory is not normal listing
 * inventory: a large share of these parcels are vacant land, landlocked strips,
 * or lots whose structure has already been demolished. Google Street View
 * answers "what does the front of the house look like" — a question that has no
 * answer for a fifth of an acre of scrub in Catron County, and it is metered per
 * request besides.
 *
 * An overhead frame answers the questions this audience actually has before
 * bidding: is anything built on it, does a road reach it, what is next door,
 * and how big is it really. Those are the questions that decide whether a
 * parcel is worth attending the sale for.
 *
 * ## Why USGS
 *
 * `basemap.nationalmap.gov` serves NAIP and related imagery as a federal work.
 * That means:
 *
 *   - public domain — no licence to breach in a commercial product
 *   - no API key, so nothing to rotate, leak, or gate a deploy on
 *   - no metering, which is the whole reason ATTOM is gone
 *   - nationwide, including the rural counties that carry most of our inventory
 *
 * Esri's World Imagery is sharper in places and was the first candidate, but its
 * terms restrict direct tile access outside ArcGIS applications. Public domain
 * with no asterisk is worth more here than a slightly crisper pixel.
 *
 * ## What this deliberately does not claim
 *
 * Aerial imagery is flown on a cycle, not live. A parcel photographed two
 * summers ago may since have been cleared, built on, or burned. Every surface
 * that renders one of these must say so — see `components/parcel-imagery.tsx`,
 * which carries the caveat as part of the frame rather than as fine print.
 *
 * Nothing here should ever be described as "current" or as evidence of
 * condition. It is a photograph of a place at an unstated time.
 */

/** Federal imagery, public domain, no key. */
const USGS_IMAGERY =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export";

export interface ImageryFrame {
  /** Metres across the frame, roughly, at the equator-corrected longitude span. */
  span: number;
  label: string;
}

/**
 * Two frames, because one cannot answer both questions.
 *
 * The close frame shows whether anything is built and how the lot is shaped.
 * The wide frame shows access, neighbours and whether the parcel is isolated —
 * which is what separates a buildable lot from a landlocked one.
 */
export const FRAMES: ImageryFrame[] = [
  { span: 160, label: "The parcel" },
  { span: 700, label: "What is around it" },
];

/**
 * A metre-to-degree conversion that accounts for latitude.
 *
 * A degree of longitude is 111.32km at the equator and about half that in
 * northern Michigan, which is where a fixed degree span would silently render
 * our Michigan inventory at twice the intended zoom of our Texas inventory.
 */
function degreeSpan(metres: number, latitude: number): { dLat: number; dLon: number } {
  const dLat = metres / 111_320;
  const dLon = metres / (111_320 * Math.cos((latitude * Math.PI) / 180));
  return { dLat, dLon };
}

export interface ImageryOptions {
  latitude: number;
  longitude: number;
  /** Metres across. Defaults to the close frame. */
  span?: number;
  width?: number;
  height?: number;
}

/**
 * The URL for one aerial frame.
 *
 * Returns null rather than a broken URL when the coordinates are not usable —
 * a (0, 0) pair is the classic "geocoder returned nothing and someone stored it
 * anyway", and it renders as a patch of the Atlantic rather than a property.
 */
export function aerialUrl({
  latitude,
  longitude,
  span = FRAMES[0].span,
  width = 640,
  height = 420,
}: ImageryOptions): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Null Island, and anything outside the imagery's actual footprint.
  if (latitude === 0 && longitude === 0) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const { dLat, dLon } = degreeSpan(span, latitude);
  // The frame is wider than it is tall, so the longitude half-span is scaled to
  // the aspect ratio; without this the image is stretched rather than framed.
  const halfLon = (dLon / 2) * (width / height);
  const halfLat = dLat / 2;

  const bbox = [
    longitude - halfLon,
    latitude - halfLat,
    longitude + halfLon,
    latitude + halfLat,
  ].join(",");

  const params = new URLSearchParams({
    bbox,
    bboxSR: "4326",
    imageSR: "3857",
    size: `${width},${height}`,
    format: "jpg",
    transparent: "false",
    f: "image",
  });

  return `${USGS_IMAGERY}?${params}`;
}

/** Whether a record carries coordinates good enough to render. */
export function hasUsableCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): latitude is number {
  return (
    aerialUrl({
      latitude: Number(latitude),
      longitude: Number(longitude),
    }) !== null
  );
}
