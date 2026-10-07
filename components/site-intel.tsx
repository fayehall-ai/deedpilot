import type { LotSignal } from "@/lib/db/schema";
import { OSM_ATTRIBUTION } from "@/lib/property/signals/osm";

/**
 * What is around this parcel.
 *
 * ## What this section is for
 *
 * Everything else on the page describes the parcel: its assessment, its taxes,
 * its statutory redemption window. This describes where it *is* — the rail
 * mainline at the back fence, the substation up the road, the flood zone it
 * sits in, the fact that no mapped road reaches it at all.
 *
 * That is the half of a property that a bidder normally only discovers by
 * driving to it, and for an out-of-county buyer at a tax sale, frequently never
 * discovers at all.
 *
 * ## Why distances and sources are on every line
 *
 * "Near a railroad" is an assertion the reader has to take on trust. "111m —
 * UP Houston East Belt Subdivision, OpenStreetMap" is one they can open a map
 * and check in thirty seconds. On a page whose entire claim is that the numbers
 * are checkable, an unsourced adjective is out of place.
 *
 * ## Why nothing here carries a dollar figure
 *
 * `lib/deal/maxbid.ts` computes every number a user acts on, and a proximity
 * penalty invented here would flow into a bid without ever having been
 * measured. So this section reports what is there and how far away, and stops.
 * The reader prices it, or their contractor does.
 */

const TONE = {
  negative: {
    dot: "var(--danger)",
    label: "text-[color:var(--danger)]",
  },
  neutral: { dot: "var(--muted)", label: "text-muted" },
  positive: { dot: "var(--ok, var(--muted))", label: "text-muted" },
} as const;

/** Metric in the data, imperial on the page — the audience is US-domestic. */
function distance(metres: number | null): string | null {
  if (metres === null) return null;
  const feet = Math.round(metres * 3.28084);
  if (feet < 1000) return `${feet} ft`;
  const miles = metres / 1609.34;
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

const SOURCE_LABEL: Record<string, string> = {
  osm: "OpenStreetMap",
  fema: "FEMA National Flood Hazard Layer",
  usgs: "USGS 3DEP",
  census: "US Census ACS",
};

export function SiteIntel({
  signals,
  /** True when the loop has looked and found nothing, vs. not having looked. */
  checkedSources,
}: {
  signals: LotSignal[];
  checkedSources: string[];
}) {
  /*
   * A parcel nobody has researched yet and a parcel with genuinely quiet
   * surroundings are opposite facts, and rendering both as an empty section
   * would conflate them — the same distinction `lot_intel_runs` exists to keep.
   */
  if (signals.length === 0) {
    if (checkedSources.length === 0) return null;
    return (
      <section className="mt-8">
        <Heading />
        <p className="text-sm text-muted">
          Checked {checkedSources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")} — nothing of note
          within range. Quiet surroundings, or thin mapping coverage in this county.
        </p>
      </section>
    );
  }

  const concerns = signals.filter((s) => s.direction === "negative");
  const context = signals.filter((s) => s.direction !== "negative");

  return (
    <section className="mt-8">
      <Heading />

      {concerns.length > 0 ? (
        <ul className="space-y-3">
          {concerns.map((s) => (
            <SignalRow key={s.id} signal={s} />
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">
          Nothing adverse found within range of this parcel.
        </p>
      )}

      {context.length > 0 ? (
        <>
          <h3 className="mt-6 mb-3 text-xs font-medium uppercase tracking-wide text-muted">
            Context
          </h3>
          <ul className="space-y-3">
            {context.map((s) => (
              <SignalRow key={s.id} signal={s} />
            ))}
          </ul>
        </>
      ) : null}

      <p className="mt-5 text-xs text-muted">
        {OSM_ATTRIBUTION}. Flood zones from FEMA, elevation from USGS, tract statistics from the US
        Census. Proximity is measured from the parcel&rsquo;s recorded location, which for most
        parcels is an assessor centroid rather than a boundary — treat these as figures to verify on
        a site visit, not as survey distances.
      </p>
    </section>
  );
}

function Heading() {
  return (
    <>
      {/*
        Not "What's around it": that was the label of the aerial frame that
        once sat above this, and the heading was chosen to differ from it.
      */}
      <h2 className="mb-1 text-lg font-medium">Site &amp; surroundings</h2>
      <p className="mb-4 text-sm text-muted">
        Physical conditions that affect value and rarely appear on a listing.
      </p>
    </>
  );
}

function SignalRow({ signal }: { signal: LotSignal }) {
  const tone = TONE[signal.direction];
  const d = distance(signal.distanceM);

  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: tone.dot,
          /*
           * Severity as opacity on one dot, rather than three colours. A
           * three-colour scale would need a legend, and the severity is
           * already stated in the distance next to it.
           */
          opacity: signal.severity === "high" ? 1 : signal.severity === "medium" ? 0.6 : 0.35,
        }}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{signal.label}</span>
          {d ? (
            <span className="text-sm tabular-nums text-muted">
              {d}
              {/*
               * Said out loud when the measurement is from a centroid. On a
               * large parcel the boundary can be hundreds of feet closer, and a
               * reader comparing two lots deserves to know the number means
               * something slightly different on each.
               */}
              {signal.distanceBasis === "centroid" ? " from parcel centre" : " from boundary"}
            </span>
          ) : null}
        </div>
        {signal.note ? (
          <p className="mt-0.5 text-sm leading-relaxed text-muted">{signal.note}</p>
        ) : null}
      </div>
    </li>
  );
}
