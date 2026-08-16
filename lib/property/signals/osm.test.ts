/**
 * Classification and banding assertions.
 * Run: npx tsx lib/property/signals/osm.test.ts
 *
 * No network. These pin the two rules that decide what a reader sees: which
 * catalogue entry a raw OSM element lands in, and how far away it stops being
 * worth a line on the page.
 */
import { OSM_CLASSES, osmClassify, osmSeverityFor } from "./osm";

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- classification ---------------------------------------------------------
const railway = osmClassify({ type: "way", tags: { railway: "rail", usage: "main" } });
check("an active rail line is rail.line", railway?.kind === "rail.line", railway?.kind);

const substation = osmClassify({ type: "way", tags: { power: "substation" } });
check("a substation is power.substation", substation?.kind === "power.substation", substation?.kind);

const industrial = osmClassify({ type: "way", tags: { landuse: "industrial" } });
check("industrial land use is landuse.industrial", industrial?.kind === "landuse.industrial");

const landfill = osmClassify({ type: "way", tags: { landuse: "landfill" } });
check("a landfill is landuse.landfill", landfill?.kind === "landuse.landfill", landfill?.kind);

/*
 * A miniature railway in a park is tagged `railway=miniature` and is not a
 * freight corridor. The exclusion exists so a park ride does not read as a
 * mainline at the fence.
 */
check(
  "a miniature railway is excluded",
  osmClassify({ type: "way", tags: { railway: "miniature" } }) === undefined,
);

check(
  "an untagged element classifies as nothing",
  osmClassify({ type: "way", tags: {} }) === undefined,
);
check(
  "an unrelated tag classifies as nothing",
  osmClassify({ type: "way", tags: { building: "yes" } }) === undefined,
);

// A residential street must not be picked up as an arterial road.
check(
  "a residential street is not road.arterial",
  osmClassify({ type: "way", tags: { highway: "residential" } }) === undefined,
);
check(
  "a motorway is road.arterial",
  osmClassify({ type: "way", tags: { highway: "motorway" } })?.kind === "road.arterial",
);

// --- banding ----------------------------------------------------------------
const rail = OSM_CLASSES.find((c) => c.kind === "rail.line")!;
check("rail at the fence line is high", osmSeverityFor(rail, 50) === "high");
check("rail at 300m is medium", osmSeverityFor(rail, 300) === "medium");
check("rail at 700m is low", osmSeverityFor(rail, 700) === "low");
/*
 * Beyond the last band the feature is real and not worth reporting. Returning
 * `low` instead of nothing would put every rail line in the county on the page.
 */
check("rail beyond every band is dropped", osmSeverityFor(rail, 5000) === undefined);

const dump = OSM_CLASSES.find((c) => c.kind === "landuse.landfill")!;
check(
  "odour carries further than noise — a landfill still counts at 3km",
  osmSeverityFor(dump, 3000) === "low",
  String(osmSeverityFor(dump, 3000)),
);
check("but a rail line at 3km does not", osmSeverityFor(rail, 3000) === undefined);

// --- catalogue invariants ---------------------------------------------------
for (const c of OSM_CLASSES) {
  const widths = c.bands.map((b) => b.withinM);
  check(
    `${c.kind} bands are ordered nearest-first`,
    widths.every((w, i) => i === 0 || w > widths[i - 1]),
    widths.join(","),
  );
  check(`${c.kind} has at least one band`, c.bands.length > 0);
  check(`${c.kind} produces a label`, typeof c.label({}) === "string" && c.label({}).length > 0);
}

/*
 * Water is the one class that must stay neutral: frontage is a premium on a
 * buildable lot and a liability on a flood plain, and this source cannot tell
 * which. Marking it positive would put a green mark on a parcel whose defining
 * feature is that it floods.
 */
check(
  "water is neutral, not positive",
  OSM_CLASSES.find((c) => c.kind === "water.feature")?.direction === "neutral",
);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("osm: all assertions passed");
