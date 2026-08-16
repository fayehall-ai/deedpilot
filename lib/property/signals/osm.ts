/**
 * What is physically around a parcel, from OpenStreetMap.
 *
 * ## Why this is the source
 *
 * The question a tax-deed bidder cannot get answered anywhere is "what is it
 * actually next to". A listing site will show comparable sales and school
 * ratings; none of them will tell you that the parcel backs onto a rail
 * mainline, that the substation is a hundred metres up the road, or that the
 * eight polygons around it are all zoned industrial. That information exists,
 * is public, and is mapped — it is simply not in any real-estate feed, because
 * a feed is built from listings and a listing is written by the seller.
 *
 * Two parcels already in the database, measured against this source:
 *
 *   7610 Wallisville Rd, Houston — assessed $973,680, opening bid $760,267.
 *   A Union Pacific mainline at 111m, the Wallisville substation at 158m,
 *   industrial land use at 221m.
 *
 *   420 Ohlendorf Rd, Osceola AR — assessed $11,000. Eight industrial
 *   polygons inside a kilometre, the nearest at 138m, and the BNSF River
 *   Subdivision beyond them.
 *
 * Neither fact appears on any listing surface for either parcel.
 *
 * ## Licence
 *
 * OpenStreetMap data is ODbL. Attribution is required wherever it is shown,
 * which is why `OSM_ATTRIBUTION` is exported rather than left to whoever
 * writes the component — an attribution that lives only in a design decision
 * is one deploy away from being dropped.
 *
 * ## Why it is built to be patient
 *
 * The public Overpass endpoints are a shared free service and they behave like
 * one. Measured while building this: a form-encoded POST is rejected with 406
 * and a raw body is accepted; a busy endpoint returns 504 after nine seconds;
 * two of the three community mirrors were unreachable for an afternoon.
 *
 * The first working version issued five queries per parcel and took 207
 * seconds before failing. What cost the time was round trips and dead mirrors,
 * not clauses — so this now sends two requests per parcel with every clause
 * carrying its own radius, and remembers which endpoint last answered rather
 * than paying a fresh timeout to rediscover a dead one on every parcel.
 *
 * It is still the wrong shape for a request path and the right shape for a
 * queue, which is where it runs.
 */

import { elementDistance, type LatLon } from "./geo";
import {
  SignalSourceUnavailableError,
  type Severity,
  type Signal,
  type SignalInput,
  type SignalSource,
} from "./types";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/**
 * Endpoints, tried in order.
 *
 * `overpass-api.de` is the reference instance and the only one that answered
 * during development; the mirrors are kept because the reference instance
 * rate-limits, and a background loop that stops entirely when one host is busy
 * is not a background loop.
 */
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/**
 * Kept deliberately plain.
 *
 * A longer, more descriptive agent string — "DeedPilot/0.1 (tax-deed property
 * research; +https://deedpilot.app)" — was rejected with 406 on *every*
 * request, including a query that succeeded moments earlier under this one.
 * The refusal comes from Apache in front of Overpass rather than from Overpass
 * itself, so it is a filter reacting to the string, most likely the semicolon
 * inside the parentheses. Identifying the client and giving a contact URL is
 * the part that matters for politeness; the prose was costing us the service.
 */
const UA = "DeedPilot/0.1 (+https://deedpilot.app)";

/**
 * A class of thing worth knowing about, and what its distance means.
 *
 * ## Why severity is banded by distance rather than computed
 *
 * A rail line at 60 metres and one at 900 metres are the same feature and not
 * the same fact. What changes is not a coefficient — it is whether a person
 * standing in the yard hears it. Bands encode that as a judgement someone made
 * once and can be argued with, rather than as a formula that looks like
 * measurement and is really a guess with decimal places.
 *
 * The bands deliberately stop at `high`. Nothing here produces a dollar
 * adjustment, because a dollar adjustment is a bid input, and bid inputs come
 * from `lib/deal/maxbid.ts` or from nowhere.
 */
