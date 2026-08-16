# The site-intel loop

Continuous background enrichment of what surrounds every parcel — the half of a
property that decides its value and appears on no listing.

## What it answers

For each parcel, from free keyless public sources:

| Signal | Source | Why it moves value |
|---|---|---|
| Rail lines, yards | OpenStreetMap | Noise, vibration, horns at crossings |
| Substations, transmission lines | OpenStreetMap | Hum; recorded easements restricting what can be built |
| Industrial land, works | OpenStreetMap | Truck traffic, operating hours |
| Landfills, quarries, wastewater | OpenStreetMap | Odour and blasting carry kilometres |
| Motorways, arterials | OpenStreetMap | Constant road noise |
| Runways, prisons | OpenStreetMap | Buyer-pool effects |
| **Road access / landlocked** | OpenStreetMap | A parcel no road reaches cannot be built on or resold |
| Flood zone, SFHA flag, BFE | FEMA NFHL | Mandatory insurance on a federally backed loan |
| Elevation and slope | USGS 3DEP | Slope drives site work cost and septic approval |
| Tract vacancy, ownership, income, median value | Census ACS | Exit risk, and what a local buyer can finance |
| Parks, schools, grocery | OpenStreetMap | The positives, so the picture is not only adverse |

Measured on a parcel already in the database — 7610 Wallisville Rd, Houston,
assessed **$973,680**, opening bid **$760,267**:

```
! Industrial land (10 nearby)          180 ft
! CenterPoint Energy (2 nearby)        210 ft   transmission line
! UP Houston East Belt Subdivision     344 ft   mainline
! Railway line (31 nearby)             374 ft
! Wallisville Substation               397 ft
! Union Pacific Englewood Yard        2123 ft
```

None of that is in the assessment, the tax notice, or any listing feed.

## Running it

```bash
npm run intel:status                       # coverage per source
npm run intel:locate -- --plan             # parcels a cadastre layer can locate
npm run intel:locate -- --state AR         # backfill coordinates, free
npm run intel:worker                       # the loop — runs until stopped
npm run intel:worker -- --once --batch 20  # a single pass
npm run intel:worker -- --state TX --source fema
```

### Coordinates come first

Nothing geospatial can run without a point, and only 4,002 of 25,702 lots had
one. `npm run intel:locate` recovers them from the cadastre layers already in
the registry — the same services that supplied the assessed values, which were
being asked for geometry and having it discarded (`returnGeometry: "false"`).
**16,856 parcels are reachable this way, for free.** Run it before expecting
the worker to have much to do.

### Continuously, on this machine

The worker is a plain process that needs only `DATABASE_URL`. Install it under
launchd so it survives logout and restarts on crash:

```bash
cp docs/com.deedpilot.intel.plist ~/Library/LaunchAgents/
# edit the paths inside first — they are absolute by necessity
launchctl load ~/Library/LaunchAgents/com.deedpilot.intel.plist
launchctl list | grep deedpilot

tail -f /tmp/deedpilot-intel.log     # what it is doing
launchctl unload ~/Library/LaunchAgents/com.deedpilot.intel.plist   # stop
```

It shuts down on the parcel boundary, so `unload` never leaves a parcel
half-enriched.

### Continuously, in the cloud

`/api/cron/dispatch` also drains intel work, at priority `-5` — below every
crawl and below research, so it consumes only budget nothing else wanted. That
is enough to keep a deployed instance moving unattended and is **not** enough
to drain the backlog: a Hobby cron runs once a day and reserves most of its
budget for crawls. Either run the worker somewhere always-on, or raise the
dispatcher cadence (Vercel Pro, or an external scheduler hitting the endpoint
with the admin token).

## How it decides what to do next

`lib/property/signals/scheduler.ts`, in priority order:

1. **Perishability.** Intel on a parcel selling in five days is worth
   something; the same intel the day after the sale is worth nothing. This
   dominates, because it is the only factor with a deadline.
2. **Real inventory only.** `sale_list` + confirmed sale date — the same line
   the coverage scoreboard draws. Enriching a delinquent roll would spend the
   loop on parcels whose owners will pay before any levy.
3. **Stake.** Opening bid descending, contributed as a bounded log term so a
   $760k Houston bid cannot outrank a parcel selling on Tuesday.
4. **Ignorance.** A parcel never looked at outranks one being refreshed.

Work is scheduled per `(lot, source)` rather than per lot, because the sources
have wildly different costs and freshness — FEMA answers in 80ms and is
re-asked twice a year; Overpass takes tens of seconds and is re-asked yearly.

## Freshness

| Source | TTL | Why |
|---|---|---|
| `fema` | 180d | Panels are revised on a multi-year cycle; a remap changes what a parcel is worth |
| `usgs` | 3650d | Bedrock does not move — re-fetched only to repair gaps |
| `osm` | 365d | The alignment is permanent; what changes is *mapping coverage* in rural counties |
| `census` | 365d | ACS 5-year estimates are published annually |

A `failed` run is retried after 6 hours rather than on the source's TTL — an
Overpass 504 is a fact about an afternoon, not about the parcel. A `skipped`
run (no coordinates) is retried after a day, because the backfill supplies them
later without anything about the source changing.

## What it will not do

**No signal ever produces a dollar figure.** `lib/deal/maxbid.ts` computes every
number a user acts on; a proximity penalty invented here would flow into a bid
having never been measured. Signals report what is there, how far away, and
which way it cuts. The reader prices it.

Severity is banded by distance — a rail line at 60m and one at 900m are the
same feature and not the same fact — and the bands are judgements someone made
once and can argue with, rather than a formula that looks like measurement.

## Optional key

`CENSUS_API_KEY` unlocks the neighborhood signals. Free and instant from
<https://api.census.gov/data/key_signup.html>. Without it the source reports
itself unconfigured and the scheduler records `skipped` rather than burning
retries. An unkeyed ACS request returns an HTML "Missing Key" page under
**HTTP 200**, which is why `neighborhood.ts` parses defensively instead of
trusting the status code.

## Transport quirks, all measured

Overpass sits behind Apache and both layers have opinions:

- A `application/x-www-form-urlencoded` POST → **406**. A raw body with
  `content-type: text/plain` → **200**. No content-type at all → **504** after
  a minute. Same query, same server, three outcomes.
- A User-Agent containing a semicolon inside parentheses → **406 on every
  request**, from Apache rather than Overpass. The agent string is kept plain
  for this reason.
- Two of three community mirrors were unreachable for an afternoon, so the
  working endpoint is remembered for the life of the process instead of being
  rediscovered at a 75-second timeout per parcel.
- `out geom`, never `out center`. The centre of a way is not where the way is:
  a probe once reported a rail line 745m away inside a 600m query radius,
  because it measured to the midpoint of a subdivision running across a county.
  See `lib/property/signals/geo.ts`.
