/**
 * The Street View photograph, framed: the photo, when it was taken, and a way
 * out to Maps. Presentational only — no server imports — so the parcel page
 * and the home-page lookup draw the same frame.
 *
 * The capture date sits on the frame: a 2019 photograph of a house in a 2026
 * tax sale is a claim about 2019.
 */
export function StreetViewFrame({
  src,
  label,
  mapsQuery,
  date,
}: {
  /** Our pass-through route, which keeps the Google key server-side. */
  src: string;
  /** What the photo shows, for the alt text. */
  label: string;
  mapsQuery: string;
  /** YYYY-MM, as Google reports it. */
  date: string | null;
}) {
  const taken = date
    ? new Date(`${date}-01T00:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <figure className="w-full max-w-[640px] shrink-0 overflow-hidden rounded-3xl border border-border/70 bg-surface text-foreground shadow-[var(--shadow-sm)]">
      <div className="relative">
        {/* A plain <img>: the route returns the exact size, so next/image would only add a billed transform. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`Street view of ${label}`}
          width={640}
          height={480}
          loading="lazy"
          decoding="async"
          className="block aspect-[4/3] w-full bg-surface-2 object-cover"
        />
        {taken ? (
          <span className="absolute left-3 top-3 rounded-full bg-ink/70 px-2.5 py-1 text-xs font-medium text-ink-fg backdrop-blur">
            Photographed {taken}
          </span>
        ) : null}
        <a
          href={`https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: mapsQuery })}`}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-3 right-3 rounded-full bg-ink/70 px-2.5 py-1 text-xs font-medium text-ink-fg backdrop-blur transition-colors hover:bg-ink/85"
        >
          Open in Maps ↗
        </a>
      </div>
    </figure>
  );
}
