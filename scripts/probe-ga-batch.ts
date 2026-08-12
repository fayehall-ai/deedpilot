/**
 * Find and verify Georgia tax-sale pages for the AMSTax September/October list.
 *
 * Georgia counties do not share a platform, but they do share a handful of
 * vendor URL shapes — `<county>countytax.com`, `<county>tax.com`,
 * `<county>countypay.com`, `<county>gatax.org` — with the sale page at
 * `/tax-sales.html` or `/property.html`. This walks those shapes per county and
 * reports only what it could actually parse: a future first-Tuesday date plus a
 * readable parcel list. Anything else is a lead, not a registry entry.
 */
import "../lib/env";
import * as cheerio from "cheerio";
import { politeFetch, PolicyBlockedError } from "../lib/ingest/fetch";
import { classifiedPdfLinks, parseHtmlTable } from "../lib/ingest/parse";
import { parseSaleDates, NO_SALE_MARKER } from "../lib/ingest/adapters/georgia";

const TODAY = new Date().toISOString().slice(0, 10);
/* AMSTax's own September 1 and October 6 client lists, counties only. */
const COUNTIES = [
  "Elbert", "Jackson", "Jones", "Oconee", "Schley", "Telfair", "Towns", "Warren", "Wayne",
  "Burke", "Catoosa", "Cook", "Dawson", "Marion", "Oglethorpe", "Treutlen", "Upson",
  "Washington", "Whitfield",
];

function hosts(name: string): string[] {
  const s = name.toLowerCase().replace(/[^a-z]/g, "");
  return [
    `${s}countytax.com`, `www.${s}countytax.com`, `${s}tax.com`, `www.${s}tax.com`,
    `${s}countypay.com`, `www.${s}countypay.com`, `tax.${s}countypay.com`,
    `${s}gatax.org`, `www.${s}gatax.org`, `${s}countytax.org`, `${s}taxcommissioner.com`,
  ];
}
const PATHS = ["/tax-sales.html", "/property.html", "/", "/tax-sales/", "/taxsales"];

interface Hit { county: string; url: string; upcoming: string[]; parcels: number; pdf?: string; noSale: boolean }

async function tryUrl(county: string, url: string): Promise<Hit | null> {
  let r;
  try {
    r = await politeFetch(url, { attempts: 1, timeoutMs: 15_000 });
  } catch { return null; }
  if (r.status >= 400 || r.body.length < 2000) return null;

  const $ = cheerio.load(r.body);
  const text = r.body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  if (!/tax sale|levy|delinquent/i.test(text)) return null;

  const pdfs = classifiedPdfLinks($, url);
  const names = pdfs.map((p) => decodeURIComponent(p.url.split("/").pop() ?? ""));
  const { upcoming } = parseSaleDates(text, names, TODAY);
  const rows = parseHtmlTable($, url);
  const saleList = pdfs.find((p) => p.kind === "sale_list");
  return {
    county, url, upcoming, parcels: rows?.length ?? 0,
    pdf: saleList?.url, noSale: NO_SALE_MARKER.test(text),
  };
}

async function main() {
  const found: Hit[] = [];
  for (const c of COUNTIES) {
    let best: Hit | null = null;
    outer: for (const h of hosts(c)) {
      for (const p of PATHS) {
        const hit = await tryUrl(c, `https://${h}${p}`);
        if (!hit) continue;
        if (!best || hit.upcoming.length > best.upcoming.length || hit.parcels > best.parcels) best = hit;
        if (hit.upcoming.length && (hit.parcels > 5 || hit.pdf)) break outer;
      }
    }
    if (best) {
      found.push(best);
      const verdict = best.upcoming.length && (best.parcels > 5 || best.pdf) ? "ADD      "
        : best.upcoming.length ? "date only" : best.parcels > 5 || best.pdf ? "list only" : "found    ";
      console.log(`${verdict} ${c.padEnd(11)} ${best.url.slice(0, 62)}`);
      console.log(`          dates=${best.upcoming.join(",") || "—"} parcels=${best.parcels} pdf=${best.pdf?.split("/").pop()?.slice(0, 40) ?? "—"}${best.noSale ? " NO-SALE-MARKER" : ""}`);
    } else {
      console.log(`no site   ${c}`);
    }
  }
  console.log(`\n=== ${found.length}/${COUNTIES.length} counties located`);
  process.exit(0);
}
main();