interface FeatureClass {
  kind: string;
  /** Overpass filter fragments; `A` is substituted with `around:<r>,<lat>,<lon>`. */
  clauses: string[];
  direction: "negative" | "positive" | "neutral";
  /** Metres. Nothing beyond the last band is recorded at all. */
  bands: { withinM: number; severity: Severity }[];
  label: (tags: Record<string, string>) => string;
  note?: (distanceM: number, tags: Record<string, string>) => string;
  /** Skip features whose tags say they are not the thing we are looking for. */
  exclude?: (tags: Record<string, string>) => boolean;
}

/**
 * The catalogue.
 *
 * Each entry is a claim about what affects a property's value and how far that
 * influence reaches. The radii come from what a person standing on the parcel
 * would notice, not from a model.
 */
const CLASSES: FeatureClass[] = [
  {
    kind: "rail.line",
    // `usage=main|branch` is freight and passenger track. Spurs, sidings and
    // yard leads are separately tagged and matched too — a yard lead at the
    // fence line is noisier than a mainline half a mile off.
    clauses: [`way(A)["railway"~"^(rail|light_rail|narrow_gauge)$"]`],
    direction: "negative",
    bands: [
      { withinM: 150, severity: "high" },
      { withinM: 400, severity: "medium" },
      { withinM: 800, severity: "low" },
    ],
    // `disused` and `abandoned` carry their own top-level keys in OSM, so a
    // lifted right-of-way does not reach this filter at all. What does reach it
    // and should not count is a heritage line or a model railway in a park.
    exclude: (t) => t.railway === "miniature" || t.service === "crossover",
    label: (t) => t.name || t.operator || "Railway line",
    note: (_d, t) =>
      `Active freight track${t.usage === "main" ? " on a mainline" : ""}. Noise, vibration and horn ` +
      `use at crossings — check where the nearest crossing is before assuming quiet.`,
  },
  {
    kind: "rail.yard",
    clauses: [`nwr(A)["landuse"="railway"]`, `way(A)["service"="yard"]`],
    direction: "negative",
    bands: [
      { withinM: 400, severity: "high" },
      { withinM: 1000, severity: "medium" },
    ],
    label: (t) => t.name || "Rail yard",
    note: () => `Shunting and idling locomotives, which run outside daylight hours.`,
  },
  {
    kind: "power.substation",
    clauses: [`nwr(A)["power"="substation"]`],
    direction: "negative",
    bands: [
      { withinM: 200, severity: "high" },
      { withinM: 500, severity: "medium" },
      { withinM: 900, severity: "low" },
    ],
    label: (t) => t.name || t.operator || "Electrical substation",
    note: () => `Transformer hum, and a persistent resale objection whatever the engineering says.`,
  },
  {
    kind: "power.transmission",
    clauses: [`way(A)["power"="line"]`],
    direction: "negative",
    bands: [
      { withinM: 100, severity: "high" },
      { withinM: 250, severity: "medium" },
      { withinM: 500, severity: "low" },
    ],
    label: (t) => t.operator || t.name || "High-voltage transmission line",
    note: () =>
      `Where a line crosses a parcel there is usually a recorded easement restricting what can be ` +
      `built under it — check the deed, not the map.`,
  },
  {
    kind: "landuse.industrial",
    clauses: [`nwr(A)["landuse"="industrial"]`, `nwr(A)["man_made"="works"]`],
    direction: "negative",
    bands: [
      { withinM: 200, severity: "high" },
      { withinM: 600, severity: "medium" },
      { withinM: 1200, severity: "low" },
    ],
    label: (t) => t.name || t.operator || "Industrial land",
    note: () => `Truck traffic and operating hours are the usual complaint.`,
  },
  {
    kind: "landuse.landfill",
    clauses: [`nwr(A)["landuse"~"^(landfill|quarry)$"]`, `nwr(A)["amenity"="waste_transfer_station"]`],
    direction: "negative",
    // Odour and blasting carry much further than noise, so the bands are wide.
    bands: [
      { withinM: 800, severity: "high" },
      { withinM: 2000, severity: "medium" },
      { withinM: 4000, severity: "low" },
    ],
    label: (t) => t.name || (t.landuse === "quarry" ? "Quarry" : "Landfill / waste site"),
    note: (_d, t) =>
      t.landuse === "quarry"
        ? `Blasting schedules and heavy haulage on local roads.`
        : `Odour travels much further than noise and is seasonal.`,
  },
  {
    kind: "hazard.wastewater",
    clauses: [`nwr(A)["man_made"="wastewater_plant"]`],
    direction: "negative",
    bands: [
      { withinM: 800, severity: "high" },
      { withinM: 2000, severity: "medium" },
    ],
    label: (t) => t.name || "Wastewater treatment plant",
    note: () => `Odour is prevailing-wind dependent and worst in summer.`,
  },
  {
    kind: "road.arterial",
    clauses: [`way(A)["highway"~"^(motorway|trunk|primary)$"]`],
    direction: "negative",
    bands: [
      { withinM: 100, severity: "high" },
      { withinM: 300, severity: "medium" },
    ],
    label: (t) => t.name || t.ref || "Major road",
    note: (_d, t) =>
      `Constant road noise from ${t.highway === "motorway" ? "a motorway" : "an arterial route"}. ` +
      `Frontage cuts residential appeal and can raise commercial appeal; which one depends on zoning.`,
  },
  {
    kind: "hazard.airport",
    clauses: [`way(A)["aeroway"="runway"]`],
    direction: "negative",
    bands: [
      { withinM: 1500, severity: "high" },
      { withinM: 4000, severity: "medium" },
    ],
    /*
     * Runways are named by their compass heading — "18/36", "04L/22R" — which
     * is meaningless on a page unless it is introduced as a runway. A parcel on
     * S Air Base Hwy in Mississippi County AR surfaced a signal reading simply
     * "18/36", which tells a reader nothing about why it is on the list.
     */
    label: (t) => (t.ref || t.name ? `Runway ${t.ref || t.name}` : "Runway"),
    note: () => `Approach paths extend far beyond the runway itself — check which end the parcel is under.`,
  },
  {
    kind: "hazard.institution",
    clauses: [`nwr(A)["amenity"~"^(prison|waste_disposal)$"]`],
    direction: "negative",
    bands: [
      { withinM: 1000, severity: "high" },
      { withinM: 2500, severity: "medium" },
    ],
    label: (t) => t.name || "Correctional or waste facility",
    note: () => `Persistent effect on the buyer pool regardless of any measurable nuisance.`,
  },
  {
    kind: "context.cemetery",
    clauses: [`nwr(A)["landuse"="cemetery"]`, `nwr(A)["amenity"="grave_yard"]`],
    direction: "negative",
    bands: [{ withinM: 200, severity: "medium" }, { withinM: 500, severity: "low" }],
    label: (t) => t.name || "Cemetery",
    note: () => `Quiet neighbour, smaller buyer pool.`,
  },
  {
    kind: "water.feature",
    clauses: [
      `nwr(A)["natural"="water"]`,
      `way(A)["waterway"~"^(river|stream)$"]`,
    ],
    /*
     * Neutral on purpose, and the only entry that is.
     *
     * Water frontage is a premium on a buildable lot and a liability on a flood
     * plain, and this fetcher cannot tell which — the parcel's flood zone is a
     * separate signal from a separate source. Calling it `positive` here would
     * put a green mark on a parcel whose defining feature is that it floods.
     */
    direction: "neutral",
    bands: [
      { withinM: 100, severity: "medium" },
      { withinM: 400, severity: "low" },
    ],
    label: (t) => t.name || (t.waterway ? `Watercourse` : "Water body"),
    note: () =>
      `Frontage or flood exposure depending on elevation and zone — read this next to the FEMA ` +
      `signal, not on its own.`,
  },
  {
    kind: "amenity.park",
    clauses: [`nwr(A)["leisure"="park"]`],
    direction: "positive",
    bands: [{ withinM: 400, severity: "medium" }, { withinM: 1000, severity: "low" }],
    label: (t) => t.name || "Park",
    note: () => `Public green space.`,
  },
  {
    kind: "amenity.school",
    clauses: [`nwr(A)["amenity"="school"]`],
    direction: "positive",
    bands: [{ withinM: 1000, severity: "medium" }, { withinM: 2500, severity: "low" }],
    label: (t) => t.name || "School",
    note: () => `Catchment is set by district boundary, not by distance.`,
  },
  {
    kind: "amenity.grocery",
    clauses: [`nwr(A)["shop"~"^(supermarket|convenience)$"]`],
    direction: "positive",
    bands: [{ withinM: 1500, severity: "low" }],
    label: (t) => t.name || "Grocery",
    note: () => `Everyday shopping — worth checking on rural parcels, where it can be twenty miles.`,
  },
];

