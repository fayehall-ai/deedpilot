/**
 * Pennsylvania county Tax Claim Bureau sale lists.
 *
 * ## Why this is a profile table and not an adapter
 *
 * Every Pennsylvania county runs the same statutory process — an upset sale
 * under the Real Estate Tax Sale Law, then judicial, then repository — and
 * publishes the list as a PDF on its Tax Claim Bureau page. From the outside
 * that looks like one source with sixty-odd instances, and the obvious move is
 * one adapter with one parser.
 *
 * It is not one format. Two counties were read end to end before any of this
 * was written:
 *
 *   Luzerne   SaleNo | Municipality | Parcel | Owner | Description | Upset
 *             26-0003 ASHLEY BORO WARD 1 01-I9SE3 -006-01A-000BOBACK … 17,834.55$
 *
 *   Somerset  Ref | District | Owner | Co-Owner | Grantor | Descriptions |
 *             Upset | MapNo | OpeningBid
 *             02-0-002010 ADDISON TOWNSHIP BURKET … 272.52S02-025-101-00 553.65
 *
 * Different identifiers, different column orders, and Somerset carries both an
 * upset price and a separate opening bid where Luzerne carries one number. The
 * Tax Claim Bureaus buy their software separately and it shows.
 *
 * So the shared part is the plumbing — find the page, find the PDF, get its
 * text — and the varying part is one regex per county. Adding a county is
 * adding a profile, not writing an adapter, and a profile is small enough to
 * verify against the real PDF in the time it takes to read one.
 *
 * ## Why the parsing lives here and the fetching does not
 *
 * These are pure functions over text, so they are testable without a network or
 * a PDF. `scripts/ingest-pa-taxclaim.ts` does the I/O. That split is the same
 * one `govease.ts` describes: when a transport changes, the parsers should not
 * have to.
 *
 * ## The glued columns are not a bug in the extractor
 *
 * PDF text extraction puts cells next to each other with no separator when the
 * layout has no gap, so real rows arrive like `TP-00181,696.80$` — description
 * welded to price — and `WARD 121-G10NW4-002-023-000`, where a ward number
 * runs into the parcel. Each profile's regex is written against what the text
 * actually looks like rather than against the table a human sees, which is why
 * none of them require whitespace between fields that a county does not print.
 */

import type { DiscoveredLot } from "./types";

export interface PaCountyProfile {
  fips: string;
  county: string;
  /** Page carrying the list, or linking to the page that does. */
  listPage: string;
  /**
   * Followed one hop from `listPage` when the PDF is deeper, as at Luzerne
   * where the Tax Claim home links to `/tax-sales` and the PDFs live there.
   */
  follow?: RegExp;
  /** Recognises the sale-list PDF among the links found. */
  pdf: RegExp;
  /** One row of extracted text. */
  row: RegExp;
  /**
   * Set where the county's robots.txt disallows us, with the reason.
   *
   * The profile is kept rather than deleted because the parsing work is done
   * and verified — what is missing is permission to fetch, which is a different
   * fact and may change. Deleting it would invite someone to rediscover the
   * layout and then rediscover the block.
   */
  blocked?: string;
  /** Which capture group holds what. 1-based, matching RegExp groups. */
  groups: {
    parcel: number;
    openingBid: number;
    /** Owner and description, unsplit — the columns run together. */
    body?: number;
    /** Where a county prints an upset price separately from the opening bid. */
    upset?: number;
    saleNumber?: number;
  };
  note: string;
}

/**
 * One entry per county whose PDF has actually been read.
 *
 * Deliberately not generated or guessed. A regex that half-matches a layout
 * produces plausible parcels with wrong prices, which is worse than no parcels
 * at all — the bid would be computed from a number nobody checked.
 */
