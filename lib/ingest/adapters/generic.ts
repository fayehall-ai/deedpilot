/**
 * Generic county adapter — one parser for every county we have a source for.
 *
 * The three bespoke adapters cover 139 counties. Nationally 2,169 counties have
 * a crawl window open and nothing that can read them, and writing 2,169 adapters
 * is not a plan. What made that seem necessary was that each adapter hardcoded
 * three things it had no other way to know:
 *
 *   - where the county publishes  → now the Prospector's source registry
 *   - when it sells               → now `resolveSaleSchedule` in the calendar
 *   - what instrument it sells    → now `resolveCountyRule` in the atlas
 *
 * With those three supplied, what remains is parsing, and parsing was never
 * county-specific: a table of parcels looks the same in Ohio as in Georgia. So
 * this generalises the Georgia adapter — HTML tables in code, PDF booklets by
 * LLM transcription — and reads its registry from disk instead of a literal.
 *
 * It is deliberately conservative about the difference between "this county has
 * no sale" and "we could not read it". The first is legitimate and common; the
 * second is a bug that must not be recorded as empty inventory, because a county
 * that silently reports zero parcels looks identical to one that is genuinely
 * quiet, and nobody goes looking.
 */

import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import {
  findCountyByName,
  getCounty,
  resolveCountyRule,
  toSaleType,
} from "../../atlas";
import { nextSaleWindows } from "../../atlas/calendar";
import { CHOSEN_ORIGINS, countySourcesVersion, mergeCountySources } from "../county-sources";
import { observedSale } from "../observed-sale";
import type { SourceRegistry } from "../../prospector/types";
import { extractLots, extractLotsFromImages, NoProviderAvailableError } from "../extract";
import { configuredProviders } from "../../ai/providers";
import { renderPdfFromUrl, SCAN_TEXT_PER_PAGE, textDensity } from "../render";
import { politeFetch } from "../fetch";
import {
  classifiedPdfLinks,
  documentLinks,
  htmlToText,
  listPageLinks,
  parseDelimitedText,
  parseHtmlTable,
  parseStructuredPdfText,
  pdfToText,
} from "../parse";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  ListingKind,
  SourceAdapter,
} from "../types";

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Order a page's documents so this sale's own list comes first.
 *
 * A county that posts next month's list and the month after's side by side —
 * Clayton's "OCTOBER TAX SALE LISTING" beside "NOVEMBER …" — handed whichever
 * came first on the page to the sale being crawled, so November's parcels could
 * land on October's sale. A sale list whose name carries this sale's month moves
 * ahead of the others; a list naming a different month moves behind them.
 * Everything else keeps the order the page gave it.
 */
export function forThisSale<T extends { url: string; kind: ListingKind }>(docs: T[], saleDate: string): T[] {
  const month = MONTH_NAMES[Number(saleDate.slice(5, 7)) - 1];
  const name = (d: T) => decodeURIComponent(d.url.split("/").pop() ?? "").toLowerCase();
  const rank = (d: T) => {
    if (d.kind !== "sale_list") return 1;
    const named = MONTH_NAMES.find((m) => new RegExp(`\\b${m}\\b`).test(name(d)));
    return !named ? 1 : named === month ? 0 : 2;
  };
  return docs.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
}

/** Where the Prospector writes its registry. */
const DEFAULT_REGISTRY_PATH = "data/source-registry.json";

let registryCache: SourceRegistry | null = null;
/**
 * Distinguishes "no registry has been loaded yet" from "a caller deliberately
 * supplied none". Without it, clearing the cache falls through to a disk read,
 * so a test asserting the no-registry path silently passes or fails depending
 * on whether a registry file happens to exist in the working directory.
 */
let registryOverridden = false;

/** The file's registry with `county_sources` laid over it, rebuilt when those change. */
let mergedCache: { version: number; base: SourceRegistry; merged: SourceRegistry } | null = null;

