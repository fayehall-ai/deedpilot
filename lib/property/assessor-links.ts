/**
 * County property appraiser / assessor deep links.
 *
 * Free partial win when we cannot auto-enrich: one click to the official record.
 * Prefer parcel-specific URLs when the county supports query params; otherwise
 * open the search page with instructions.
 */

import type { AssessorLink } from "./types";
import directory from "@/data/county-directory.json";
import { pickLink, type CountyDirectory, type OfficeKind } from "@/lib/directory/onlinesearches";

/**
 * Crawled county office links, keyed by FIPS.
 *
 * Filled by `npm run crawl:directory`. The hand-authored blocks below stay
 * ahead of it: someone who sat with Brevard's search form and worked out that
 * the clerk's "parcel" is a tax-deed account number rather than a BCPAO APN
 * knows something a directory listing does not.
 */
const DIRECTORY = directory as Record<string, CountyDirectory>;

/** Directory links worth offering, in the order a bidder wants them. */
const OFFERED: { kind: OfficeKind; suffix: string }[] = [
  { kind: "assessor", suffix: "" },
  { kind: "tax_portal", suffix: "" },
  { kind: "delinquent", suffix: "" },
  { kind: "foreclosure", suffix: "" },
  { kind: "recorder", suffix: "" },
  { kind: "gis", suffix: "" },
];

/**
 * County offices from the crawled directory.
 *
 * Marked `searchOnly` without exception: these are office landing pages, not
 * parcel-specific deep links, and telling someone a link will show them their
 * parcel when it will show them a search form is the kind of small lie that
 * makes the rest of the page less believable.
 */
function directoryLinks(fips: string): AssessorLink[] {
  const entry = DIRECTORY[fips];
  if (!entry) return [];
  const out: AssessorLink[] = [];
  for (const { kind } of OFFERED) {
    const hit = pickLink(entry, kind);
    if (hit) out.push({ label: hit.label, url: hit.url, searchOnly: true });
  }
  return out;
}