/** Widest band across the catalogue — nothing beyond this is ever asked for. */
const MAX_RADIUS = Math.max(...CLASSES.flatMap((c) => c.bands.map((b) => b.withinM)));

/** The reach of a class: its widest band. */
const reachOf = (c: FeatureClass) => Math.max(...c.bands.map((b) => b.withinM));

/**
 * Two queries per parcel, split by reach.
 *
 * ## Why not one, and why not one per class
 *
 * The first working version issued five queries per parcel — four class
 * batches plus a road-access check — and took 207 seconds per parcel before
 * failing. Overpass charges by area times filters, so the fix is not fewer
 * clauses but fewer *round trips*, and each clause can carry its own radius
 * inside a single union. Sixteen clauses in one request cost the server far
 * less than five requests do.
 *
 * The split into near and far is the one distinction worth keeping: a landfill
 * is worth knowing about at 4km and a park is not, and letting the 4km classes
 * set the extent for everything would multiply the searched area by more than
 * ten. Two tiers also means a failure loses half a parcel's intel rather than
 * all of it.
 */
const NEAR_TIER_M = 1200;

function tiers(): { label: string; classes: FeatureClass[] }[] {
  return [
    { label: "near", classes: CLASSES.filter((c) => reachOf(c) <= NEAR_TIER_M) },
    { label: "far", classes: CLASSES.filter((c) => reachOf(c) > NEAR_TIER_M) },
  ].filter((t) => t.classes.length > 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The endpoint that answered last, remembered for the life of the process.
 *
 * Rotating strictly per attempt meant a mirror that was down got a fresh 60
 * second timeout on every parcel, forever — two of the three mirrors were
 * unreachable during development and the loop spent most of its wall clock
 * waiting for them. Sticking to whatever last worked, and only moving on
 * failure, turns that from a per-parcel cost into a one-off.
 */
let preferredMirror = 0;

/**
 * How long until this endpoint will actually serve us, per the endpoint itself.
 *
 * ## Why ask rather than guess
 *
 * Overpass allocates a small number of concurrent slots per IP and publishes
 * the state of them at `/api/status`:
 *
 *     Rate limit: 2
 *     Slot available after: 2026-08-16T20:41:34Z, in 15 seconds.
 *     Slot available after: 2026-08-16T20:42:15Z, in 56 seconds.
 *
 * A run that opened two workers against it consumed both slots and then failed
 * a third of its parcels — while backing off two, four and six seconds against
 * a server that was saying, in plain text, "fifty-six". The retry was not too
 * few attempts; it was the wrong duration, guessed when the right one was being
 * published for free.
 *
 * So a rejection asks. Failing that ask is not fatal — a mirror that does not
 * publish status simply falls through to the fixed backoff.
 */
async function slotWaitMs(endpoint: string): Promise<number | null> {
  try {
    const statusUrl = endpoint.replace(/\/interpreter$/, "/status");
    const res = await fetch(statusUrl, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const text = await res.text();

    // Slots already free — the rejection was about something else.
    if (/\d+ slots available now/i.test(text)) return 0;

    const waits = [...text.matchAll(/in (\d+) seconds?\./g)].map((m) => Number(m[1]));
    if (waits.length === 0) return null;
    /*
     * The soonest slot, plus a second of slack. Waiting for the *latest* one
     * would idle through a slot that had already freed.
     */
    return (Math.min(...waits) + 1) * 1000;
  } catch {
    return null;
  }
}

/**
 * One Overpass call, with the transport quirks this service actually has.
 *
 * The body is sent raw. A `application/x-www-form-urlencoded` POST — the form
 * every example uses — was answered with 406 by the reference instance during
 * development, and a raw body with an explicit `Accept` was answered with 200.
 */
async function overpass(query: string, attempts = 4): Promise<unknown[]> {
  let lastError = "";
  /*
   * The mirror only moves on a *hard* failure.
   *
   * Rotating on every attempt sent us to the slow mirrors for the one reason
   * that is not their business to fix: overpass-api.de saying "your two slots
   * are busy, come back in thirty seconds". That is not a broken server, it is
   * a queue, and the correct response is to wait in it. Rotating instead
   * abandoned the fastest endpoint — measured at 3.4s for the near tier — for
   * two that time out, and it did so precisely when the good one was about to
   * be free.
   *
   * So: a rate-limit answer waits and retries the same host; a network error or
   * an unexpected status moves on.
   */
  let index = preferredMirror;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = MIRRORS[index];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: query,
        /*
         * `text/plain`, and the header is not optional.
         *
         * Three content types were measured against the same multi-clause
         * query: `application/x-www-form-urlencoded` is refused with 406, no
         * content-type at all returned 504 after a minute, and `text/plain`
         * returned 200 in seconds. The header is doing something upstream of
         * Overpass — the same query, the same server, three outcomes.
         */
        headers: {
          accept: "application/json",
          "content-type": "text/plain",
          "user-agent": UA,
        },
        /*
         * Patient from the first attempt.
         *
         * An earlier version gave attempt zero a 30-second fuse to abandon
         * dead mirrors quickly, and it was cutting off live ones: the near
         * tier answers in 3.4 seconds on an idle server and takes far longer
         * on a busy one, so the short fuse converted "slow" into "failed" and
         * then spent two more attempts on mirrors that were genuinely down.
         * Sticking to the endpoint that last answered is what handles a dead
         * mirror; the timeout only needs to bound a hung connection.
         */
        signal: AbortSignal.timeout(75_000),
      });

      if (res.status === 200) {
        const data = (await res.json()) as { elements?: unknown[] };
        preferredMirror = index;
        return data.elements ?? [];
      }

      /*
       * 429 and 504 are this service saying "not now" — the documented
       * behaviour of a free shared endpoint whose per-IP slots are occupied.
       * Backed off and retried, never recorded as "nothing near this parcel".
       *
       * How long to wait comes from the endpoint rather than from a guess; see
       * `slotWaitMs`. Capped so a badly congested mirror cannot stall a parcel
       * indefinitely — past that it is cheaper to try the next mirror and let
       * the ledger retry this parcel on its six-hour clock.
       */
      lastError = `HTTP ${res.status} from ${endpoint}`;
      const announced = res.status === 429 || res.status === 504 ? await slotWaitMs(endpoint) : null;
      if (announced === null) {
        // Not a queue we can wait in — try somebody else.
        index = (index + 1) % MIRRORS.length;
        await sleep(2_000 * (attempt + 1));
      } else {
        // A published wait. Stay on this host; it is the fastest one we have.
        await sleep(Math.min(announced, 90_000));
      }
    } catch (e) {
      // Timeout or connection failure: this host is not answering at all.
      lastError = `${endpoint}: ${e instanceof Error ? e.message : String(e)}`;
      index = (index + 1) % MIRRORS.length;
      await sleep(2_000 * (attempt + 1));
    }
  }

  throw new SignalSourceUnavailableError("osm", lastError);
}

