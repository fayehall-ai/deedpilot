/**
 * NETR Online's county directory — where a county's offices actually live.
 *
 * ## What problem this solves
 *
 * 57 counties in the current window have no usable source: either nothing was
 * ever found, or what was found is `publicrecords.onlinesearches.com`, which is
 * a records directory rather than a county's own list. Both amount to the same
 * thing — the crawler has nowhere to start.
 *
 * NETR publishes, per county, a small table of offices with the URL each one
 * actually uses: assessor, tax commissioner or treasurer, recorder, GIS. That
 * is not a sale list and must not be mistaken for one. It is the doorstep, and
 * the two-hop document search in `generic.ts` is what walks in from there.
 *
 * ## Access
 *
 * `robots.txt` names a dozen SEO crawlers and denies them outright, then gives
 * everyone else `Crawl-delay: 10` and disallows the expensive endpoints —
 * search, map, parcel. It says in a comment that "state/county directories stay
 * crawlable for SEO", and `/state/XX/county/<slug>` is not disallowed. We are
 * not in the deny list and the county pages answer this project's agent with
 * 200.
 *
 * Ten seconds is the price of admission and it is honoured. 57 counties is ten
 * minutes; the whole country would be nine hours, which is a reason to scope a
 * run rather than a reason to go faster.
 */
import * as cheerio from "cheerio";
import { politeFetch } from "../ingest/fetch";

export interface NetrOffice {
  /** As NETR names it: "Bryan Tax Commissioner", "Bryan Assessor". */
  office: string;
  url: string;
  phone?: string;
  /** Which office this is, for ranking. */
  kind: "tax" | "assessor" | "recorder" | "gis" | "other";
}

/** NETR's crawl-delay, honoured rather than negotiated. */
export const NETR_DELAY_MS = 10_000;

/**
 * Who runs the tax sale, ranked by who publishes the list.
 *
 * The tax office first — collector, commissioner, treasurer, sheriff where the
 * sheriff sells. The assessor knows what a parcel is worth and never publishes
 * the sale; it is useful for enrichment and useless as a starting point, so it
 * ranks below the recorder rather than above it.
 */
function classify(office: string): NetrOffice["kind"] {
  const o = office.toLowerCase();
  if (/tax|collector|treasur|commissioner|revenue|sheriff/.test(o)) return "tax";
  if (/recorder|clerk|deed|register/.test(o)) return "recorder";
  if (/assessor|appraisal|property/.test(o)) return "assessor";
  if (/gis|mapping|aerial/.test(o)) return "gis";
  return "other";
}

const RANK: Record<NetrOffice["kind"], number> = {
  tax: 0, recorder: 1, assessor: 2, gis: 3, other: 4,
};

export function netrUrl(state: string, county: string): string {
  const slug = county
    .toLowerCase()
    .replace(/\b(county|parish|borough|city and borough|municipality|census area)\b/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `https://publicrecords.netronline.com/state/${state.toUpperCase()}/county/${slug}`;
}

/**
 * Parse a county page into its offices.
 *
 * It is `Name | Phone | Online | Report`, but not a `<table>` — NETR builds it
 * from divs with `col-name` attributes, which is why a `<tr>` parser returns
 * nothing at all rather than something wrong. Both shapes are read, because a
 * silent zero from a selector mismatch looks exactly like a county with no
 * offices listed, and those are different facts.
 *
 * The link that matters says "Go to Data Online" in every row, so the office
 * name has to come from the row rather than the anchor. Anchors carrying
 * NETR's own navigation, its advertising and the aerial-photography partner are
 * dropped: none is a county office and one of them is an ad network.
 */
export function parseNetrCounty(html: string, pageUrl: string): NetrOffice[] {
  const $ = cheerio.load(html);
  const out: NetrOffice[] = [];

  $(".div-table-row, tr").each((_, el) => {
    const row = $(el);
    if (row.hasClass("head")) return;
    const cells = row
      .find(".div-table-col, td")
      .map((__, c) => $(c).text().replace(/\s+/g, " ").trim())
      .get();
    if (cells.length < 2) return;
    const office = cells[0];
    if (!office || office.length > 70 || /^name$/i.test(office)) return;

    const href = row.find('a[href^="http"]').filter((__, a) => {
      const u = $(a).attr("href") ?? "";
      return !/netronline|historicaerials|freestar|nordvpn|google/i.test(u);
    }).first().attr("href");
    if (!href) return;

    const phone = cells.find((c) => /\(\d{3}\)\s*\d{3}-\d{4}/.test(c));
    try {
      out.push({
        office,
        url: new URL(href, pageUrl).toString(),
        phone: phone?.match(/\(\d{3}\)\s*\d{3}-\d{4}/)?.[0],
        kind: classify(office),
      });
    } catch {
      /* malformed href — skip */
    }
  });

  const seen = new Set<string>();
  return out
    .filter((o) => (seen.has(o.url) ? false : (seen.add(o.url), true)))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/** Offices for one county, or an empty list. Never throws. */
export async function netrOffices(state: string, county: string): Promise<NetrOffice[]> {
  const url = netrUrl(state, county);
  try {
    const res = await politeFetch(url);
    return parseNetrCounty(res.body, url);
  } catch (e) {
    console.warn(`[netronline] ${state} ${county}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
