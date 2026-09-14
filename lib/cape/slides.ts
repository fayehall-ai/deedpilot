/*
 * No `server-only` guard — this runs from `scripts/cape-produce.ts` under plain
 * tsx, and it touches the filesystem and `sharp`, neither of which belongs in a
 * React server component anyway.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapeScript, CapeSection } from "./script";

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

/** The title card. */
export interface TitleBackdrop {
  dataUri: string;
  seat: string;
  credit: string;
}

export function titleSlideSvg(
  title: string,
  subtitle: string,
  theme: SlideTheme = DEFAULT_THEME,
  backdrop?: TitleBackdrop | null,
): string {
  const { width: W, height: H } = theme;
  const titleLines = wrapText(title, 86, W - 320).slice(0, 3);
  const startY = H / 2 - (titleLines.length - 1) * 55 - 20;

  /*
   * The scrim is not a style choice. Aerial imagery is high-frequency detail at
   * every brightness, and white text laid straight onto it is unreadable over
   * roofs and parking lots. 0.72 keeps the town legible underneath while the
   * title stays the thing being read.
   */
  const backdropSvg = backdrop
    ? `<image href="${backdrop.dataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="${theme.background}" opacity="0.72"/>`
    : "";

  const backdropCaption = backdrop
    ? `<text x="160" y="${H - 140}" font-family="${theme.fontFamily}" font-size="30" fill="${theme.muted}">County seat — ${esc(backdrop.seat)}</text>
  <text x="${W - 160}" y="${H - 90}" text-anchor="end" font-family="${theme.fontFamily}" font-size="22" fill="${theme.muted}">${esc(backdrop.credit)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${theme.background}"/>
  ${backdropSvg}
  ${backdropCaption}
  <rect x="0" y="0" width="14" height="${H}" fill="${theme.accent}"/>
  ${titleLines
    .map(
      (l, i) =>
        `<text x="160" y="${startY + i * 110}" font-family="${theme.fontFamily}" font-size="86" font-weight="700" fill="${theme.text}">${esc(l)}</text>`,
    )
    .join("\n  ")}
  <text x="160" y="${startY + titleLines.length * 110 + 40}" font-family="${theme.fontFamily}" font-size="38" fill="${theme.accent}">${esc(subtitle)}</text>
  <text x="160" y="${H - 90}" font-family="${theme.fontFamily}" font-size="28" fill="${theme.muted}">The Tax Deed Collective — county auction briefing</text>
</svg>`;
}

/** A content slide: headline, up to four bullets, and an optional large figure. */
export function contentSlideSvg(
  slide: CapeSection["slide"],
  theme: SlideTheme = DEFAULT_THEME,
): string {
  const { width: W, height: H } = theme;
  const hasFigure = Boolean(slide.figure);
  // The figure occupies the right third, so text wraps into what is left.
  const textWidth = hasFigure ? W - 760 : W - 320;

  const headlineLines = wrapText(slide.headline, 64, textWidth).slice(0, 2);
  let y = 260;

  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="${theme.background}"/>`,
    `<rect x="0" y="0" width="14" height="${H}" fill="${theme.accent}"/>`,
  ];

  for (const line of headlineLines) {
    parts.push(
      `<text x="160" y="${y}" font-family="${theme.fontFamily}" font-size="64" font-weight="700" fill="${theme.text}">${esc(line)}</text>`,
    );
    y += 84;
  }

  parts.push(
    `<rect x="160" y="${y - 20}" width="120" height="5" fill="${theme.accent}" rx="2"/>`,
  );
  y += 80;

  for (const bullet of slide.bullets.slice(0, 4)) {
    const lines = wrapText(bullet, 38, textWidth - 60).slice(0, 2);
    parts.push(`<circle cx="176" cy="${y - 12}" r="7" fill="${theme.accent}"/>`);
    for (const [i, line] of lines.entries()) {
      parts.push(
        `<text x="212" y="${y + i * 50}" font-family="${theme.fontFamily}" font-size="38" fill="${i === 0 ? theme.text : theme.muted}">${esc(line)}</text>`,
      );
    }
    y += lines.length * 50 + 34;
  }

  if (slide.figure) {
    const figureLines = wrapText(slide.figureLabel ?? "", 26, 460).slice(0, 3);
    parts.push(
      `<rect x="${W - 620}" y="300" width="460" height="360" rx="28" fill="${theme.surface}"/>`,
      `<text x="${W - 390}" y="480" text-anchor="middle" font-family="${theme.fontFamily}" font-size="${slide.figure.length > 7 ? 66 : 96}" font-weight="700" fill="${theme.accent}">${esc(slide.figure)}</text>`,
      ...figureLines.map(
        (l, i) =>
          `<text x="${W - 390}" y="${540 + i * 34}" text-anchor="middle" font-family="${theme.fontFamily}" font-size="26" fill="${theme.muted}">${esc(l)}</text>`,
      ),
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n  ${parts.join("\n  ")}\n</svg>`;
}

export interface RenderedSlide {
  index: number;
  pngPath: string;
  /** Seconds this slide is held, matched to its narration. */
  durationSec: number;
}

/**
 * Rasterise every slide to PNG.
 *
 * `sharp` is imported dynamically so that merely importing this module — which
 * the CAPE checklist does, to report whether a video exists — does not load a
 * native binary. The checklist runs on every page render; the encoder runs on a
 * queue.
 */
export async function renderSlides(
  script: CapeScript,
  subtitle: string,
  outDir: string,
  sectionDurations: number[],
  theme: SlideTheme = DEFAULT_THEME,
  backdrop?: TitleBackdrop | null,
): Promise<RenderedSlide[]> {
  const { default: sharp } = await import("sharp");
  await mkdir(outDir, { recursive: true });

  const svgs: string[] = [
    titleSlideSvg(script.title, subtitle, theme, backdrop),
    ...script.sections.map((s) => contentSlideSvg(s.slide, theme)),
  ];

  /*
   * The title card is held for a fixed beat because nothing is spoken over it.
   * Every other slide runs exactly as long as its own narration, which is what
   * keeps picture and voice in step without a timing track.
   */
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
      svgs.map((v) => v.replace(/href="data:[^"]+"/, 'href="data:…elided…"')),
      null,
      1,
    ),
    "utf8",
  );

  return out;
}

/** Seconds the opening card is held before the first narrated slide. */
export const TITLE_HOLD_SEC = 3;