/** Band a distance falls in, or undefined when it is beyond every band. */
function severityFor(cls: FeatureClass, distanceM: number): Severity | undefined {
  for (const band of cls.bands) if (distanceM <= band.withinM) return band.severity;
  return undefined;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { geometry?: { lat: number; lon: number }[] }[];
}

/** Which catalogue entry an element belongs to, by re-testing its tags. */
function classify(el: OverpassElement): FeatureClass | undefined {
  const t = el.tags ?? {};
  for (const cls of CLASSES) {
    if (cls.exclude?.(t)) continue;
    for (const clause of cls.clauses) {
      /*
       * The clause is re-read rather than tracked per query, because Overpass
       * returns one flat element list for a union and does not say which arm
       * matched. Parsing the filter we wrote is more honest than guessing from
       * the tags alone: it keeps the match rule in exactly one place.
       */
      const pairs = [...clause.matchAll(/\["([^"]+)"(?:(=|~)"([^"]+)")?\]/g)];
      const ok = pairs.every(([, key, op, val]) => {
        const actual = t[key];
        if (actual === undefined) return false;
        if (!op) return true;
        return op === "=" ? actual === val : new RegExp(val).test(actual);
      });
      if (ok && pairs.length > 0) return cls;
    }
  }
  return undefined;
}

