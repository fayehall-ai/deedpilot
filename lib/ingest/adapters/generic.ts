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
  listPageLinks,
  parseHtmlTable,
  parseStructuredPdfText,
  pdfToText,
} from "../parse";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
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
    if (!registry) return [];

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

    // 2. Linked PDFs, decoys already filtered and sale lists ranked first.
    for (const { url: pdf, kind } of classifiedPdfLinks($, auction.sourceUrl).slice(0, 3)) {
      let text: string;
      try {
        text = await pdfToText(pdf);
      } catch (e) {
        console.warn(`[generic-county] ${pdf}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      // Free path: structured sealed-bid / list PDFs (no LLM, no credits).
      const structured = parseStructuredPdfText(text, pdf);
      if (structured?.length) {
        auction.listingKind = kind;
        console.log(
          `[generic-county] ${pdf}: structured PDF parse → ${structured.length} lot(s) [${kind}]`,
        );
        return structured;
      }
      try {
        const result = await extractLots(text, { ...context, sourceUrl: pdf });
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
            `${pdf} needs LLM extraction — ${e.message} — ` +
              `${context.countyName} left unresolved rather than recorded as empty`,
          );
        }
        throw e;
      }
    }

    // 3. One hop to a linked "current tax sale list" page. Many landing pages
    //    carry no parcels themselves, and following one link finds the list
    //    without a hand-written rule per jurisdiction.
    for (const link of listPageLinks($, auction.sourceUrl).slice(0, 2)) {
      try {
        const sub = await politeFetch(link);
        const $sub = cheerio.load(sub.body);
        const subTable = parseHtmlTable($sub, link);
        if (subTable?.length) return subTable;
      } catch (e) {
        console.warn(`[generic-county] ${link}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 4. Nothing published. Legitimate and common — not every county holds a
    //    sale every window, and in many the binding notice is a newspaper legal
    //    ad rather than the website.
    return [];
  },
};
