"use client";

import { useState } from "react";
import { FRAMES, aerialUrl, requestWidthFor } from "@/lib/property/imagery";

/**
 * What a parcel looks like from above.
 *
 * ## Why a plain <img>
 *
 * `next/image` would bill a transformation per source image on Vercel, and buys
 * nothing here: the upstream already returns exactly the pixel dimensions asked
 * for, so there is no oversized original to resize. A plain tag costs nothing,
 * caches in the browser, and keeps the whole feature free — which is the point
 * of choosing a federal source in the first place.
 *
 * ## Why it can disappear
 *
 * Two-thirds of pending inventory has no coordinates yet, and the imagery
 * service can fail. Both cases render nothing rather than a placeholder. A grey
 * box captioned "no image available" is a promise the product is not keeping,
 * repeated on every card that lacks one; silence costs the reader nothing.
 *
 * ## Why it is not full-bleed
 *
 * It used to fill the content column, which on a wide screen meant a 640px
 * image stretched past 1600 and read as a blurry mistake. The source is about
 * one metre per pixel, so a parcel-scale frame holds only a few hundred real
 * pixels; displayed larger than that it is not showing more, it is showing the
 * same information with the interpolation made visible.
 *
 * Capped at a width the imagery can actually fill. Bigger was a claim the
 * pixels could not back.
 *
 * ## Why the caveat is not fine print
 *
 * Someone deciding whether to drive four hours to a sale will read a photograph
 * as current unless told otherwise, and aerial imagery is flown on a multi-year
 * cycle. The date line sits on the image itself, in the frame, because a caveat
 * placed below the fold of attention is a caveat designed not to be read.
 */

/** The rendered size, and the ceiling the request math is measured against. */
const DISPLAY_WIDTH = 520;
const DISPLAY_HEIGHT = 340;

export function ParcelImagery({
  latitude,
  longitude,
  /** Shown under the frame, e.g. the address this depicts. */
  caption,
}: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  caption?: string | null;
}) {
  const [frame, setFrame] = useState(0);
  const [failed, setFailed] = useState(false);

  const lat = Number(latitude);
  const lon = Number(longitude);
  /*
   * Requested at the source's real resolution rather than at the display's.
   * A larger `size` returns the same picture interpolated — measured, not
   * assumed — so asking for it only costs bytes.
   */
  const sources = FRAMES.map((f) => {
    const w = requestWidthFor(f.span, DISPLAY_WIDTH);
    return aerialUrl({
      latitude: lat,
      longitude: lon,
      span: f.span,
      width: w,
      height: Math.round((w * DISPLAY_HEIGHT) / DISPLAY_WIDTH),
    });
  });

  if (!sources[0] || failed) return null;

  return (
    <figure className="max-w-[520px] overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-[var(--shadow-sm)]">
      <div className="relative">
        {/*
          Both frames are rendered and the inactive one is hidden, rather than
          one image whose `src` changes.

          Swapping the source — with or without a key — leaves the frame blank
          for as long as the next image takes to arrive, which measured about
          two seconds on a warm connection. That reads as a broken control:
          you press "what is around it" and get an empty box. Rendering both
          costs one extra request on a card that already earned its place, and
          makes the toggle instant after that.

          Only the first is eager; the second loads lazily behind it.
        */}
        {sources.map((src, i) =>
          src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={FRAMES[i].label}
              src={src}
              alt={
                caption
                  ? `Aerial view of ${caption} — ${FRAMES[i].label.toLowerCase()}`
                  : `Aerial view from the USGS National Map — ${FRAMES[i].label.toLowerCase()}`
              }
              width={DISPLAY_WIDTH}
              height={DISPLAY_HEIGHT}
              loading="lazy"
              decoding="async"
              onError={() => i === frame && setFailed(true)}
              aria-hidden={i !== frame}
              className={`block aspect-[520/340] w-full bg-surface-2 object-cover ${
                i === frame ? "" : "absolute inset-0 opacity-0"
              }`}
            />
          ) : null,
        )}

        {/* The frame control. Two states, so a segmented pair beats a dropdown. */}
        <div className="absolute left-3 top-3 flex gap-1 rounded-full bg-ink/70 p-1 backdrop-blur">
          {FRAMES.map((f, i) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFrame(i)}
              aria-pressed={i === frame}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                i === frame ? "bg-gold text-ink" : "text-ink-fg/80 hover:text-ink-fg"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <a
          href={`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-3 right-3 rounded-full bg-ink/70 px-2.5 py-1 text-xs
                     font-medium text-ink-fg backdrop-blur transition-colors hover:bg-ink/85"
        >
          Open in Maps ↗
        </a>
      </div>

      <figcaption className="border-t border-border/70 px-4 py-2.5 text-xs text-muted">
        Aerial imagery from the{" "}
        <a
          href="https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:opacity-80"
        >
          USGS National Map
        </a>
        . Flown on a multi-year cycle — it shows the site as photographed, which may predate
        clearing, construction or demolition. Not evidence of current condition.
      </figcaption>
    </figure>
  );
}