export function loadRegistry(path = DEFAULT_REGISTRY_PATH): SourceRegistry | null {
  if (registryOverridden) return registryCache;
  if (!registryCache) {
    try {
      registryCache = JSON.parse(readFileSync(path, "utf8")) as SourceRegistry;
    } catch {
      return null;
    }
  }
  const version = countySourcesVersion();
  if (mergedCache?.version !== version || mergedCache.base !== registryCache) {
    mergedCache = { version, base: registryCache, merged: mergeCountySources(registryCache) };
  }
  return mergedCache.merged;
}

/** Test seam — supply a registry (or an explicit absence) without touching disk. */
export function __setRegistry(r: SourceRegistry | null) {
  registryCache = r;
  registryOverridden = true;
}

/** Drop the override and go back to reading from disk. */
export function __resetRegistry() {
  registryCache = null;
  registryOverridden = false;
}

interface GenericConfig {
  url: string;
  countyName: string;
  state: string;
}

/** Enough money amounts or parcel-shaped numbers that a page is worth reading as a list. */
export function looksLikeList(text: string): boolean {
  const money = (text.match(/\$\s?\d[\d,]*\.\d{2}/g) ?? []).length;
  const parcels = (text.match(/\b[A-Z]?\d{1,5}[-. ]\d{1,5}[-. ]?[A-Z0-9]{0,6}\b/g) ?? []).length;
  return money >= 5 || parcels >= 25;
}

/**
 * Which of a county's sources the crawler reads.
 *
 * A source somebody chose on purpose comes first (see `CHOSEN_ORIGINS`); it is
 * policy-checked when recorded. After that, a government listing page. That
 * precedence is the whole answer to the RealAuction policy block and must not
 * be quietly inverted here.
 */
export function pickSource<S extends { signals: string[]; isGovernment: boolean; kind: string }>(sources: S[]): S | undefined {
  return (
    sources.find((s) => s.signals.some((g) => CHOSEN_ORIGINS.has(g))) ??
    sources.find((s) => s.isGovernment && s.kind === "listing") ??
    sources.find((s) => s.isGovernment) ??
    sources.find((s) => s.kind === "listing") ??
    sources[0]
  );
}

