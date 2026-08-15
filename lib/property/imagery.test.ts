import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAMES, aerialUrl, hasUsableCoordinates, requestWidthFor } from "./imagery";

/**
 * The rules worth locking down are the ones that fail silently.
 *
 * A wrong bbox does not throw — it returns a perfectly valid photograph of
 * somewhere else, which is the single most damaging thing this module could do.
 */

function bboxOf(url: string): [number, number, number, number] {
  const bbox = new URL(url).searchParams.get("bbox")!;
  const parts = bbox.split(",").map(Number);
  return [parts[0], parts[1], parts[2], parts[3]];
}

test("refuses coordinates that would render the wrong place", () => {
  // Null Island — what a failed geocode looks like once someone stores it.
  assert.equal(aerialUrl({ latitude: 0, longitude: 0 }), null);
  assert.equal(aerialUrl({ latitude: NaN, longitude: -90 }), null);
  assert.equal(aerialUrl({ latitude: 91, longitude: -90 }), null);
  assert.equal(aerialUrl({ latitude: 40, longitude: 181 }), null);
  assert.equal(hasUsableCoordinates(null, null), false);
  assert.equal(hasUsableCoordinates(36.4558, -93.1603), true);
});

test("centres the frame on the parcel", () => {
  const [w, s, e, n] = bboxOf(aerialUrl({ latitude: 36.4558, longitude: -93.1603 })!);
  assert.ok(Math.abs((w + e) / 2 - -93.1603) < 1e-9, "longitude is not centred");
  assert.ok(Math.abs((s + n) / 2 - 36.4558) < 1e-9, "latitude is not centred");
  assert.ok(w < e && s < n, "bbox corners are inverted");
});

test("corrects the longitude span for latitude", () => {
  /*
   * A degree of longitude is about 111km at the equator and 78km at 45°N. A
   * fixed degree span would render northern Michigan at roughly twice the zoom
   * of southern Texas — the kind of bug that looks like nothing until you
   * compare two parcels side by side.
   */
  const south = bboxOf(aerialUrl({ latitude: 26, longitude: -98, span: 160 })!);
  const north = bboxOf(aerialUrl({ latitude: 47, longitude: -88, span: 160 })!);
  const southWidth = south[2] - south[0];
  const northWidth = north[2] - north[0];
  assert.ok(
    northWidth > southWidth * 1.2,
    `northern frame should span more degrees, got ${northWidth} vs ${southWidth}`,
  );
});

test("frames the image to the requested aspect, not a square", () => {
  const [w, s, e, n] = bboxOf(aerialUrl({ latitude: 40, longitude: -90, width: 640, height: 420 })!);
  const lonDeg = e - w;
  const latDeg = n - s;
  // Degrees of longitude are shorter than degrees of latitude away from the
  // equator, so compare ground distance rather than raw degrees.
  const lonMetres = lonDeg * 111_320 * Math.cos((40 * Math.PI) / 180);
  const latMetres = latDeg * 111_320;
  assert.ok(
    Math.abs(lonMetres / latMetres - 640 / 420) < 0.02,
    `ground aspect ${lonMetres / latMetres} should match image aspect ${640 / 420}`,
  );
});

test("a wider frame covers more ground", () => {
  const close = bboxOf(aerialUrl({ latitude: 40, longitude: -90, span: FRAMES[0].span })!);
  const wide = bboxOf(aerialUrl({ latitude: 40, longitude: -90, span: FRAMES[1].span })!);
  assert.ok(wide[2] - wide[0] > close[2] - close[0]);
  assert.ok(FRAMES.length >= 2, "the frame control assumes at least two frames");
});

test("asks the imagery service for a real image", () => {
  const url = aerialUrl({ latitude: 36.4558, longitude: -93.1603 })!;
  const q = new URL(url).searchParams;
  assert.equal(q.get("f"), "image");
  assert.equal(q.get("format"), "jpg");
  assert.equal(q.get("bboxSR"), "4326", "bbox is sent in degrees, so it must say so");
  assert.equal(q.get("size"), "640,420");
  assert.ok(url.startsWith("https://basemap.nationalmap.gov/"), "must stay on the federal source");
});

test("never asks for more pixels than the source carries", () => {
  /*
   * NAIP is about a metre per pixel, so a 260m frame holds ~260 real pixels.
   * Asking for 1040 (a 520px slot at 2x) returns the same picture interpolated
   * — measured against the live service, not assumed — and costs three times
   * the bytes for it.
   */
  const close = requestWidthFor(260, 520);
  assert.ok(close <= 260 * 1.5 + 1, `close frame asked for ${close}px of a ~260px source`);

  // The wide frame genuinely has the information, so it may use the display.
  const wide = requestWidthFor(900, 520);
  assert.equal(wide, 1040, "a 900m frame can fill a 520px slot at 2x");

  // Never so small that it is visibly blocky.
  assert.ok(requestWidthFor(40, 520) >= 320);
});

test("the close frame is not tighter than the source can support", () => {
  /*
   * It opened at 160m, which rendered as mush on any screen wider than a
   * phone. This is the regression guard for that, expressed as the rule rather
   * than the number: the frame must carry enough real pixels to be worth
   * showing at the size it is shown.
   */
  assert.ok(FRAMES[0].span >= 240, `close frame ${FRAMES[0].span}m is below the legible floor`);
  assert.ok(FRAMES[1].span > FRAMES[0].span * 2, "the two frames should be meaningfully different");
});
