/**
 * Turning a scanned PDF back into something readable.
 *
 * Measured across a 200-county sample: of the 67 counties where the pipeline
 * actually reached a parcel list, 5 published it as an image with no text
 * layer — roughly one in thirteen. Fulton County GA is the type specimen, an
 * 8-page 4.5 MB levy sale list whose entire extractable text is
 * `-- 1 of 8 -- -- 2 of 8 -- ...`. `pdfToText` correctly reports nothing, the
 * adapter correctly records "no parcel list", and a real September sale in
 * Georgia's largest county reads as though it does not exist.
 *
 * These pages are rendered to images so a vision model can read them. Nothing
 * here interprets the document — it only converts pixels to a payload.
 */
import { politeFetchBinary } from "./fetch";
import type { ImageInput } from "../ai/providers";

/**
 * Characters of extractable text per page below which a document is a scan.
 *
 * pdf-parse emits a `-- 3 of 8 --` separator for every page including empty
 * ones, so a pure scan still returns a few dozen characters. Real county
 * lists run hundreds to thousands per page; the measured scans ran zero once
 * the separators were stripped. 50 sits far from both.
 */
export const SCAN_TEXT_PER_PAGE = 50;

/** Strip pdf-parse's page separators before judging how much text there is. */
export function textDensity(text: string, pages: number): number {
  const stripped = text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").replace(/\s+/g, " ").trim();
  return stripped.length / Math.max(1, pages);
}

export interface RenderedPage extends ImageInput {
  pageNumber: number;
  width: number;
  height: number;
  bytes: number;
}

export interface RenderOptions {
  /**
   * Cap on pages rendered. A county booklet can run hundreds of pages and each
   * one is a separate paid vision call; 20 covers every scanned list in the
   * sample (the largest was 8) and stops a runaway.
   */
  maxPages?: number;
  /**
   * Render scale. 2 puts a US Letter page at roughly 1224x2016, which is
   * legible for the small type these lists are set in. Higher costs size
   * without helping: providers downsample above ~1568px on the long edge.
   */
  scale?: number;
}

/**
 * Render a PDF's pages to PNGs.
 *
 * Takes bytes rather than a URL so a caller that already downloaded the file
 * for `pdfToText` does not pay for it twice — but note that pdf.js **detaches
 * the underlying ArrayBuffer** while parsing, so a Uint8Array that has already
 * been through `PDFParse` reads as zero-length here. Pass a fresh copy, or use
 * `renderPdfFromUrl`.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  opts: RenderOptions = {},
): Promise<RenderedPage[]> {
  const { maxPages = 20, scale = 2 } = opts;
  if (bytes.length === 0) {
    throw new Error("renderPdfPages received an empty buffer (already detached by a prior parse?)");
  }

  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const shot = await parser.getScreenshot({
      partial: Array.from({ length: Math.min(maxPages, 500) }, (_, i) => i + 1),
      scale,
    });
    return shot.pages.map((p) => ({
      pageNumber: p.pageNumber,
      width: p.width,
      height: p.height,
      bytes: p.data.length,
      mediaType: "image/png",
      base64: Buffer.from(p.data).toString("base64"),
    }));
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Fetch and render in one step, through the same policy layer as every other fetch. */
export async function renderPdfFromUrl(
  url: string,
  opts: RenderOptions = {},
): Promise<RenderedPage[]> {
  const res = await politeFetchBinary(url);
  if (res.status >= 400) throw new Error(`${url}: http ${res.status}`);
  const magic = Buffer.from(res.bytes.slice(0, 5)).toString("latin1");
  if (!magic.startsWith("%PDF")) throw new Error(`${url}: not a PDF (${JSON.stringify(magic)})`);
  return renderPdfPages(res.bytes, opts);
}