export const genericAdapter: SourceAdapter = {
  name: "generic-county",
  platform: "county_site",
  description:
    "Registry-driven county sale listings. Source from the Prospector, dates from the sale calendar, " +
    "sale type from the rules atlas; HTML tables parsed in code and PDF booklets transcribed by LLM.",

  /**
   * Every county in the registry that has a usable source.
   *
   * Overlap with the bespoke adapters is fine and not filtered here: this
   * adapter is registered last, and `buildAdapterIndex` gives the first adapter
   * to claim a county precedence. A hand-written parser for a known source
   * beats a general one, so Texas and Michigan keep theirs.
   */
  async discoverCounties(): Promise<CountyBinding[]> {
    const registry = loadRegistry();
    /*
     * A missing registry is a failure, not an empty result.
     *
     * Returning `[]` here made the deployed crawler silent: with the file
     * absent from the function bundle, every job finished in twelve
     * milliseconds reporting `counties: 0` and no error, so the queue drained
     * and nothing was fetched. An adapter whose entire binding source cannot be
     * read has not found zero counties, it has failed to look — and the queue
     * records a failure where it records nothing about a zero.
     *
     * `registryOverridden` is the exception: a caller that deliberately
     * supplied no registry means it, and the tests depend on that path.
     */
    if (!registry) {
      if (registryOverridden) return [];
      throw new Error(
        `[generic-county] cannot read ${DEFAULT_REGISTRY_PATH} from ${process.cwd()} — ` +
          `the Prospector's registry is missing from this deployment. See ` +
          `outputFileTracingIncludes in next.config.ts.`,
      );
    }

    const bindings: CountyBinding[] = [];

    for (const [fips, entry] of Object.entries(registry.counties)) {
      if (entry.isGap) continue;
      const county = getCounty(fips) ?? findCountyByName(entry.state, entry.county);
      if (!county) continue;

      const source = pickSource(entry.sources);
      if (!source) continue;

      bindings.push({
        countyFips: county.fips,
        config: {
          url: source.url,
          countyName: county.name,
          state: county.state,
        } satisfies GenericConfig,
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const { url, countyName, state } = binding.config as unknown as GenericConfig;

    /*
     * A sale the county has actually announced outranks the calendar's guess.
     *
     * The calendar projects a date from the state's typical schedule; an
     * imported or Auction Scout sale is a date somebody read off the county's
     * own notice. Crawling at the projected date put the parcels on a second
     * row beside the announced sale, a day or a week away from it, where the
     * fold that merges the two could never pair them. The projection is the
     * fallback for counties nobody has announced anything for, so an
     * unresearched county is still crawled rather than skipped.
     */
    const observed = await observedSale(binding.countyFips);
    const [projected] = observed ? [] : nextSaleWindows(binding.countyFips, { count: 1 });
    const window = observed
      ? { saleDate: observed.saleDate, estimated: false, confidence: "announced" as const }
      : projected;
    if (!window) return [];

    // Sale type comes from the announced sale, else the county's researched
    // rule, falling back to the state default. Guessing "Tax Deed" nationally
    // would be wrong in every lien state and feed the wrong redemption model.
    const rule = resolveCountyRule(binding.countyFips);
    const saleType = observed?.saleType ?? (rule ? toSaleType(rule.type) : "Tax Deed");

    return [
      {
        countyFips: binding.countyFips,
        platform: "county_site",
        saleType,
        externalId: `${binding.countyFips}|${window.saleDate}`,
        saleDate: window.saleDate,
        // The calendar projects; it does not observe. `listLots` upgrades this
        // only if the fetched document names its own sale date.
        saleDateConfirmed: window.estimated === false,
        // Set once we see what the county actually publishes.
        listingKind: "unknown",
        title: `${countyName}, ${state} tax sale`,
        status: "scheduled",
        sourceUrl: url,
        raw: {
          registryUrl: url,
          scheduleConfidence: window.confidence,
          saleDateEstimated: window.estimated,
          saleTypeInherited: rule?.isStateDefault ?? true,
        },
      },
    ];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const county = getCounty(auction.countyFips);
    const context = {
      countyName: county?.name ?? auction.countyFips,
      state: county?.state ?? "",
      sourceUrl: auction.sourceUrl,
    };

    /**
     * Read one document, wherever it was found.
     *
     * Extracted so the deeper hops can use it: the list is as often two clicks
     * in as it is on the page the registry points at, and a reader that only
     * works at depth zero finds the landing page and calls the county empty.
     */
    /*
     * Sale lists this run could not read, with why.
     *
     * "Could not read the list" and "the county published no list" both used to
     * end in an empty result, and the first was recorded as the second: while
     * PDF parsing was broken in production, two hundred counties' crawls ran
     * "ok, 0 lots", which reads as a county with nothing for sale and is not
     * looked at again for a week. A list that exists and failed to read now
     * fails the run instead, so it is retried and shows on the console.
     */
    const unread: string[] = [];

    const lotsFromDocument = async (
      doc: string,
      kind: ListingKind,
    ): Promise<DiscoveredLot[] | null> => {
      let text: string;
      try {
        text = await pdfToText(doc);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[generic-county] ${doc}: ${why}`);
        if (kind === "sale_list") unread.push(`${doc} (${why.slice(0, 120)})`);
        return null;
      }
      // Free path: structured sealed-bid / list PDFs (no LLM, no credits).
      /*
       * Trusted only when it accounts for a fair share of the document. It is
       * a set of layout patterns, and a layout it half-knows yields a few
       * rows: Los Angeles County's 2026B auction book lists 1,253 parcels and
       * the structured parse took 8 of them, which then stood as the sale.
       */
      const ids = new Set(text.match(/\b[A-Z]?\d{1,5}[-.]\d{1,5}[-.]\d{1,6}\b/g) ?? []);
      let structured = parseStructuredPdfText(text, doc);
      if (structured?.length && structured.length < ids.size * 0.25) {
        console.log(
          `[generic-county] ${doc}: structured parse found ${structured.length} of ~${ids.size} parcel numbers — reading it another way`,
        );
        structured = null;
      }
      if (structured?.length) {
        auction.listingKind = kind;
        console.log(
          `[generic-county] ${doc}: structured PDF parse → ${structured.length} lot(s) [${kind}]`,
        );
        return structured;
      }
      /* A spreadsheet, CSV or HTML list: a table with headers, read without the model. */
      const tabular = parseDelimitedText(text, doc);
      if (tabular?.length) {
        auction.listingKind = kind;
        console.log(`[generic-county] ${doc}: table parse → ${tabular.length} lot(s) [${kind}]`);
        return tabular;
      }
      try {
        /*
         * A scan has no text layer, and read as text it is an empty page that
         * the model rightly says holds no list — so a scanned sale list was
         * recorded as a county with no sale. Georgia learned this on Fulton's
         * levy list and renders scans for the vision model; roughly one county
         * list in thirteen is a scan, and the generic crawler now does the same.
         */
        const pages = Math.max(1, (text.match(/--\s*\d+\s+of\s+\d+\s*--/g) ?? []).length);
        if (textDensity(text, pages) < SCAN_TEXT_PER_PAGE && kind === "sale_list") {
          console.log(`[generic-county] ${doc}: no text layer over ${pages} page(s) — rendering for vision`);
          const rendered = await renderPdfFromUrl(doc, { maxPages: 20, scale: 2 });
          const seen = await extractLotsFromImages(rendered, { ...context, sourceUrl: doc });
          if (seen.containsParcelList && seen.lots.length) {
            auction.listingKind = kind;
            return seen.lots;
          }
          return null;
        }
        const result = await extractLots(text, { ...context, sourceUrl: doc });
        if (result.containsParcelList && result.lots.length) {
          auction.listingKind = kind;
          return result.lots;
        }
      } catch (e) {
        if (e instanceof NoProviderAvailableError && !configuredProviders().length) {
          // "We couldn't look" is not "there is nothing here". Returning []
          // would mark the county as having no inventory, which reads as a
          // fact and stops anyone investigating.
          throw new Error(
            `${doc} needs LLM extraction — ${e.message} — ` +
              `${context.countyName} left unresolved rather than recorded as empty`,
          );
        }
        /*
         * The model failed on this document: it timed out, or every provider
         * refused it. The text was there, so this is a list not read, not a
         * county with none. It used to be thrown, and a document one or two
         * clicks in is read inside a catch that logged the error and moved on,
         * so the run ended "ok, 0 lots". Recorded here, at every depth, the
         * other documents are still tried and the run fails only if none of
         * them has the list.
         */
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[generic-county] ${doc}: ${why}`);
        unread.push(`${doc} (${why.slice(0, 120)})`);
      }
      return null;
    };

    /*
     * The source is the list itself. A county's list is often a bare PDF — an
     * operator or the Auction Scout pastes exactly that — and this used to load
     * its bytes as HTML, find no table and no links in them, and report the
     * county empty.
     */
    const unreadIsFailure = () => {
      if (unread.length) throw new Error(`could not read the sale list: ${unread.join("; ")}`);
    };

    if (/\.(pdf|xlsx|xls|csv|docx|doc)(\?|#|$)/i.test(auction.sourceUrl)) {
      const lots = await lotsFromDocument(auction.sourceUrl, "sale_list");
      unreadIsFailure();
      return lots ?? [];
    }

    const res = await politeFetch(auction.sourceUrl);
    if (/application\/pdf|spreadsheet|officedocument|msword|ms-excel|text\/csv/i.test(res.contentType)) {
      const lots = await lotsFromDocument(auction.sourceUrl, "sale_list");
      unreadIsFailure();
      return lots ?? [];
    }
    const $ = cheerio.load(res.body);

    // 1. Free and exact, when the county publishes a real table.
    const fromTable = parseHtmlTable($, auction.sourceUrl);
    if (fromTable?.length) return fromTable;

    // 2. Documents on the page itself, decoys filtered and sale lists first —
    //    and among sale lists, the one naming this sale's month.
    const onPage = forThisSale(documentLinks($, auction.sourceUrl), auction.saleDate).slice(0, 4);
    for (const [i, { url: doc, kind }] of onPage.entries()) {
      const lots = await lotsFromDocument(doc, kind);
      if (!lots?.length) continue;
      if (kind !== "sale_list") return lots;
      /*
       * One sale, more than one list. Florence County, South Carolina posts
       * its real property (about 1,500 parcels) and its mobile homes (445) as
       * two PDFs, and stopping at the first list that read kept the smaller
       * one. The other sale lists on the page are read too. One that mostly
       * repeats parcels already found is an older version of the same list,
       * as Fayette's nine "Upset 2026" updates are, and reading stops there.
       */
      const key = (l: DiscoveredLot) => (l.parcelNumber ?? l.addressLine ?? l.ownerName ?? "").replace(/\s+/g, "").toLowerCase();
      const merged = [...lots];
      const seen = new Set(lots.map(key));
      for (const companion of onPage.slice(i + 1).filter((c) => c.kind === "sale_list").slice(0, 3)) {
        const more = await lotsFromDocument(companion.url, companion.kind);
        if (!more?.length) continue;
        const repeated = more.filter((l) => seen.has(key(l))).length;
        if (repeated / more.length > 0.2) break;
        for (const l of more) {
          if (seen.has(key(l))) continue;
          seen.add(key(l));
          merged.push(l);
        }
      }
      return merged;
    }

    /*
     * 2b. The page is the list. A newspaper's legal notice or a county notice
     *     page prints its parcels as text, not as a table and not in a linked
     *     file, and nothing above reads page text. Appling, Bryan and Upson
     *     counties in Georgia publish that way. Only a page that looks like a
     *     list goes to the model: enough dollar amounts or parcel numbers
     *     that it is not a department's landing page.
     */
    const pageText = htmlToText(res.body);
    if (looksLikeList(pageText)) {
      const tabular = parseDelimitedText(pageText, auction.sourceUrl);
      if (tabular?.length) return tabular;
      const result = await extractLots(pageText, context);
      if (result.containsParcelList && result.lots.length) {
        auction.listingKind = "sale_list";
        return result.lots;
      }
    }

    /*
     * 3. Dig. Many landing pages carry no parcels themselves and no document
     *    either — the list is one or two clicks further in, behind "2026 Tax
     *    Sale" or "Current Listings".
     *
     *    The hop used to try only HTML tables on the linked page, which meant
     *    a county whose landing page links to a sale page that links to a PDF
     *    was unreachable — and that is the ordinary shape, not an exotic one.
     *    Each hop now tries the table AND the documents, and there are two
     *    hops rather than one.
     *
     *    Depth is capped at two deliberately. A third hop reaches the whole
     *    county website, where "Sheriff's Sales" and "Surplus Property" live,
     *    and the cost of opening the wrong list is not a wasted request — it
     *    is a delinquent roll in the database wearing a sale's name.
     */
    const visited = new Set<string>([auction.sourceUrl]);
    let frontier = listPageLinks($, auction.sourceUrl).slice(0, 3);

    for (let hop = 0; hop < 2 && frontier.length; hop++) {
      const next: string[] = [];
      for (const link of frontier.slice(0, 3)) {
        if (visited.has(link)) continue;
        visited.add(link);
        try {
          const sub = await politeFetch(link);
          const $sub = cheerio.load(sub.body);

          const subTable = parseHtmlTable($sub, link);
          if (subTable?.length) return subTable;

          for (const { url: doc, kind } of forThisSale(documentLinks($sub, link), auction.saleDate).slice(0, 3)) {
            if (visited.has(doc)) continue;
            visited.add(doc);
            try {
              const lots = await lotsFromDocument(doc, kind);
              if (lots?.length) return lots;
            } catch (e) {
              console.warn(`[generic-county] ${doc}: ${e instanceof Error ? e.message : e}`);
            }
          }

          if (hop === 0) next.push(...listPageLinks($sub, link).slice(0, 3));
        } catch (e) {
          console.warn(`[generic-county] ${link}: ${e instanceof Error ? e.message : e}`);
        }
      }
      frontier = next;
    }

    // 4. Nothing published. Legitimate and common — not every county holds a
    //    sale every window, and in many the binding notice is a newspaper legal
    //    ad rather than the website. Unless a sale list was there and would not
    //    read, which is a failure to report, not an empty county.
    unreadIsFailure();
    return [];
  },
};