export const PA_PROFILES: PaCountyProfile[] = [
  {
    fips: "42079",
    county: "Luzerne",
    listPage: "https://luzernecountytaxclaim.com/tax-sales",
    pdf: /upset[-\s]*sale[-\s]*list/i,
    /*
     * Municipality is lazy and NOT followed by required whitespace: "WARD 1"
     * and the parcel's leading "21-" arrive welded together, and demanding a
     * space there dropped 229 of 1,374 rows on the first attempt.
     */
    row: /^\s*(\d{2}-\d{4})\s+(.*?)(\d{2}-[A-Z0-9]{1,8}\s*-[A-Z0-9]{2,4}-[A-Z0-9]{2,4}-\d{3})(.*?)([\d,]+\.\d{2})\s*\$/,
    groups: { saleNumber: 1, parcel: 3, body: 4, openingBid: 5 },
    note: "Upset sale list PDF; one price column, printed with a trailing dollar sign",
  },
  {
    fips: "42111",
    county: "Somerset",
    listPage: "http://www.co.somerset.pa.us/department.asp?deptnum=5",
    /*
     * Verified against the real PDF — 181 of 183 rows — and then found to be
     * unfetchable. `co.somerset.pa.us/robots.txt` is `User-agent: * /
     * Disallow: /`, admitting only Googlebot and bingbot, so the list page and
     * the PDF under `/files/` are both off limits. The first read of this
     * county was a browser-agent request that ignored robots, which is exactly
     * the thing `politeFetch` exists to stop happening by accident.
     *
     * Kept as a capture candidate rather than a crawl one.
     */
    blocked:
      "co.somerset.pa.us robots.txt disallows all agents but Googlebot and bingbot (checked 2026-09-11)",
    pdf: /taxsalelistings/i,
    /*
     * Prices carry one or two decimals — "979.5" is a real row — and the upset
     * price is welded to the map number. Requiring two decimals dropped 37 of
     * 183 rows.
     */
    row: /^\s*(\d{2}-\d-\d{6})\s*(.*?)([\d,]+\.\d{1,2})([A-Z]?\d{2}-\d{3}-\d{3}-\d{2})\s+([\d,]+\.\d{1,2})/,
    groups: { saleNumber: 1, body: 2, upset: 3, parcel: 4, openingBid: 5 },
    note: "Tax sale listings PDF; separate upset price and opening bid, map number is the parcel",
  },
];

export const profileFor = (fips: string): PaCountyProfile | undefined =>
  PA_PROFILES.find((p) => p.fips === fips);

const money = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export interface PaParseResult {
  lots: DiscoveredLot[];
  /** Lines that begin like a row and did not parse — the number to watch. */
  unmatched: string[];
}

/**
 * Rows out of one county's extracted PDF text.
 *
 * `unmatched` counts lines that *start* like a row and did not parse, rather
 * than every line that did not — a PDF is mostly headers, page furniture and
 * notices, and counting those as failures would make every run look broken. A
 * non-zero count here means the profile has drifted from the county's layout.
 */
export function parsePaList(text: string, profile: PaCountyProfile): PaParseResult {
  const lots: DiscoveredLot[] = [];
  const unmatched: string[] = [];
  const { groups: g } = profile;

  /* What a row's first field looks like, to tell a missed row from prose. */
  const rowStart = new RegExp(
    profile.row.source.replace(/^\^\\s\*/, "^\\s*").split(")")[0] + ")",
  );

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = profile.row.exec(line);
    if (!m) {
      if (rowStart.test(line)) unmatched.push(line.trim());
      continue;
    }

    const parcel = m[g.parcel]?.replace(/\s+/g, "");
    if (!parcel) continue;

    const body = g.body ? m[g.body]?.replace(/\s+/g, " ").trim() : undefined;

    lots.push({
      parcelNumber: parcel,
      lotNumber: g.saleNumber ? m[g.saleNumber] : undefined,
      openingBid: money(m[g.openingBid]),
      /*
       * The upset price is what the county must recover, so it is the tax
       * debt rather than a valuation. Recorded as taxesOwed where a county
       * prints it separately; where it prints one number, that number is the
       * opening bid and nothing is claimed about the debt.
       */
      taxesOwed: g.upset ? money(m[g.upset]) : undefined,
      /*
       * Owner and description arrive as one run of text and are kept that way.
       * Splitting them would need a rule per county about where a name ends,
       * and a wrong split writes half an address into an owner field.
       */
      legalDescription: body || undefined,
      status: "pending",
    });
  }

  return { lots, unmatched };
}