/**
 * Distance from the parcel, preferring its boundary when we have one.
 *
 * A polygon parcel measures from whichever of its vertices is closest, which is
 * what a person on the land experiences. A centroid-only parcel measures from
 * the centroid and says so, so the two are never silently compared.
 */
function parcelDistance(input: SignalInput, el: OverpassElement): number | undefined {
  const fromCentroid = elementDistance(input.location, el);
  const ring = input.location.ring;
  if (!ring?.length) return fromCentroid;

  let best = fromCentroid;
  for (const v of ring) {
    const d = elementDistance({ latitude: v.lat, longitude: v.lon } as LatLon, el);
    if (d !== undefined && (best === undefined || d < best)) best = d;
  }
  return best;
}

/**
 * Whether any road reaches the parcel — the absence signal.
 *
 * ## Why this is worth its own query
 *
 * Landlocked parcels are disproportionately common in tax deed inventory and
 * they are the classic way to lose money at one of these sales. A remnant strip
 * left over from a subdivision, a lot behind a lot, a piece cut off by a later
 * road realignment: it has a parcel number, an assessed value and a tax bill,
 * so it appears in the sale list looking exactly like a buildable lot. It
 * cannot be reached, cannot be built on, and cannot be resold to anyone but the
 * neighbour who already surrounds it.
 *
 * The assessed value does not disclose this. The photograph does not disclose
 * it. It is a fact about the road network, which is why it is answered here.
 *
 * ## What this can and cannot establish
 *
 * A road nearby is *evidence of* access, not proof of it: legal access is an
 * easement question settled by the deed and the plat, and a road running past
 * the boundary may be private, or may have no curb cut. The absence of any
 * mapped road is much stronger evidence in the other direction, and is
 * reported as a prompt to check the plat rather than as a verdict — hence
 * `medium`, and a note that says so.
 */
