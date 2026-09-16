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
import type { SourceRegistry } from "../../prospector/types";
import { extractLots, NoProviderAvailableError } from "../extract";
import { politeFetch } from "../fetch";
import {
  classifiedPdfLinks,
  documentLinks,
  listPageLinks,
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

export function loadRegistry(path = DEFAULT_REGISTRY_PATH): SourceRegistry | null {
  if (registryOverridden) return registryCache;
  if (registryCache) return registryCache;
  try {
    registryCache = JSON.parse(readFileSync(path, "utf8")) as SourceRegistry;
    return registryCache;
  } catch {
    return null;
  }
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

      // Prefer a government listing page; that precedence is the whole answer
      // to the RealAuction policy block and must not be quietly inverted here.
      const source =
        entry.sources.find((s) => s.isGovernment && s.kind === "listing") ??
        entry.sources.find((s) => s.isGovernment) ??
        entry.sources.find((s) => s.kind === "listing") ??
        entry.sources[0];
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

    // Dates come from the calendar rather than a per-adapter rule. An
    // unresearched county still gets a sweep window, so it is crawled rather
    // than skipped — the schedule's `confidence` records how much to trust it.
    const [window] = nextSaleWindows(binding.countyFips, { count: 1 });
    if (!window) return [];

    // Sale type comes from the county's researched rule, falling back to the
    // state default. Guessing "Tax Deed" nationally would be wrong in every
    // lien state and would feed the wrong redemption model downstream.
    const rule = resolveCountyRule(binding.countyFips);
    const saleType = rule ? toSaleType(rule.type) : "Tax Deed";

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
    const res = await politeFetch(auction.sourceUrl);
    const $ = cheerio.load(res.body);
    const county = getCounty(auction.countyFips);
    const context = {
      countyName: county?.name ?? auction.countyFips,
      state: county?.state ?? "",
      sourceUrl: auction.sourceUrl,
    };

    // 1. Free and exact, when the county publishes a real table.
    const fromTable = parseHtmlTable($, auction.sourceUrl);
    if (fromTable?.length) return fromTable;

    /**
     * Read one document, wherever it was found.
     *
     * Extracted so the deeper hops can use it: the list is as often two clicks
     * in as it is on the page the registry points at, and a reader that only
     * works at depth zero finds the landing page and calls the county empty.
     */
    const lotsFromDocument = async (
      doc: string,
      kind: ListingKind,
    ): Promise<DiscoveredLot[] | null> => {
      let text: string;
      try {
        text = await pdfToText(doc);
      } catch (e) {
        console.warn(`[generic-county] ${doc}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
      // Free path: structured sealed-bid / list PDFs (no LLM, no credits).
      const structured = parseStructuredPdfText(text, doc);
      if (structured?.length) {
        auction.listingKind = kind;
        console.log(
          `[generic-county] ${doc}: structured PDF parse → ${structured.length} lot(s) [${kind}]`,
        );
        return structured;
      }
      try {
        const result = await extractLots(text, { ...context, sourceUrl: doc });
        if (result.containsParcelList && result.lots.length) {
          auction.listingKind = kind;
          return result.lots;
        }
      } catch (e) {
        if (e instanceof NoProviderAvailableError) {
          // "We couldn't look" is not "there is nothing here". Returning []
          // would mark the county as having no inventory, which reads as a
          // fact and stops anyone investigating.
          throw new Error(
            `${doc} needs LLM extraction — ${e.message} — ` +
              `${context.countyName} left unresolved rather than recorded as empty`,
          );
        }
        throw e;
      }
      return null;
    };

    // 2. Documents on the page itself, decoys filtered and sale lists first.
    for (const { url: doc, kind } of documentLinks($, auction.sourceUrl).slice(0, 4)) {
      const lots = await lotsFromDocument(doc, kind);
      if (lots?.length) return lots;
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

          for (const { url: doc, kind } of documentLinks($sub, link).slice(0, 3)) {
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
    //    ad rather than the website.
    return [];
  },
};
