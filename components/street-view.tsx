/**
 * The front of the house, from the street, above the aerial view.
 *
 * Renders only when Google has a photograph near the address — the metadata
 * call that decides is free — so a rural lot with no coverage shows nothing
 * rather than a grey "no image" box. The capture date sits on the frame: a
 * 2019 photograph of a house in a 2026 tax sale is a claim about 2019.
 */
import { streetViewMetadata } from "@/lib/property/streetview";

export async function StreetView({ lotId, location }: { lotId: string; location: string | null }) {
  if (!location) return null;
  const meta = await streetViewMetadata(location);
  if (!meta) return null;

  const taken = meta.date
    ? new Date(`${meta.date}-01T00:00:00Z`).toLocaleDateString("en-US", {
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
          src={`/api/lots/${lotId}/streetview`}
          alt={`Street view of ${location}`}
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
          href={`https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: location })}`}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-3 right-3 rounded-full bg-ink/70 px-2.5 py-1 text-xs font-medium text-ink-fg backdrop-blur transition-colors hover:bg-ink/85"
        >
          Open in Maps ↗
        </a>
      </div>
      <figcaption className="border-t border-border/70 px-4 py-3 text-sm text-muted">
        Google Street View of {location}. It shows the house as photographed
        {taken ? ` in ${taken}` : ""}, not as it is now.
      </figcaption>
    </figure>
  );
}
