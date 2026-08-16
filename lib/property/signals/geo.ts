/**
 * Distances on the ground, for features that are lines and areas rather than points.
 *
 * ## The trap this module exists to avoid
 *
 * The first probe run reported a rail line 745 metres from an Arkansas parcel
 * — inside a query whose radius was 600 metres. Both numbers were right and
 * they measured different things. Overpass's `around:` filter tests every node
 * of a way, so the line genuinely passed within 600m; the 745m came from
 * measuring to the way's `center`, which for a railway subdivision running
 * thirty kilometres across a county is a point somewhere in the next township.
 *
 * A railway is a line. The distance a bidder cares about is to the nearest
 * point on that line, not to the midpoint of whatever arbitrary extent the
 * mapper happened to draw in one OSM way. Reporting the centre distance would
 * have understated every road and railway in the database and overstated the
 * rest at random, and it would have done so plausibly — the failure would have
 * looked like data, not like a bug.
 *
 * So every distance here is computed against the feature's real geometry:
 * point to point, point to polyline, point to polygon.
 */

export interface LatLon {
  latitude: number;
  longitude: number;
}

/** Metres per degree of latitude. Constant enough at any latitude. */
const M_PER_DEG_LAT = 110_574;

/**
 * A local flat-earth projection, anchored at the parcel.
 *
 * Haversine is the textbook answer and is wrong for this job in one way that
 * matters: it is a great-circle distance between two points, and what is needed
 * here is the distance from a point to a *segment*, which has no closed form on
 * a sphere. Projecting to a local tangent plane makes the segment problem
 * ordinary plane geometry.
 *
 * The approximation costs accuracy proportional to distance, and everything
 * measured here is within a few kilometres of the anchor — where the error is
 * under a tenth of a percent, or well under a metre at 800m. That is far below
 * the precision of the underlying data: an OSM way is drawn by hand from
 * aerial imagery and a parcel centroid is an assessor's approximation of a
 * polygon.
 */
function projector(anchor: LatLon) {
  const mPerDegLon = 111_320 * Math.cos((anchor.latitude * Math.PI) / 180);
  return (p: { lat: number; lon: number }) => ({
    x: (p.lon - anchor.longitude) * mPerDegLon,
    y: (p.lat - anchor.latitude) * M_PER_DEG_LAT,
  });
}

/** Straight-line ground distance between two coordinates, in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const project = projector(a);
  const { x, y } = project({ lat: b.latitude, lon: b.longitude });
  return Math.hypot(x, y);
}

/** Shortest distance from the origin to the segment pq, both already projected. */
function pointToSegment(
  p: { x: number; y: number },
  q: { x: number; y: number },
): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const lenSq = dx * dx + dy * dy;
  // A degenerate segment — two identical nodes — is just a point.
  if (lenSq === 0) return Math.hypot(p.x, p.y);
  /*
   * Projection of the origin onto the infinite line, clamped to [0,1] so the
   * answer stays on the drawn segment. Without the clamp a rail line that runs
   * past the parcel and stops would report the distance to a phantom
   * continuation of itself.
   */
  let t = -(p.x * dx + p.y * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x + t * dx, p.y + t * dy);
}

/**
 * Distance from a parcel to a way, measured to the nearest point on the way.
 *
 * Returns `undefined` for an empty geometry rather than a sentinel distance:
 * a way whose nodes Overpass did not return is a fact we do not have, and a
 * fabricated 0 or Infinity would both be acted on as though we did.
 */
export function distanceToPath(from: LatLon, path: { lat: number; lon: number }[]): number | undefined {
  if (!path || path.length === 0) return undefined;
  const project = projector(from);
  const pts = path.map(project);
  if (pts.length === 1) return Math.hypot(pts[0].x, pts[0].y);

  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointToSegment(pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : undefined;
}

/**
 * Distance from a parcel to an area.
 *
 * Zero when the parcel is inside it, which is the answer that carries the most
 * information here: a lot whose own polygon sits inside an industrial land-use
 * area is not "near industry", it *is* industry, and that is a zoning fact
 * about the parcel rather than a proximity fact about its neighbours.
 */
export function distanceToArea(from: LatLon, ring: { lat: number; lon: number }[]): number | undefined {
  if (!ring || ring.length < 3) return undefined;
  if (pointInRing(from, ring)) return 0;
  return distanceToPath(from, [...ring, ring[0]]);
}

/**
 * Even-odd ray casting, in degrees.
 *
 * Run on raw coordinates rather than projected ones on purpose: containment is
 * a topological question and survives the distortion, while projecting first
 * would add an anchor-dependent step to an answer that does not need one.
 */
export function pointInRing(p: LatLon, ring: { lat: number; lon: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lon;
    const yj = ring[j].lat;
    const xj = ring[j].lon;
    const straddles = yi > p.latitude !== yj > p.latitude;
    if (!straddles) continue;
    const xCross = ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi;
    if (p.longitude < xCross) inside = !inside;
  }
  return inside;
}

/**
 * The distance to report for an OSM element, whatever shape it came back as.
 *
 * Overpass answers a mixed query with three shapes — a node with `lat`/`lon`,
 * a way with a `geometry` node list, and a relation with `members`. Callers
 * should not have to branch on all three to ask one question.
 */
export function elementDistance(
  from: LatLon,
  el: {
    type?: string;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    geometry?: { lat: number; lon: number }[];
    members?: { geometry?: { lat: number; lon: number }[] }[];
  },
): number | undefined {
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return distanceM(from, { latitude: el.lat, longitude: el.lon });
  }

  if (el.geometry?.length) {
    /*
     * A closed way is an area, not a line. Treating a landfill boundary as a
     * polyline would report the distance to its fence when the parcel is
     * standing in the middle of it.
     */
    const g = el.geometry;
    const closed =
      g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    return closed ? distanceToArea(from, g) : distanceToPath(from, g);
  }

  if (el.members?.length) {
    let best: number | undefined;
    for (const m of el.members) {
      if (!m.geometry?.length) continue;
      const d = distanceToPath(from, m.geometry);
      if (d !== undefined && (best === undefined || d < best)) best = d;
    }
    if (best !== undefined) return best;
  }

  /*
   * `center` last, and only as a fallback, because it is the number that
   * produced the 745m-inside-a-600m-radius reading. Kept because a relation
   * with no member geometry has nothing else to offer, and an approximate
   * distance beats dropping a real feature.
   */
  if (el.center) return distanceM(from, { latitude: el.center.lat, longitude: el.center.lon });

  return undefined;
}
