/*
 * No `server-only` guard — this runs from `scripts/cape-produce.ts` under plain
 * tsx, and it touches the filesystem and `sharp`, neither of which belongs in a
 * React server component anyway.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NUMBER_WORD, spokenToDigits, type CapeScript, type CapeSection } from "./script";

/**
 * Slides, drawn as SVG and rasterised to PNG.
 *
 * ## Why SVG and not a headless browser
 *
 * The obvious way to render a slide is HTML in Puppeteer, and it is the wrong
 * trade here. A browser is a 300MB dependency, needs a sandbox, and would make
 * video production impossible anywhere the rest of this system runs. SVG is
 * text this module can generate directly, and `sharp` — already present as a
 * transitive dependency of the Next scaffold — rasterises it without any of
 * that.
 *
 * ## Why layout lives here and not in the model
 *
 * `lib/cape/script.ts` decides what a slide says. This decides what it looks
 * like. Letting a language model emit layout would put typography and brand
 * somewhere nobody can review or diff, and would make every county video
 * subtly different from the last one. A deck that varies at random reads as
 * unfinished, however good each individual frame is.
 *
 * ## Why the text is wrapped in code
 *
 * SVG has no text wrapping. A headline that runs past the frame is not
 * truncated by the renderer, it simply draws outside it and disappears — a
 * failure that is invisible until someone watches the video. So every string is
 * measured and broken here, and the estimate is deliberately conservative.
 */

export interface SlideTheme {
  width: number;
  height: number;
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  fontFamily: string;
}

/**
 * Dark, because these are watched rather than read.
 *
 * A slide on a bright background is a document; the same content dark is a
 * video frame. The palette is the app's own — see `app/globals.css` — so the
 * video and the site do not look like two different products.
 */
export const DEFAULT_THEME: SlideTheme = {
  width: 1920,
  height: 1080,
  background: "#111827",
  surface: "#1f2937",
  text: "#f9fafb",
  muted: "#9ca3af",
  accent: "#fbbf24",
  // A stack, not a webfont: rasterisation happens on whatever machine runs the
  // encode, and an unavailable font silently changes every metric below.
  fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
};

/** XML-escape. A county named "Prince George's" breaks the document without it. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Break a string to fit a pixel width.
 *
 * The 0.52 factor is an average glyph-width ratio for the sans stack above at a
 * given point size. It is an approximation and is tuned to *over*-estimate:
 * wrapping a line early costs nothing, while under-estimating draws text past
 * the frame edge where it is silently lost.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const perChar = fontSize * 0.52;
  const maxChars = Math.max(8, Math.floor(maxWidth / perChar));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    /*
     * A single word longer than the line — a parcel identifier, a long county
     * name — is hard-broken rather than allowed to overflow.
     */
    if (word.length > maxChars) {
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars - 1) + "-");
        rest = rest.slice(maxChars - 1);
      }
      line = rest;
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The standing brand lockup, upper left on every slide.
 *
 * Asked for by the reviewer after watching a finished briefing: the mark and
 * the address should be on screen throughout, not only on the closing card,
 * because a clip of any single slide has to identify who made it.
 *
 * `logoDataUri` is deliberately optional and deliberately not defaulted to
 * DeedPilot's own `§` mark. That mark belongs to a different product, and
 * putting one brand's identity on another's video is worse than showing none.
 * With no file supplied this draws the wordmark alone, which is accurate; drop
 * the real artwork in and it sits to the left of the words.
 *
 * Placed at the same x as the body column and above y=200, which every slide
 * layout leaves clear — content headlines begin at y=260.
 */
export const BRAND_NAME = "THE TAX DEED COLLECTIVE";
export const BRAND_URL = "www.thetaxdeedcollective.com";

/** Gold diamond, the bullet marker the reference briefings use. */
function diamond(cx: number, cy: number, r: number, fill: string): string {
  return `<path d="M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z" fill="${fill}"/>`;
}

