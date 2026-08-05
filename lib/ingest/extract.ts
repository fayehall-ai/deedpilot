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
- Transcribe every parcel in the list, not a sample.`;

/**
 * Cap the payload so a 300-page booklet doesn't blow the context window.
 * 80k chars is enough for a typical county list page and keeps Claude under
 * the non-streaming duration estimate that used to force 10-minute streaming
 * failures on huge booklets.
 */
const MAX_CHARS = 80_000;

/**
 * Extract parcels from an unstructured county document.
 *
 * Throws `NoProviderAvailableError` when no LLM is configured — callers should
 * record the county as needing manual review rather than treating it as
 * having no sale.
 */
export async function extractLots(
  text: string,
  context: { countyName: string; state: string; sourceUrl: string },
): Promise<ExtractionResult> {
  // Prefer full document for deterministic pre-parse; LLM still gets a cap.
  const full = text.replace(/\s+/g, " ").trim();
  const trimmed = full.slice(0, MAX_CHARS);

  if (trimmed.length < 100) {
    return {
      lots: [],
      containsParcelList: false,
      note: "Document had almost no extractable text (likely a scanned image or an empty page).",
      model: "none",
    };
  }

  // Chunk large documents so a 300k-char delinquent list does not blow
  // structured-output JSON mid-string (Claude truncates and parse fails).
  const CHUNK = 40_000;
  const OVERLAP = 500;
  const chunks: string[] = [];
  if (trimmed.length <= CHUNK) {
    chunks.push(trimmed);
  } else {
    for (let i = 0; i < trimmed.length; i += CHUNK - OVERLAP) {
      chunks.push(trimmed.slice(i, i + CHUNK));
      if (i + CHUNK >= trimmed.length) break;
    }
  }

  const merged: DiscoveredLot[] = [];
  const seen = new Set<string>();
  let model = "none";
  let anyList = false;
  let lastNote: string | null = null;

  for (const [idx, chunk] of chunks.entries()) {
    const result = await runStructured({
      system: SYSTEM,
      schema: ExtractionSchema,
      schemaName: "tax_sale_listing",
      maxTokens: 12000,
      prompt: `Source: ${context.countyName} County, ${context.state}
URL: ${context.sourceUrl}
${chunks.length > 1 ? `Document part ${idx + 1} of ${chunks.length} (continue extracting; do not restate prior parcels).` : ""}

Transcribe every parcel in the upcoming tax sale listing below. If this document
does not contain one, set containsParcelList=false.
If the document is truncated mid-list, extract every complete parcel that appears.

---
${chunk}`,
    });

    model = result.model;
    lastNote = result.data.note;
    if (result.data.containsParcelList) anyList = true;

    for (const l of result.data.lots) {
      const key = (l.parcelNumber ?? l.lotNumber ?? l.addressLine ?? JSON.stringify(l)).toString();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        parcelNumber: l.parcelNumber ?? undefined,
        lotNumber: l.lotNumber ?? undefined,
        ownerName: l.ownerName ?? undefined,
        addressLine: l.addressLine ?? undefined,
        city: l.city ?? undefined,
        openingBid: l.openingBid ?? undefined,
        legalDescription: l.legalDescription ?? undefined,
        sourceUrl: context.sourceUrl,
        raw: { extracted: true, model: result.model, chunk: idx },
      });
    }

    // If the first chunk says there is no list, stop spending.
    if (idx === 0 && !result.data.containsParcelList && result.data.lots.length === 0) {
      break;
    }
  }

  return {
    lots: merged,
    containsParcelList: anyList || merged.length > 0,
    note: lastNote,
    model,
  };
}

export { NoProviderAvailableError };