const ACCESS_RADIUS_M = 150;

function roadAccess(input: SignalInput, elements: OverpassElement[]): Signal | null {
  let nearest: { d: number; el: OverpassElement } | null = null;
  for (const el of elements) {
    // Any highway tag counts, tracks and service roads included. A gravel lane
    // is access; excluding it would report a farm parcel as landlocked because
    // nobody paved its driveway.
    if (!el.tags?.highway) continue;
    // A driveway leads to a building, so it proves the neighbour has access,
    // not this parcel. Excluded from the nearest-road test on purpose.
    if (el.tags?.service === "driveway") continue;
    const d = parcelDistance(input, el);
    if (d === undefined) continue;
    if (!nearest || d < nearest.d) nearest = { d, el };
  }

  if (!nearest) {
    return {
      kind: "access.landlocked",
      source: "osm",
      featureKey: "road-access",
      direction: "negative",
      severity: "high",
      label: `No mapped road within ${ACCESS_RADIUS_M}m`,
      note:
        `Nothing in the road network reaches this parcel. Landlocked parcels are common in tax sales ` +
        `and are the standard way to buy something that cannot be resold — verify legal access on the ` +
        `plat and the deed before bidding. OSM coverage is thinner in rural counties, so treat this as ` +
        `a reason to check rather than as a finding.`,
      distanceBasis: input.location.ring?.length ? "boundary" : input.location.basis,
      raw: { checkedRadiusM: ACCESS_RADIUS_M, roadsFound: 0 },
    };
  }

  const t = nearest.el.tags ?? {};
  const road = t.name || t.ref || (t.highway === "track" ? "Unpaved track" : "Unnamed road");

  /*
   * A road more than 60m off the boundary is not frontage. It is recorded
   * because "the nearest road is 140 metres away and unnamed" is exactly the
   * kind of thing a bidder should see before driving out.
   */
  if (nearest.d > 60) {
    return {
      kind: "access.remote",
      source: "osm",
      featureKey: "road-access",
      direction: "negative",
      severity: "medium",
      label: `No road frontage — nearest is ${road}`,
      note:
        `No road frontage. Reaching the parcel may need an easement across someone else's land; ` +
        `check the plat for a recorded right of way.`,
      distanceM: Math.round(nearest.d),
      distanceBasis: input.location.ring?.length ? "boundary" : input.location.basis,
      raw: { tags: t },
    };
  }

  return {
    kind: "access.road",
    source: "osm",
    featureKey: "road-access",
    direction: "positive",
    severity: "low",
    label: `Road access — ${road}`,
    note:
      t.highway === "track"
        ? `Unpaved track at the boundary. Passable access, but confirm it is public and maintained.`
        : `A mapped public road runs along or beside the parcel.`,
    distanceM: Math.round(nearest.d),
    distanceBasis: input.location.ring?.length ? "boundary" : input.location.basis,
    raw: { tags: t },
  };
}