/**
 * The frame every slide carries: mark, address, and the rule along the bottom.
 *
 * Placement follows the reference briefing — the mark rides the top right,
 * clear of the text column, which alternates sides. The address sits centred on
 * the bottom edge above a gold hairline, where it is legible without competing
 * with the headline.
 */
export function chromeSvg(theme: SlideTheme, logoDataUri?: string | null): string {
  const { width: W, height: H } = theme;
  const parts: string[] = [];

  if (logoDataUri) {
    /*
     * A plate under the mark, because the text column alternates sides and the
     * mark does not: on a left-aligned slide it sits over the bright half of
     * the photograph, and the logo's own gold lettering disappears into a sky.
     * The reference deck avoids this by setting the brand as white type, which
     * survives anything; artwork with its own colours needs the ground given
     * to it.
     */
    const size = 116;
    const px = 22;
    parts.push(
      `<rect x="${W - 160 - size - px}" y="${52 - px / 2}" width="${size + px * 2}" height="${size + px}" rx="16" fill="${theme.background}" opacity="0.62"/>`,
      `<image href="${logoDataUri}" x="${W - 160 - size}" y="52" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  } else {
    parts.push(
      diamond(W - 392, 92, 9, theme.accent),
      `<text x="${W - 160}" y="101" text-anchor="end" font-family="${theme.fontFamily}" font-size="24" font-weight="600" letter-spacing="4.2" fill="${theme.text}">${esc(BRAND_NAME)}</text>`,
    );
  }

  parts.push(
    `<text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="${theme.fontFamily}" font-size="26" letter-spacing="1.2" fill="${theme.text}" opacity="0.78">${esc(BRAND_URL)}</text>`,
    `<rect x="0" y="${H - 6}" width="${W}" height="6" fill="${theme.accent}"/>`,
  );
  return parts.join("\n  ");
}

/**
 * Photograph behind, gradient over, text on top.
 *
 * The reference briefings never show a flat panel: every slide is a photograph
 * with a directional scrim, and the text sits on whichever side the scrim is
 * darkest. Alternating that side down the deck is what stops eleven sections
 * reading as one long slab.
 *
 * With no photograph the gradient still runs, over the flat ground, so the
 * composition holds rather than collapsing to a different-looking slide.
 */
function backdropSvg(
  theme: SlideTheme,
  id: string,
  side: "left" | "right",
  photo?: CountyPhoto | null,
): string {
  const { width: W, height: H } = theme;
  const stops =
    side === "left"
      ? `<stop offset="0%" stop-color="${theme.background}" stop-opacity="0.94"/>
      <stop offset="52%" stop-color="${theme.background}" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="${theme.background}" stop-opacity="0.14"/>`
      : `<stop offset="0%" stop-color="${theme.background}" stop-opacity="0.14"/>
      <stop offset="48%" stop-color="${theme.background}" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="${theme.background}" stop-opacity="0.94"/>`;

  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
      ${stops}
    </linearGradient></defs>
  <rect width="${W}" height="${H}" fill="${theme.background}"/>
  ${photo ? `<image href="${photo.dataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <rect width="${W}" height="${H}" fill="url(#${id})"/>`;
}

/**
 * Slide text, in written form.
 *
 * The narration is spoken and the slide is read. The prompt's instruction to
 * "expand symbols and abbreviations" belongs only to the first, and it reached
 * both: 417 of 487 scripts put lines like "August seventeenth, two thousand
 * twenty-six" and "Three hundred sixty-five day window" on screen.
 *
 * Three targeted rules, not a general conversion. Running `spokenToDigits`
 * across slide prose was the first attempt and it made the copy worse — it is
 * case-sensitive by design, because `verifyNarration` lowercases before calling
 * it, so "Three hundred sixty-five" became "Three 165"; and it reads ordinals
 * as quantities, so "first tier" became "1 tier". Only figures may change.
 */
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";

export function writtenForm(text: string): string {
  if (!text) return text;
  const num = (phrase: string) => spokenToDigits(phrase.toLowerCase()).trim();
  const WORDS = NUMBER_WORD.source;

  return text
    .replace(
      new RegExp(`(?:${WORDS})(?:[\\s-]+(?:${WORDS}))*(?:\\s+dash\\s+(?:${WORDS})(?:[\\s-]+(?:${WORDS}))*)+`, "gi"),
      (run) => run.split(/\s+dash\s+/i).map(num).join("-"),
    )
    .replace(
      new RegExp(`\\b(${MONTHS})\\s+((?:${WORDS})(?:[\\s-]+(?:${WORDS}))*)(,\\s*((?:${WORDS})(?:[\\s-]+(?:${WORDS}))*))?`, "gi"),
      (_m, month: string, day: string, _c: string, year: string) =>
        `${month} ${num(day)}${year ? `, ${num(year)}` : ""}`,
    )
    .replace(
      new RegExp(`\\b((?:${WORDS})(?:[\\s-]+(?:${WORDS}))*)\\s+(day|month|year|percent)\\b`, "gi"),
      (_m, run: string, unit: string) => {
        const n = num(run);
        if (!/^\d+$/.test(n)) return _m;
        return unit.toLowerCase() === "percent" ? `${n} percent` : `${n}-${unit.toLowerCase()}`;
      },
    );
}

export interface CountyPhoto {
  dataUri: string;
  caption: string;
  credit: string;
}

/** A gold eyebrow over a short rule — the reference deck's section marker. */
function eyebrowSvg(theme: SlideTheme, label: string, x: number, anchor: "start" | "end"): string {
  const ruleX = anchor === "end" ? x - 116 : x;
  return `<text x="${x}" y="188" text-anchor="${anchor}" font-family="${theme.fontFamily}" font-size="27" font-weight="600" letter-spacing="5.4" fill="${theme.accent}">${esc(label.toUpperCase())}</text>
  <rect x="${ruleX}" y="212" width="116" height="5" fill="${theme.accent}" rx="2"/>`;
}

/** The title card. */
export function titleSlideSvg(
  title: string,
  subtitle: string,
  theme: SlideTheme = DEFAULT_THEME,
  logoDataUri?: string | null,
  photo?: CountyPhoto | null,
): string {
  const { width: W, height: H } = theme;
  const titleLines = wrapText(writtenForm(title), 82, W * 0.52).slice(0, 3);
  let y = 470;

  const parts: string[] = [
    backdropSvg(theme, "t", "left", photo),
    eyebrowSvg(theme, "County auction briefing", 160, "start"),
  ];
  for (const line of titleLines) {
    parts.push(
      `<text x="160" y="${y}" font-family="${theme.fontFamily}" font-size="82" font-weight="700" fill="${theme.text}">${esc(line)}</text>`,
    );
    y += 100;
  }
  parts.push(
    `<text x="160" y="${y + 26}" font-family="${theme.fontFamily}" font-size="34" fill="${theme.text}" opacity="0.85">${esc(writtenForm(subtitle))}</text>`,
    chromeSvg(theme, logoDataUri),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n  ${parts.join("\n  ")}\n</svg>`;
}

/** A content slide: eyebrow, headline, up to four bullets, over a photograph. */
export function contentSlideSvg(
  slide: CapeSection["slide"],
  theme: SlideTheme = DEFAULT_THEME,
  logoDataUri?: string | null,
  photo?: CountyPhoto | null,
  side: "left" | "right" = "left",
  eyebrow = "",
  id = "c",
): string {
  const { width: W, height: H } = theme;
  const col = W * 0.52;
  const anchor = side === "left" ? "start" : "end";
  const x = side === "left" ? 160 : W - 160;

  const parts: string[] = [backdropSvg(theme, id, side, photo)];
  if (eyebrow) parts.push(eyebrowSvg(theme, eyebrow, x, anchor));

  let y = 330;
  for (const line of wrapText(writtenForm(slide.headline), 70, col).slice(0, 2)) {
    parts.push(
      `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${theme.fontFamily}" font-size="70" font-weight="700" fill="${theme.text}">${esc(line)}</text>`,
    );
    y += 90;
  }

  y += 44;
  for (const bullet of slide.bullets.slice(0, 4)) {
    const lines = wrapText(writtenForm(bullet), 34, col - 70).slice(0, 2);
    const markX = side === "left" ? x + 14 : x - 14;
    parts.push(diamond(markX, y - 12, 10, theme.accent));
    for (const [i, line] of lines.entries()) {
      const tx = side === "left" ? x + 54 : x - 54;
      parts.push(
        `<text x="${tx}" y="${y + i * 46}" text-anchor="${anchor}" font-family="${theme.fontFamily}" font-size="34" fill="${theme.text}" opacity="${i === 0 ? 1 : 0.82}">${esc(line)}</text>`,
      );
    }
    y += lines.length * 46 + 30;
  }

  parts.push(chromeSvg(theme, logoDataUri));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n  ${parts.join("\n  ")}\n</svg>`;
}

export interface RenderedSlide {
  index: number;
  pngPath: string;
  /** Seconds this slide is held, matched to its narration. */
  durationSec: number;
}

/** Seconds the opening card is held before the first narrated slide. */
export const TITLE_HOLD_SEC = 3;

/**
 * Total silent lead-in, which `encodeVideo` pads the narration by.
 *
 * Exported rather than recomputed at the call site: the audio and the slide
 * plan disagreeing about this number is precisely the bug that put every slide
 * three seconds behind its own narration.
 */
export function leadInSec(): number {
  return TITLE_HOLD_SEC;
}

/**
 * Rasterise every slide to PNG.
 *
 * `sharp` is imported dynamically so that merely importing this module — which
 * the CAPE checklist does, to report whether a video exists — does not load a
 * native binary.
 *
 * Photographs are cycled as backdrops rather than given slides of their own.
 * The reference briefings never cut to a bare photograph and never show a flat
 * panel; the picture is the ground the text sits on throughout, and the text
 * column alternates sides so a long deck does not read as one slab.
 */
export async function renderSlides(
  script: CapeScript,
  subtitle: string,
  outDir: string,
  sectionDurations: number[],
  theme: SlideTheme = DEFAULT_THEME,
  photos: CountyPhoto[] = [],
  logoDataUri?: string | null,
): Promise<RenderedSlide[]> {
  const { default: sharp } = await import("sharp");
  await mkdir(outDir, { recursive: true });

  const pick = (i: number) => (photos.length ? photos[i % photos.length] : null);

  const svgs: string[] = [
    titleSlideSvg(script.title, subtitle, theme, logoDataUri, pick(0)),
    ...script.sections.map((sec, i) =>
      contentSlideSvg(
        sec.slide,
        theme,
        logoDataUri,
        pick(i + 1),
        i % 2 === 0 ? "left" : "right",
        sec.heading,
        `c${i}`,
      ),
    ),
  ];

  const durations = [TITLE_HOLD_SEC, ...sectionDurations];

  const out: RenderedSlide[] = [];
  for (const [i, svg] of svgs.entries()) {
    const pngPath = path.join(outDir, `slide-${String(i).padStart(3, "0")}.png`);
    await sharp(Buffer.from(svg)).png().toFile(pngPath);
    out.push({ index: i, pngPath, durationSec: durations[i] ?? 4 });
  }

  // Kept next to the frames: when a slide looks wrong, the SVG is the diff.
  await writeFile(
    path.join(outDir, "slides.svg.json"),
    JSON.stringify(
      svgs.map((v) => v.replace(/href="data:[^"]+"/g, 'href="data:…elided…"')),
      null,
      1,
    ),
    "utf8",
  );

  return out;
}
