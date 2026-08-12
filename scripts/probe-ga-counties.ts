/**
 * Probe Georgia county tax-sale pages before adding them to the registry.
 *
 * GA_COUNTIES is meant to be verified rather than aspirational — a county that
 * links only to a procedure booklet is worse than an absent one, because it
 * reports as covered and yields nothing. This checks the two things that
 * decide it: does the page name a real sale date, and is there a parcel list
 * behind it.
 *
 * Read-only. One hop of link-following, because several crawled URLs are the
 * office landing page rather than the tax-sale page itself.
 */
import "../lib/env";
import * as cheerio from "cheerio";
import { politeFetch, PolicyBlockedError } from "../lib/ingest/fetch";
import { classifiedPdfLinks } from "../lib/ingest/parse";
import { nextFirstTuesday } from "../lib/ingest/adapters/georgia";

const SEEDS: [string, string][] = [
  ["Bibb", "https://www.maconbibbtax.us/property.html"],
  ["Camden", "https://www.camdencountyga.gov/87/Tax-Sale"],
  ["Carroll", "https://carrollcountygatax.com/tax-sales-2/"],
  ["Catoosa", "https://www.catoosataxes.com/"],
  ["Cherokee", "https://www.cherokeecountytax.com/property.html"],
  ["Columbia", "https://www.columbiacountyga.gov/186/Delinquent-Taxes"],
  ["DeKalb", "https://dekalbtaxga.gov/"],
  ["Douglas", "https://www.douglastax.org/property-tax-sales"],
  ["Hall", "https://hallcountytax.org/property/tax-sale/"],
  ["Muscogee", "https://columbusga.gov/taxcommissioner/Delinquent-Tax"],
  ["Newton", "https://newtoncountytax.com/property_tax/tax-sales/"],
  ["Richmond", "https://arctax.com/property/tax-sale-lists/"],
  ["Rockdale", "https://rockdaletaxoffice.org/property-tax"],
  ["Walker", "https://walkercountytax.com/"],
  ["Walton", "https://tax.waltoncountypay.com/property.html"],
  // Re-verify the seven already in the registry.
  ["Cobb*", "https://www.cobbtax.gov/property/tax_sale/index.php"],
  ["Forsyth*", "https://forsythcountytax.com/tax-sales-excess-funds/"],
  ["Barrow*", "https://www.barrowgatax.org/tax-sales.html"],
  ["Chatham*", "https://tax.chathamcountyga.gov/TaxSaleList"],
  ["Clarke*", "https://www.accgov.com/1719/Tax-Sales"],
  ["Fulton*", "https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/sheriff/tax-sales"],
  ["Gwinnett*", "https://www.gwinnetttaxcommissioner.com/property-tax/delinquent_tax/tax-liens-tax-sales"],
];

const NAV_TO_SALE = /tax\s*sale|levy\s*sale|delinquent|sheriff'?s?\s*sale|excess\s*funds/i;
const DATE_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)\b/gi;
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

/** Georgia sells on the first Tuesday. A named date that is not one is a deadline or a past event, not the sale. */
function isFirstTuesday(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.getUTCDay() === 2 && d.getUTCDate() <= 7;
}

function namedDates(text: string): { all: string[]; sales: string[] } {
  const all: string[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    const iso = `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
    if (!all.includes(iso)) all.push(iso);
  }
  const today = new Date().toISOString().slice(0, 10);
  return { all: all.sort(), sales: all.filter((d) => isFirstTuesday(d) && d >= today).sort() };
}

async function probe(name: string, seed: string) {
  const visit = async (u: string) => {
    const r = await politeFetch(u, { attempts: 2, timeoutMs: 25_000 });
    const $ = cheerio.load(r.body);
    const text = r.body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    return { r, $, text };
  };

  try {
    let { r, $, text } = await visit(seed);
    let finalUrl = r.url || seed;

    /* Landing page with no sale vocabulary — follow one hop to the sale page. */
    if (!/tax sale|levy sale|delinquent/i.test(text.slice(0, 4000))) {
      const hop = $("a[href]").toArray()
        .map((a) => ({ t: $(a).text().replace(/\s+/g, " ").trim(), h: $(a).attr("href")! }))
        .find((l) => NAV_TO_SALE.test(l.t) && !/excess/i.test(l.t));
      if (hop) {
        try {
          const next = new URL(hop.h, finalUrl).href;
          ({ r, $, text } = await visit(next));
          finalUrl = next;
        } catch { /* malformed href — keep the landing page */ }
      }
    }

    const { all, sales } = namedDates(text);
    const pdfs = classifiedPdfLinks($, finalUrl);
    const saleListPdf = pdfs.find((p) => p.kind === "sale_list");
    const tableRows = Math.max(0, ...$("table").toArray().map((t) => $(t).find("tr").length));
    const noSale = /no (?:tax |levy )?sales?\b|none scheduled|not scheduled|no properties|no upcoming/i.exec(text);

    const verdict = sales.length && (saleListPdf || tableRows >= 8) ? "ADD"
      : sales.length ? "date only"
      : saleListPdf || tableRows >= 8 ? "list only"
      : "skip";

    console.log(`\n${verdict.padEnd(9)} ${name}`);
    console.log(`  url        ${finalUrl.slice(0, 96)}`);
    console.log(`  sale dates ${sales.length ? sales.join(", ") : `none (${all.length} dates on page, none a future first-Tuesday)`}`);
    console.log(`  sale pdf   ${saleListPdf ? saleListPdf.url.split("/").pop()!.slice(0, 62) : "—"}`);
    console.log(`  pdf kinds  ${pdfs.slice(0, 4).map((p) => p.kind).join(", ") || "—"}   max table rows ${tableRows}`);
    if (noSale) console.log(`  page says  "${noSale[0]}"`);
  } catch (e) {
    const why = e instanceof PolicyBlockedError ? `BLOCKED ${e.message}` : (e as Error).message;
    console.log(`\nskip      ${name}\n  ${why.slice(0, 110)}`);
  }
}

async function main() {
  console.log(`projected first-Tuesday fallback would be: ${nextFirstTuesday()}`);
  for (const [n, u] of SEEDS) await probe(n, u);
  process.exit(0);
}
main();
