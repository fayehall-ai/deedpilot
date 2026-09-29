/**
 * The "LLM extracts" half of the pipeline.
 *
 * Used where a source publishes a real parcel list but in a shape no selector
 * can be written against — a county PDF booklet, a prose legal notice, an
 * HTML blob whose markup changes between sales. The model reads it and returns
 * structured rows; `judgeLots` then decides what is admissible.
 *
 * The model is never asked to interpret, value, or infer. It transcribes what
 * is on the page and leaves anything absent undefined. Everything it produces
 * is treated as untrusted until the judge passes it.
 */

import { z } from "zod";
import { runStructured, NoProviderAvailableError } from "../ai/providers";
import type { DiscoveredLot } from "./types";
import type { RenderedPage } from "./render";
import { cleanAddressLine } from "./clean-address";

const ExtractedLotSchema = z.object({
  parcelNumber: z
    .string()
    .nullable()
    .describe("County parcel/map identifier exactly as printed, or null"),
  lotNumber: z.string().nullable().describe("Sale sequence number, or null"),
  ownerName: z.string().nullable().describe("Owner/defendant of record, or null"),
  addressLine: z.string().nullable().describe("Street address of the property, or null"),
  city: z.string().nullable(),
  openingBid: z
    .number()
    .nullable()
    .describe("Opening bid / minimum bid / total due, as a number without symbols"),
  legalDescription: z.string().nullable(),
});

const ExtractionSchema = z.object({
  /** False when the document has no parcel list at all — a real, common outcome. */
  containsParcelList: z.boolean(),
  /** Why, when containsParcelList is false. */
  note: z.string().nullable(),
  lots: z.array(ExtractedLotSchema),
});

/**
 * What names a lot when the list prints no parcel number.
 *
 * Wyandotte County, Kansas numbers its sale items and gives each an address,
 * with no parcel ID, and every one of its 127 lots was rejected as
 * unidentifiable. The county's own item number is unique within its sale, and
 * the address is the last resort. A lot with a parcel number needs neither.
 */
function identityOf(l: { parcelNumber: string | null; lotNumber: string | null; addressLine: string | null }): string | undefined {
  if (l.parcelNumber?.trim()) return undefined;
  if (l.lotNumber?.trim()) return `item ${l.lotNumber.trim()}`;
  if (l.addressLine?.trim()) return `address ${l.addressLine.trim().toLowerCase()}`;
  return undefined;
}

export type ExtractionResult = {
  lots: DiscoveredLot[];
  containsParcelList: boolean;
  note: string | null;
  model: string;
};

const SYSTEM = `You transcribe tax sale parcel listings from county documents into structured rows.

Rules:
- Transcribe only. Never infer, estimate, complete, or correct a value. If a
  field is not printed for a parcel, return null for it.
- A document that explains how tax sales work, announces that no sale is
  scheduled, or lists excess funds from *past* sales does NOT contain a parcel
  list. Set containsParcelList=false and say so in note. Do not manufacture rows.
- Excess-funds and past-results tables are not upcoming sale listings.
- Money: return a plain number. "$1,234.56" becomes 1234.56.
- Parcel numbers keep their exact printed punctuation and spacing.
- Where a list identifies parcels by block and lot (New Jersey does), put them
  in parcelNumber as "BLOCK - LOT", adding " - QUALIFIER" when one is printed,
  e.g. "12 - 2.04" or "1402 - 7 - C0004". The advertisement or sale number goes
  in lotNumber.
- Transcribe every parcel in the list, not a sample.`;

/**
 * How much of a document the model is asked to read.
 *
 * This was 80,000 characters and anything past it was dropped without a word —
 * a county list of a few thousand parcels arrived as its first few hundred. It
 * is now large enough for the lists counties actually publish, with a note on
 * the result when a document is longer still, so a truncation is visible.
 */
const MAX_CHARS = 300_000;

/**
 * One call's worth of list: small enough that its transcription fits the
 * model's output limit.
 *
 * At 40,000 characters a list of three hundred rows produced more JSON than a
 * 12,000-token answer holds; Grok stopped at its length limit, Claude's
 * truncated answer failed to parse, and the county — Fayette, Pennsylvania,
 * with a clean, fully readable list — was recorded as needing manual review.
 * Output grows with rows, so the chunk is sized in characters of list, and a
 * chunk that still overflows is split and retried.
 */
const CHUNK = 12_000;
/** Chunks read at once, so a long list is not read one call at a time. */
const CONCURRENCY = 4;

const overflowed = (e: unknown) =>
  /length limit|no parsed output|max_tokens|maximum.*tokens|truncat/i.test(e instanceof Error ? e.message : String(e));

