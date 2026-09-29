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
