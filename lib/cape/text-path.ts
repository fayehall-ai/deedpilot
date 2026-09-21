/*
 * No `server-only` guard — slides are drawn from the producer CLI under tsx and
 * from the render cron.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import * as opentype from "opentype.js";

/**
 * Slide text, drawn as outlines from a font that ships with the app.
 *
 * ## Why not `<text>`
 *
 * `sharp` rasterises the slide SVG with librsvg, and librsvg asks the operating
 * system for fonts. On a Mac that is CoreText and every font on the machine. In
 * a Vercel function it is fontconfig with no fonts installed at all, so every
 * headline, bullet and address would come out blank or as a row of boxes — and
 * the encode would succeed, because an empty slide is a perfectly valid PNG.
 * That is the worst kind of failure here: a finished video in a shared folder
 * with nothing written on it.
 *
 * Pointing fontconfig at a bundled directory is the usual fix, and it only works
 * on Linux: sharp's macOS build lays text out through CoreText and ignores
 * `FONTCONFIG_FILE` entirely (checked — a config naming an empty font directory
 * still rendered Helvetica). So it could never be verified from the machine the
 * slides are reviewed on. Outlines sidestep the whole question: the SVG carries
 * paths, not text, and rasterises identically on any machine with or without a
 * single font installed.
 *
 * ## Why Liberation Sans
 *
 * SIL Open Font License, so it can ship inside the product, and metric-
 * compatible with Arial — the stack this deck was designed against was
 * Helvetica Neue, Helvetica, Arial, whose widths are close enough that the
 * conservative wrap estimate in `slides.ts` still holds. Regular and Bold are
 * bundled; the deck uses 400, 600 and 700, and 600 draws as Bold.
 *
 * The files live in `lib/cape/fonts/` and are read from the working directory,
 * which `next.config.ts` traces into the render route alongside ffmpeg.
 */

export const FONT_FAMILY = "Liberation Sans";
const FONT_DIR = path.join("lib", "cape", "fonts");
const FILES = { regular: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" } as const;

const loaded: Partial<Record<keyof typeof FILES, opentype.Font>> = {};

function fontFor(weight: number): opentype.Font {
  const key = weight >= 600 ? "bold" : "regular";
  const cached = loaded[key];
  if (cached) return cached;
  const file = path.join(process.cwd(), FONT_DIR, FILES[key]);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new Error(
      `CAPE slide font missing at ${file} — slides would render with no text. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  loaded[key] = font;
  return font;
}

export interface TextStyle {
  /** Baseline origin, as SVG `<text x y>`. */
  x: number;
  y: number;
  size: number;
  /** CSS weight. 600 and above draw Bold. */
  weight?: number;
  anchor?: "start" | "middle" | "end";
  /** Extra space after each glyph, in pixels — SVG `letter-spacing`. */
  letterSpacing?: number;
  fill: string;
  opacity?: number;
}

interface Placed {
  glyph: opentype.Glyph;
  x: number;
}

function layout(text: string, font: opentype.Font, size: number, letterSpacing: number) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  const placed: Placed[] = [];
  let x = 0;
  for (const [i, glyph] of glyphs.entries()) {
    placed.push({ glyph, x });
    x += (glyph.advanceWidth ?? 0) * scale;
    const next = glyphs[i + 1];
    if (next) x += font.getKerningValue(glyph, next) * scale + letterSpacing;
  }
  return { placed, width: x };
}

/** Rendered width of a line, in pixels. */
export function measureText(text: string, size: number, weight = 400, letterSpacing = 0): number {
  return layout(text, fontFor(weight), size, letterSpacing).width;
}

/** Attribute-safe. Only colours and numbers reach here, but a quote would end the element. */
const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One line of text as a single `<path>`.
 *
 * Positioned exactly as the equivalent `<text x y text-anchor>` would be, so the
 * layout arithmetic in `slides.ts` did not have to change: `y` is the baseline
 * and the anchor is resolved against the measured width.
 */
export function textPath(text: string, style: TextStyle): string {
  if (!text) return "";
  const font = fontFor(style.weight ?? 400);
  const { placed, width } = layout(text, font, style.size, style.letterSpacing ?? 0);
  const shift = style.anchor === "end" ? -width : style.anchor === "middle" ? -width / 2 : 0;
  const origin = style.x + shift;

  const d = placed
    .map((p) => p.glyph.getPath(origin + p.x, style.y, style.size).toPathData(2))
    .filter(Boolean)
    .join("");
  if (!d) return "";

  const opacity = style.opacity !== undefined && style.opacity !== 1 ? ` opacity="${style.opacity}"` : "";
  return `<path d="${d}" fill="${attr(style.fill)}"${opacity}/>`;
}