/** Whole lines into chunks of at most `CHUNK` characters, so no row is cut in two. */
function chunkByLines(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > CHUNK) {
      chunks.push(current);
      current = "";
    }
    /* A single line longer than a chunk — a PDF with no line breaks — is cut where it must be. */
    for (let i = 0; i < line.length; i += CHUNK) {
      const piece = line.slice(i, i + CHUNK);
      if (current && current.length + piece.length + 1 > CHUNK) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Extract parcels from an unstructured county document.
 *
 * Throws `NoProviderAvailableError` when no LLM is configured — callers should
 * record the county as needing manual review rather than treating it as
 * having no sale.
 */
export async function extractLots(
  text: string,
  context: { countyName: string; state: string; sourceUrl: string; saleDate?: string },
): Promise<ExtractionResult> {
  /* Line breaks kept: a row per line is what lets a chunk end between parcels. */
  const full = text
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const trimmed = full.slice(0, MAX_CHARS);

  if (trimmed.length < 100) {
    return {
      lots: [],
      containsParcelList: false,
      note: "Document had almost no extractable text (likely a scanned image or an empty page).",
      model: "none",
    };
  }

  const chunks = chunkByLines(trimmed);

  type Result = Awaited<ReturnType<typeof runStructured<typeof ExtractionSchema>>>;
  const readChunk = async (chunk: string, label: string): Promise<Result[]> => {
    const t0 = Date.now();
    try {
      const done = await runStructured({
        system: SYSTEM,
        schema: ExtractionSchema,
        schemaName: "tax_sale_listing",
        /* A 12,000-character chunk of Fayette's list came back as 9,485 tokens. */
        maxTokens: 32000,
        tier: "transcribe",
        timeoutMs: 180_000,
        attempts: 2,
        prompt: `Source: ${context.countyName} County, ${context.state}
URL: ${context.sourceUrl}
${chunks.length > 1 ? `Document part ${label} (continue extracting; do not restate prior parcels).` : ""}

Transcribe every parcel in the upcoming tax sale listing below. If this document
does not contain one, set containsParcelList=false.
If the document is truncated mid-list, extract every complete parcel that appears.${
          context.saleDate
            ? `
This is for the sale on ${context.saleDate}. If the document lists parcels for more
than one sale (an earlier case, a later offering), transcribe only the parcels
offered at this sale.`
            : ""
        }

---
${chunk}`,
      });
      console.log(
        `[extract] ${context.countyName} part ${label}: ${chunk.length} chars → ${done.data.lots.length} lot(s) ` +
          `in ${Math.round((Date.now() - t0) / 1000)}s (${done.model})`,
      );
      return [done];
    } catch (e) {
      console.warn(`[extract] ${context.countyName} part ${label}: failed after ${Math.round((Date.now() - t0) / 1000)}s`);
      /* Still too much list for one answer: halve it on a line break and read both. */
      if (!overflowed(e) || chunk.length < 2_000) throw e;
      const lines = chunk.split("\n");
      const mid = lines.length > 1 ? Math.ceil(lines.length / 2) : 0;
      const [a, b] = mid ? [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")] : [chunk.slice(0, chunk.length / 2), chunk.slice(chunk.length / 2)];
      return [...(await readChunk(a, `${label}a`)), ...(await readChunk(b, `${label}b`))];
    }
  };

  const results: Result[][] = new Array(chunks.length);
  /*
   * A one-chunk document that says it holds no list costs one call, as before.
   * A longer one is read in full: its first chunk is often a cover page or the
   * statutory notice, and stopping there dropped the list behind it.
   */
  results[0] = await readChunk(chunks[0], `1 of ${chunks.length}`);
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length - 1) }, async () => {
      while (next < chunks.length) {
        const i = next++;
        results[i] = await readChunk(chunks[i], `${i + 1} of ${chunks.length}`);
      }
    }),
  );

  const merged: DiscoveredLot[] = [];
  const seen = new Set<string>();
  let model = "none";
  let anyList = false;
  let lastNote: string | null = null;

  results.flat().forEach((result, idx) => {
    model = result.model;
    lastNote = result.data.note;
    if (result.data.containsParcelList) anyList = true;
    for (const l of result.data.lots) {
      const key = (l.parcelNumber ?? l.lotNumber ?? l.addressLine ?? JSON.stringify(l)).toString();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        parcelNumber: l.parcelNumber ?? undefined,
        externalId: identityOf(l),
        lotNumber: l.lotNumber ?? undefined,
        ownerName: l.ownerName ?? undefined,
        addressLine: cleanAddressLine(l.addressLine),
        city: l.city ?? undefined,
        openingBid: l.openingBid ?? undefined,
        legalDescription: l.legalDescription ?? undefined,
        sourceUrl: context.sourceUrl,
        raw: { extracted: true, model: result.model, chunk: idx },
      });
    }
  });

  const truncated =
    full.length > MAX_CHARS
      ? `Only the first ${MAX_CHARS.toLocaleString()} of ${full.length.toLocaleString()} characters were read; the list continues.`
      : null;
  return {
    lots: merged,
    containsParcelList: anyList || merged.length > 0,
    note: [truncated, lastNote].filter(Boolean).join(" ") || null,
    model,
  };
}