export function assessorLinks(opts: {
  state: string;
  fips: string;
  countyName: string;
  parcelNumber?: string | null;
}): AssessorLink[] {
  const parcel = (opts.parcelNumber ?? "").trim();
  const encoded = encodeURIComponent(parcel);
  const links: AssessorLink[] = [];

  // --- Florida ------------------------------------------------------------
  if (opts.state === "FL") {
    const fl: Record<string, { label: string; url: (p: string) => string; home: string }> = {
      // Brevard — clerk "parcel" is often a tax-deed account #, not BCPAO APN
      "12009": {
        label: "Brevard Property Appraiser (search account / APN)",
        url: (p) =>
          `https://www.bcpao.us/PropertySearch/#/nav/Search?searchText=${encodeURIComponent(p)}`,
        home: "https://www.bcpao.us/PropertySearch/",
      },
      // Volusia
      "12127": {
        label: "Volusia Property Appraiser",
        url: (p) => `https://vcpa.vcgov.org/search?q=${encodeURIComponent(p)}`,
        home: "https://vcpa.vcgov.org/search",
      },
      // Miami-Dade
      "12086": {
        label: "Miami-Dade Property Appraiser",
        url: (p) =>
          `https://www.miamidade.gov/Apps/PA/PropertySearch/#/?folio=${encodeURIComponent(p)}`,
        home: "https://www.miamidade.gov/pa/property_search.asp",
      },
      // Orange (Orlando)
      "12095": {
        label: "Orange County Property Appraiser",
        url: (p) => `https://www.ocpafl.org/searches/ParcelSearch.aspx?PID=${encodeURIComponent(p)}`,
        home: "https://www.ocpafl.org/searches/ParcelSearch.aspx",
      },
      // Hillsborough (Tampa)
      "12057": {
        label: "Hillsborough Property Appraiser",
        url: (p) =>
          `https://www.hcpafl.org/Search/Parcel-Search?ParcelID=${encodeURIComponent(p)}`,
        home: "https://www.hcpafl.org/",
      },
      // Pinellas
      "12103": {
        label: "Pinellas Property Appraiser",
        url: (p) =>
          `https://www.pcpao.gov/search?searchType=parcel&searchValue=${encodeURIComponent(p)}`,
        home: "https://www.pcpao.gov/",
      },
      // Duval (Jacksonville)
      "12031": {
        label: "Duval Property Appraiser",
        url: (p) =>
          `https://paopropertysearch.coj.net/Basic/Search.aspx?RE=${encodeURIComponent(p)}`,
        home: "https://paopropertysearch.coj.net/",
      },
      // Palm Beach
      "12099": {
        label: "Palm Beach Property Appraiser",
        url: (p) =>
          `https://www.pbcgov.org/papa/Asps/PropertyDetail/PropertyDetail.aspx?parcel=${encodeURIComponent(p)}`,
        home: "https://www.pbcgov.org/papa/",
      },
      // Lee
      "12071": {
        label: "Lee County Property Appraiser",
        url: (p) =>
          `https://www.leepa.org/Search/PropertySearch.aspx?strap=${encodeURIComponent(p)}`,
        home: "https://www.leepa.org/Search/PropertySearch.aspx",
      },
      // Polk
      "12105": {
        label: "Polk Property Appraiser",
        url: (p) => `https://www.polkpa.org/#/parcel/${encodeURIComponent(p)}`,
        home: "https://www.polkpa.org/",
      },
      // Marion (Ocala)
      "12083": {
        label: "Marion Property Appraiser",
        url: (p) =>
          `https://www.pa.marion.fl.us/PropertySearch.aspx?PID=${encodeURIComponent(p)}`,
        home: "https://www.pa.marion.fl.us/",
      },
      // Sumter
      "12119": {
        label: "Sumter Property Appraiser",
        url: (p) =>
          `https://www.sumterpa.com/Search/PropertySearch.aspx?parcel=${encodeURIComponent(p)}`,
        home: "https://www.sumterpa.com/",
      },
      // Columbia (Lake City)
      "12023": {
        label: "Columbia Property Appraiser",
        url: (p) =>
          `https://columbia.floridapa.com/gis/?pin=${encodeURIComponent(p)}`,
        home: "https://search.ccpafl.com/",
      },
      // Okaloosa
      "12091": {
        label: "Okaloosa Property Appraiser",
        url: (p) =>
          `https://qpublic.schneidercorp.com/Application.aspx?AppID=866&LayerID=16384&PageTypeID=2&PageID=7236&KeyValue=${encodeURIComponent(p)}`,
        home: "https://okaloosapa.com/",
      },
      // Calhoun
      "12013": {
        label: "Calhoun Property Appraiser",
        url: (p) =>
          `https://qpublic.schneidercorp.com/Application.aspx?AppID=830&LayerID=15008&PageTypeID=2&PageID=6755&KeyValue=${encodeURIComponent(p)}`,
        home: "https://qpublic.schneidercorp.com/Application.aspx?AppID=830&LayerID=15008&PageTypeID=2&PageID=6755",
      },
      // Levy
      "12075": {
        label: "Levy Property Appraiser",
        url: (p) =>
          `https://qpublic.schneidercorp.com/Application.aspx?AppID=852&LayerID=15888&PageTypeID=2&PageID=7046&KeyValue=${encodeURIComponent(p)}`,
        home: "https://qpublic.schneidercorp.com/Application.aspx?AppID=852&LayerID=15888&PageTypeID=2&PageID=7046",
      },
    };

    const entry = fl[opts.fips];
    if (entry) {
      links.push({
        label: entry.label,
        url: parcel ? entry.url(parcel) : entry.home,
        searchOnly: !parcel,
      });
    } else {
      links.push({
        label: `${opts.countyName} County property search (Google)`,
        url: `https://www.google.com/search?q=${encodeURIComponent(
          `${opts.countyName} County FL property appraiser ${parcel}`.trim(),
        )}`,
        searchOnly: true,
      });
    }
  }

  // --- Michigan (SEV often on sale site; PA still useful) -----------------
  if (opts.state === "MI") {
    links.push({
      label: "Michigan property search (BS&A / county)",
      url: `https://www.google.com/search?q=${encodeURIComponent(
        `${opts.countyName} County MI property search ${parcel}`.trim(),
      )}`,
      searchOnly: true,
    });
  }

  // --- Texas --------------------------------------------------------------
  if (opts.state === "TX") {
    if (opts.fips === "48201") {
      // Harris CAD
      links.push({
        label: "Harris CAD property search",
        url: parcel
          ? `https://hcad.org/property-search/?real=${encoded}`
          : "https://hcad.org/property-search/",
        searchOnly: !parcel,
      });
    } else {
      links.push({
        label: `${opts.countyName} CAD search`,
        url: `https://www.google.com/search?q=${encodeURIComponent(
          `${opts.countyName} County TX CAD ${parcel}`.trim(),
        )}`,
        searchOnly: true,
      });
    }
  }

  // --- Georgia ------------------------------------------------------------
  if (opts.state === "GA") {
    if (opts.fips === "13067") {
      links.push({
        label: "Cobb County property search",
        url: parcel
          ? `https://www.cobbassessor.org/search?q=${encoded}`
          : "https://www.cobbgis.org/",
        searchOnly: true,
      });
    } else {
      links.push({
        label: `${opts.countyName} County assessor`,
        url: `https://www.google.com/search?q=${encodeURIComponent(
          `${opts.countyName} County GA property assessor ${parcel}`.trim(),
        )}`,
        searchOnly: true,
      });
    }
  }

  // --- South Carolina -----------------------------------------------------
  if (opts.state === "SC") {
    if (opts.fips === "45045") {
      links.push({
        label: "Greenville County GIS / real property",
        url: parcel
          ? `https://www.gcgis.org/apps/greenvillejs/?find=${encoded}`
          : "https://www.gcgis.org/",
        searchOnly: true,
      });
      links.push({
        label: "Greenville real property search",
        url: "https://www.greenvillecounty.org/appsas400/RealProperty/",
        searchOnly: true,
      });
    } else {
      links.push({
        label: `${opts.countyName} County assessor`,
        url: `https://www.google.com/search?q=${encodeURIComponent(
          `${opts.countyName} County SC property assessor ${parcel}`.trim(),
        )}`,
        searchOnly: true,
      });
    }
  }

  /*
   * Crawled county offices, after anything hand-authored for this county and
   * before the Google fallback. Deduped by URL so a county that is both
   * researched and crawled does not list its assessor twice.
   */
  const have = new Set(links.map((l) => l.url));
  for (const l of directoryLinks(opts.fips)) {
    if (!have.has(l.url)) {
      links.push(l);
      have.add(l.url);
    }
  }

  // Always useful
  if (parcel) {
    links.push({
      label: "Google Maps (parcel / address search)",
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${parcel} ${opts.countyName} County ${opts.state}`,
      )}`,
    });
  }

  return links;
}