export const osmSource: SignalSource = {
  name: "osm",
  configured: () => true,
  /*
   * A rail alignment does not move and an industrial park is rezoned over
   * years, so a yearly refresh is generous. What actually changes underneath
   * is OSM's *coverage* — a rural county gets mapped by a volunteer one
   * weekend and a parcel that returned nothing last year returns eight
   * features this year. That is the case this TTL is really for.
   */
  ttlDays: 365,

  async fetch(input: SignalInput): Promise<Signal[]> {
    const { latitude, longitude } = input.location;
    const signals: Signal[] = [];
    const seen = new Set<string>();
    /** Road elements from the near query, reused for the access check. */
    const roads: OverpassElement[] = [];

    const tierList = tiers();
    for (const [i, tier] of tierList.entries()) {
      /*
       * Each clause carries its own radius, so a 4km landfill sweep never sets
       * the extent for a 400m park lookup even inside the same request.
       */
      const clauses = tier.classes
        .flatMap((c) =>
          c.clauses.map(
            (clause) =>
              clause.replace("(A)", `(around:${reachOf(c)},${latitude},${longitude})`) + ";",
          ),
        )
        .concat(
          /*
           * The road-access check rides along on the near query instead of
           * costing its own round trip. It is the cheapest clause in the set
           * and it answers the most consequential question here — see
           * `roadAccess` on landlocked parcels.
           */
          tier.label === "near"
            ? [`way(around:${ACCESS_RADIUS_M},${latitude},${longitude})["highway"];`]
            : [],
        )
        .join("\n  ");

      /*
       * `out tags geom` — geometry, not centre. The whole of `geo.ts` exists
       * because the centre of a way is not where the way is; asking for `geom`
       * is what makes an honest distance possible.
       */
      /*
       * The element cap is 400, not the 120 it started at.
       *
       * A dense industrial parcel in Houston returned exactly 120 elements —
       * the cap, meaning the result was truncated. Overpass truncates in its
       * own order, not by distance, so the dropped features are arbitrary: the
       * rail line at the fence can be cut while a park at the edge of the
       * radius survives. A cap that silently removes the most important signal
       * is worse than a larger response, and this runs in a background queue
       * where a megabyte costs nothing.
       */
      const query = `[out:json][timeout:90];\n(\n  ${clauses}\n);\nout tags geom 400;`;

      const elements = (await overpass(query)) as OverpassElement[];

      for (const el of elements) {
        if (el.tags?.highway) roads.push(el);

        const cls = classify(el);
        if (!cls) continue;

        const distance = parcelDistance(input, el);
        if (distance === undefined) continue;

        const severity = severityFor(cls, distance);
        if (!severity) continue; // Real, but too far to be worth a line on the page.

        const featureKey = `${el.type ?? "el"}/${el.id ?? `${cls.kind}:${Math.round(distance)}`}`;
        if (seen.has(featureKey)) continue;
        seen.add(featureKey);

        const tags = el.tags ?? {};
        signals.push({
          kind: cls.kind,
          source: "osm",
          featureKey,
          direction: cls.direction,
          severity,
          label: cls.label(tags),
          note: cls.note?.(distance, tags),
          distanceM: Math.round(distance),
          distanceBasis: input.location.ring?.length ? "boundary" : input.location.basis,
          raw: { tags, type: el.type, id: el.id },
        });
      }

      // Deliberate pacing between tiers. The endpoint is free and shared, and
      // `lib/ingest/policy.ts` treats politeness as architecture rather than manners.
      if (i < tierList.length - 1) await sleep(1_200);
    }

    const access = roadAccess(input, roads);
    if (access) signals.push(access);

    /*
     * Nearest first, and severity is not the sort key — a bidder scanning this
     * list is asking "what is closest to my fence", and a high-severity
     * landfill 3km off should not sit above the substation across the street.
     */
    signals.sort((a, b) => (a.distanceM ?? MAX_RADIUS) - (b.distanceM ?? MAX_RADIUS));

    return collapse(signals);
  },
};