/**
 * The same transcription job, done with the model's eyes.
 *
 * Identical rules to the text path — transcribe, never infer — with two
 * additions that only matter when reading pixels: say when a character is
 * genuinely illegible rather than guessing at it, and do not treat a page of
 * statutory preamble as a parcel list. A misread digit in a parcel number is
 * worse than a null, because a null is visible and a wrong parcel is not.
 */
const VISION_SYSTEM = `${SYSTEM}
- You are reading a scanned image of a printed document, not digital text.
- If a character or figure is genuinely illegible, return null for that field
  rather than guessing. A missing value is recoverable; a misread parcel
  number or bid amount is not.
- Read the whole page including rows that continue past a page break.
- Column headers, page numbers, county letterhead and statutory preamble are
  not parcels.`;

/**
 * Transcribe parcels from rendered page images.
 *
 * One request per page rather than one per document: a rendered page runs
 * ~1.2 MB before base64, so a booklet would exceed every provider's request
 * cap, and a per-page loop also means one unreadable page costs one page
 * rather than the whole list.
 *
 * A page that yields nothing is not fatal — scanned lists routinely open with
 * a cover page of statutory text. `containsParcelList` is true if any page
 * had one.
 */
export async function extractLotsFromImages(
  pages: RenderedPage[],
  context: { countyName: string; state: string; sourceUrl: string },
): Promise<ExtractionResult> {
  if (pages.length === 0) {
    return {
      lots: [],
      containsParcelList: false,
      note: "No pages could be rendered from this document.",
      model: "none",
    };
  }

  const merged: DiscoveredLot[] = [];
  const seen = new Set<string>();
  let model = "none";
  let anyList = false;
  let lastNote: string | null = null;
  let blankPages = 0;

  for (const page of pages) {
    const result = await runStructured({
      system: VISION_SYSTEM,
      schema: ExtractionSchema,
      schemaName: "tax_sale_listing",
      maxTokens: 16000,
      /*
       * The transcription tier, as for text: on the reasoning model a
       * 12-page scan (Thomas County, Georgia) ran each page to its timeout
       * and took the whole dispatch tick past 800 seconds.
       */
      tier: "transcribe",
      timeoutMs: 180_000,
      attempts: 2,
      images: [{ mediaType: page.mediaType, base64: page.base64 }],
      prompt: `Source: ${context.countyName} County, ${context.state}
URL: ${context.sourceUrl}
Page ${page.pageNumber} of ${pages.length} of a scanned tax sale document.

Transcribe every parcel visible on this page. If this page carries no parcel
rows — a cover sheet, terms of sale, or an index — set containsParcelList=false
and say which it is in note.`,
    });

    model = result.model;
    lastNote = result.data.note;
    if (result.data.containsParcelList) anyList = true;

    let added = 0;
    for (const l of result.data.lots) {
      const key = (l.parcelNumber ?? l.lotNumber ?? l.addressLine ?? JSON.stringify(l)).toString();
      if (seen.has(key)) continue;
      seen.add(key);
      added++;
      merged.push({
        parcelNumber: l.parcelNumber ?? undefined,
        externalId: identityOf(l),
        lotNumber: l.lotNumber ?? undefined,
        ownerName: l.ownerName ?? undefined,
        addressLine: cleanAddressLine(l.addressLine),
        city: l.city ?? undefined,
        openingBid: l.openingBid ?? undefined,
        legalDescription: l.legalDescription ?? undefined,
        sourceUrl: context.sourceUrl,
        raw: { extracted: true, vision: true, model: result.model, page: page.pageNumber },
      });
    }

    /*
     * Stop after two consecutive empty pages once something has been found.
     * Scanned lists end with blank backs and excess-funds appendices, and each
     * page is a paid call. Two rather than one because a list can be
     * interrupted by a single continuation or map page.
     */
    if (added === 0) {
      blankPages++;
      if (anyList && blankPages >= 2) {
        console.log(
          `[extract] ${context.sourceUrl}: stopping at page ${page.pageNumber} — two consecutive pages with no parcels`,
        );
        break;
      }
    } else {
      blankPages = 0;
    }
  }

  return { lots: merged, containsParcelList: anyList || merged.length > 0, note: lastNote, model };
}

export { NoProviderAvailableError };
