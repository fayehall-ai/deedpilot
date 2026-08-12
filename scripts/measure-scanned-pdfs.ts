/**
 * How much inventory is locked inside scanned PDFs?
 *
 * Fulton County GA publishes its levy sale list as an 8-page, 4.5 MB image
 * with 128 characters of extractable text — all of it page markers. The
 * pipeline is text-only, so it correctly reports "no parcel list" and the
 * county reads as having no sale. The question this answers is whether that
 * is a Georgia curiosity or a systemic hole worth building OCR for.
 *
 * Method: random sample of counties from the verified source registry. Fetch
 * the landing page, take the best-classified PDF candidate, and measure
 * characters of extractable text per page. A born-digital list runs hundreds
 * to thousands of chars per page; a scan runs near zero.
 *
 * Read-only. Fetches public pages through the same policy layer as ingest.
 */
import "../lib/env";
import { writeFileSync, appendFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { politeFetch, politeFetchBinary, PolicyBlockedError } from "../lib/ingest/fetch";
import { classifiedPdfLinks } from "../lib/ingest/parse";
import { getCounty } from "../lib/atlas";
import registry from "../data/source-registry.json";

const OUT = process.env.OUT ?? "/private/tmp/claude-501/-Users-fayehall/d3da3110-9e8d-4f6a-92c7-ba6016a4c1b8/scratchpad/scanned-pdf-sample.jsonl";
const SAMPLE = Number(process.env.SAMPLE ?? 200);
const CONCURRENCY = 6;
const MAX_PDF_BYTES = 60_000_000;

/** Chars of extractable text per page, below which a PDF is a scan. */
const SCAN_THRESHOLD = 50;
/** Above this it is unambiguously born-digital. Between the two is "thin". */
const TEXT_THRESHOLD = 250;

type Outcome =
  | "scanned_pdf" | "thin_pdf" | "text_pdf"
  | "no_pdf_candidate" | "html_table" | "pdf_failed" | "page_blocked" | "page_failed";

interface Row {
  fips: string; state: string; county: string; population: number | null;
  outcome: Outcome; pdfUrl?: string; pages?: number; chars?: number;
  charsPerPage?: number; bytes?: number; kind?: string; detail?: string;
}

async function measure(entry: { fips: string; state: string; county: string; url: string }): Promise<Row> {
  const population = getCounty(entry.fips)?.population ?? null;
  const base: Row = { fips: entry.fips, state: entry.state, county: entry.county, population, outcome: "page_failed" };

  let html: string;
  try {
    const res = await politeFetch(entry.url, { attempts: 2, timeoutMs: 25_000 });
    if (res.status >= 400) return { ...base, detail: `page http ${res.status}` };
    html = res.body;
  } catch (e) {
    if (e instanceof PolicyBlockedError) return { ...base, outcome: "page_blocked", detail: e.message.slice(0, 90) };
    return { ...base, detail: (e as Error).message.slice(0, 90) };
  }

  const $ = cheerio.load(html);
  const candidates = classifiedPdfLinks($, entry.url)
    .filter((l) => l.kind === "sale_list" || l.kind === "lands_available" || l.kind === "delinquent_list");

  if (!candidates.length) {
    /*
     * No PDF is not automatically a miss: plenty of counties publish the list
     * as an HTML table, which the pipeline already reads. Separating the two
     * keeps "we have no route in" apart from "we already have a route in".
     */
    const bigTable = $("table").toArray().some((t) => $(t).find("tr").length >= 8);
    return { ...base, outcome: bigTable ? "html_table" : "no_pdf_candidate" };
  }

  const top = candidates[0];
  try {
    const bin = await politeFetchBinary(top.url, { attempts: 2, timeoutMs: 45_000 });
    if (bin.status >= 400) return { ...base, outcome: "pdf_failed", pdfUrl: top.url, detail: `http ${bin.status}` };
    if (bin.bytes.length > MAX_PDF_BYTES) {
      return { ...base, outcome: "pdf_failed", pdfUrl: top.url, bytes: bin.bytes.length, detail: "over size cap" };
    }
    const magic = Buffer.from(bin.bytes.slice(0, 5)).toString("latin1");
    if (!magic.startsWith("%PDF")) {
      return { ...base, outcome: "pdf_failed", pdfUrl: top.url, bytes: bin.bytes.length, detail: "not a PDF" };
    }

    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bin.bytes });
    let text = "", pages = 0;
    try {
      const parsed = await parser.getText();
      text = parsed.text ?? "";
      pages = (parsed as { pages?: unknown[] }).pages?.length ?? 0;
    } finally {
      await parser.destroy().catch(() => {});
    }

    /*
     * pdf-parse emits "-- 1 of 8 --" separators even for a page with no text
     * layer at all. Counting them as content would make every scan look like
     * it had a few dozen characters of real text.
     */
    const stripped = text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").replace(/\s+/g, " ").trim();
    if (!pages) pages = Math.max(1, (text.match(/--\s*\d+\s+of\s+\d+\s*--/g) ?? []).length);
    const cpp = stripped.length / Math.max(1, pages);

    const outcome: Outcome = cpp < SCAN_THRESHOLD ? "scanned_pdf" : cpp < TEXT_THRESHOLD ? "thin_pdf" : "text_pdf";
    return {
      ...base, outcome, pdfUrl: top.url, kind: top.kind, pages,
      chars: stripped.length, charsPerPage: Math.round(cpp), bytes: bin.bytes.length,
    };
  } catch (e) {
    if (e instanceof PolicyBlockedError) return { ...base, outcome: "page_blocked", pdfUrl: top.url, detail: e.message.slice(0, 90) };
    return { ...base, outcome: "pdf_failed", pdfUrl: top.url, detail: (e as Error).message.slice(0, 90) };
  }
}

async function main() {
  const all: { fips: string; state: string; county: string; url: string }[] = [];
  for (const rec of Object.values(registry.counties as Record<string, {
    state: string; county: string; sources: { fips: string; url: string; httpStatus?: number }[];
  }>)) {
    const live = rec.sources.find((s) => s.httpStatus === 200) ?? rec.sources[0];
    if (live?.url && live.fips) all.push({ fips: live.fips, state: rec.state, county: rec.county, url: live.url });
  }

  /* Deterministic shuffle — a fixed seed so the sample is reproducible. */
  let seed = 20260812;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pool = all.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, SAMPLE);
  console.log(`universe ${all.length} counties with a source URL; sampling ${sample.length}`);

  writeFileSync(OUT, "");
  let done = 0;
  const queue = sample.slice();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const row = await measure(item);
        appendFileSync(OUT, JSON.stringify(row) + "\n");
        done++;
        if (done % 20 === 0) console.log(`  ${done}/${sample.length}`);
      }
    }),
  );
  console.log(`done — ${done} rows -> ${OUT}`);
  process.exit(0);
}
main();