/**
 * One line per real-world thing, not one per OSM way.
 *
 * ## The problem this solves
 *
 * OSM splits a linear feature wherever any tag changes — at a bridge, a
 * crossing, a maintenance boundary — so a single rail corridor arrives as a
 * dozen `way` elements. The Houston test parcel produced eight consecutive
 * "Railway line" rows at 775m, 779m, 784m, 788m, 792m and 796m: six ways, one
 * railway, six lines of a page that a reader has to scan past to find the next
 * real fact.
 *
 * The same happens to an industrial estate mapped as four adjoining polygons
 * and to a chain of convenience stores along one road.
 *
 * ## What is kept
 *
 * The nearest instance of each distinct thing, with a count when there were
 * more. Nearest is the right survivor because every band in this file is a
 * distance band: if the corridor is 105m away at its closest point, that is
 * the fact, and the segment 796m along the same corridor adds nothing.
 *
 * The count is kept rather than dropped because "four industrial parcels
 * nearby" and "one industrial parcel nearby" are genuinely different pictures
 * of a neighbourhood — that is the Osceola parcel, where eight industrial
 * polygons inside a kilometre are the story.
 */
function collapse(signals: Signal[]): Signal[] {
  /** At most this many distinct entries per kind, nearest kept. */
  const PER_KIND_CAP = 3;

  const byIdentity = new Map<string, { signal: Signal; count: number }>();
  for (const s of signals) {
    // Identity is the kind plus what it is called. Two unnamed industrial
    // polygons collapse together; "Nieto Park" and "Eliot Park" do not.
    const key = `${s.kind}|${s.label}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, { signal: s, count: 1 });
      continue;
    }
    existing.count++;
    // Signals arrive nearest-first, so the incumbent is already the closest.
  }

  const perKind = new Map<string, number>();
  const out: Signal[] = [];

  for (const { signal, count } of byIdentity.values()) {
    const seen = perKind.get(signal.kind) ?? 0;
    if (seen >= PER_KIND_CAP) continue;
    perKind.set(signal.kind, seen + 1);

    out.push(
      count > 1
        ? {
            ...signal,
            label: `${signal.label} (${count} nearby)`,
            raw: { ...signal.raw, collapsedFrom: count },
          }
        : signal,
    );
  }

  return out.sort((a, b) => (a.distanceM ?? MAX_RADIUS) - (b.distanceM ?? MAX_RADIUS));
}

/** Exported for tests, which assert the bands rather than restating them. */
export const OSM_CLASSES = CLASSES;
export { severityFor as osmSeverityFor, classify as osmClassify };
