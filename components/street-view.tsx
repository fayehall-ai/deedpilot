/**
 * The front of the house on the parcel page, beside the aerial view.
 *
 * Renders only when Google has a photograph near the address — the metadata
 * call that decides is free — so a rural lot with no coverage shows nothing
 * rather than a grey "no image" box.
 */
import { streetViewMetadata } from "@/lib/property/streetview";
import { StreetViewFrame } from "./street-view-frame";

export async function StreetView({
  lotId,
  location,
}: {
  lotId: string;
  location: { query: string; label: string } | null;
}) {
  if (!location) return null;
  const meta = await streetViewMetadata(location.query);
  if (!meta) return null;
  return (
    <StreetViewFrame
      src={`/api/lots/${lotId}/streetview`}
      label={location.label}
      mapsQuery={location.query}
      date={meta.date}
    />
  );
}

/**
 * The same photograph, small, for the top-left of the property card — where
 * PropStream puts the listing photo. Same free metadata check, same route.
 */
export async function StreetViewThumb({
  lotId,
  location,
}: {
  lotId: string;
  location: { query: string; label: string } | null;
}) {
  if (!location) return null;
  const meta = await streetViewMetadata(location.query);
  if (!meta) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/lots/${lotId}/streetview`}
      alt={`Street view of ${location.label}`}
      width={640}
      height={480}
      loading="lazy"
      decoding="async"
      className="block aspect-[4/3] w-full rounded-xl bg-surface-2 object-cover"
    />
  );
}
