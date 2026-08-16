/**
 * Distance assertions.
 * Run: npx tsx lib/property/signals/geo.test.ts
 *
 * The first case is the bug that prompted the module: a probe reported a rail
 * line 745m from a parcel inside a 600m query radius, because it measured to
 * the way's centre rather than to the line.
 */
import {
  distanceM,
  distanceToArea,
  distanceToPath,
  elementDistance,
  pointInRing,
} from "./geo";

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a: number | undefined, b: number, tol: number) =>
  a !== undefined && Math.abs(a - b) <= tol;

// --- point to point ---------------------------------------------------------
// One degree of latitude is ~110.6km; a hundredth of it ~1106m.
const houston = { latitude: 29.787606, longitude: -95.289548 };
check(
  "a degree of latitude is ~110.6km",
  near(distanceM(houston, { ...houston, latitude: houston.latitude + 1 }), 110_574, 50),
  String(distanceM(houston, { ...houston, latitude: houston.latitude + 1 })),
);
check("zero distance to itself", distanceM(houston, houston) === 0);

// --- the centre-versus-line bug --------------------------------------------
/*
 * A rail line running due north for a full degree, passing 100m east of the
 * parcel. Its centre is ~55km away; the line itself is 100m away. The whole
 * module exists so that this returns the second number.
 */
const mPerDegLon = 111_320 * Math.cos((houston.latitude * Math.PI) / 180);
const eastOffset = 100 / mPerDegLon;
const railway = [
  { lat: houston.latitude, lon: houston.longitude + eastOffset },
  { lat: houston.latitude + 1, lon: houston.longitude + eastOffset },
];
const dRail = distanceToPath(houston, railway);
check("a passing rail line measures to the line, not its extent", near(dRail, 100, 2), String(dRail));

const centre = {
  lat: (railway[0].lat + railway[1].lat) / 2,
  lon: railway[0].lon,
};
check(
  "measuring to the centre would have been wrong by tens of kilometres",
  distanceM(houston, { latitude: centre.lat, longitude: centre.lon }) > 50_000,
);

// A segment that stops short must not be extended to reach the parcel.
const stub = [
  { lat: houston.latitude + 0.5, lon: houston.longitude },
  { lat: houston.latitude + 0.6, lon: houston.longitude },
];
check(
  "a segment is not extrapolated past its endpoints",
  near(distanceToPath(houston, stub), 0.5 * 110_574, 100),
  String(distanceToPath(houston, stub)),
);

check("an empty path has no distance, not a zero one", distanceToPath(houston, []) === undefined);

// --- areas ------------------------------------------------------------------
const d = 0.01;
const square = [
  { lat: houston.latitude - d, lon: houston.longitude - d },
  { lat: houston.latitude - d, lon: houston.longitude + d },
  { lat: houston.latitude + d, lon: houston.longitude + d },
  { lat: houston.latitude + d, lon: houston.longitude - d },
];
check("a parcel inside an area is inside it", pointInRing(houston, square));
check("distance to a containing area is zero", distanceToArea(houston, square) === 0);

const outside = { latitude: houston.latitude, longitude: houston.longitude + 3 * d };
check("a parcel outside the area is outside it", !pointInRing(outside, square));
check(
  "distance to a nearby area is to its edge",
  near(distanceToArea(outside, square), 2 * d * mPerDegLon, 5),
  String(distanceToArea(outside, square)),
);
check("a degenerate ring has no distance", distanceToArea(houston, square.slice(0, 2)) === undefined);

// --- element dispatch -------------------------------------------------------
check(
  "a node uses its own coordinates",
  near(elementDistance(houston, { type: "node", lat: houston.latitude + 0.001, lon: houston.longitude }), 110.6, 1),
);
check(
  "a way uses its geometry",
  near(elementDistance(houston, { type: "way", geometry: railway }), 100, 2),
);
check(
  "a closed way is treated as an area",
  elementDistance(houston, { type: "way", geometry: [...square, square[0]] }) === 0,
);
check(
  "centre is the last resort, not the first",
  near(
    elementDistance(houston, { type: "relation", center: { lat: houston.latitude + 0.001, lon: houston.longitude } }),
    110.6,
    1,
  ),
);
check(
  "geometry wins over centre when both are present",
  near(
    elementDistance(houston, {
      type: "way",
      geometry: railway,
      center: { lat: centre.lat, lon: centre.lon },
    }),
    100,
    2,
  ),
);
check(
  "an element with no usable geometry has no distance",
  elementDistance(houston, { type: "relation" }) === undefined,
);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("geo: all assertions passed");
