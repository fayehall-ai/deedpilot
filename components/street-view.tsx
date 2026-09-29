/**
 * The parcel from the street, above the aerial view.
 *
 * Renders only when Google has a photograph near the address — the metadata
 * call that decides is free — so a rural lot with no coverage shows nothing
 * rather than a grey "no image" box. The capture date sits on the frame: a
 * 2019 photograph of a house in a 2026 tax sale is a claim about 2019.
 *
 * Two forms. With an embed key, the interactive panorama from the Maps Embed
 * API: full resolution, turnable, and free — what Zillow shows for a home with
 * no listing photos. Without one, the static photograph through
 * /api/lots/[id]/streetview, which Google caps at 640 pixels.
 */
import {
  headingTo,
  streetViewEmbedKey,
  streetViewEmbedUrl,
  streetViewMetadata,
} from "@/lib/property/streetview";

export async function StreetView({
  lotId,
  location,
  latitude,
  longitude,
}: {
  lotId: string;
  location: string | null;
  /** The parcel's point, to open the panorama facing it. */
  latitude: number | null;
  longitude: number | null;
}) {
  if (!location) return null;
  const meta = await streetViewMetadata(location);
  if (!meta) return null;

  const embedKey = streetViewEmbedKey();
  const heading =
    meta.lat !== null && meta.lng !== null && latitude !== null && longitude !== null
      ? headingTo({ lat: meta.lat, lng: meta.lng }, { lat: latitude, lng: longitude })
      : undefined;
  const embed =
    embedKey && meta.panoId
      ? streetViewEmbedUrl({ panoId: meta.panoId, key: embedKey, heading })
      : null;

  const taken = meta.date
    ? new Date(`${meta.date}-01T00:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <figure
      className={`w-full ${embed ? "max-w-[760px]" : "max-w-[520px]"} shrink-0 overflow-hidden rounded-3xl border border-border/70 bg-surface text-foreground shadow-[var(--shadow-sm)]`}
    >
      <div className="relative">
        {embed ? (
          <iframe
            src={embed}
            title={`Street view of ${location}`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
            className="block aspect-[16/10] w-full border-0 bg-surface-2"
          />
        ) : (
          /* A plain <img>: the route returns the exact size, so next/image would only add a billed transform. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/lots/${lotId}/streetview`}
            alt={`Street view of ${location}`}
            width={520}
            height={325}
            loading="lazy"
            decoding="async"
            className="block aspect-[640/400] w-full bg-surface-2 object-cover"
          />
        )}
        {embed ? null : (
          <a
            href={`https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: location })}`}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-3 right-3 rounded-full bg-ink/70 px-2.5 py-1 text-xs font-medium text-ink-fg backdrop-blur transition-colors hover:bg-ink/85"
          >
            Open in Maps ↗
          </a>
        )}
      </div>
      <figcaption className="border-t border-border/70 px-4 py-3 text-sm text-muted">
        Google Street View of {location}
        {taken ? `, photographed ${taken}` : ""}. It shows the house as it was then, not as it
        is now{embed ? " — drag to look around." : "."}
      </figcaption>
    </figure>
  );
}
