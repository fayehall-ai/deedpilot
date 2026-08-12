/**
 * CAPE Component Ten — the PropStream auction list export.
 *
 * The TDC AI Automations document describes this as four manual steps: find an
 * upcoming auction over 50,000 population, download the county's Excel or CSV,
 * convert the PDF when there is no spreadsheet, then reshape it into the
 * PropStream template. Every one of those is a consequence of the parcel list
 * living in a file somewhere. It lives in this database, so the four collapse
 * into a query and a download.
 *
 * The population rule is the document's own: "an upcoming auction with more
 * than 50,000 population". Census Vintage 2024 per county, the same table
 * behind the atlas filter.
 *
 * ## Match on APN, not address
 *
 * Measured across the 4,591 parcels in qualifying counties: 4,586 carry a
 * parcel number, 2,801 carry a street line, and only 504 carry a complete
 * address with city and zip. An address-keyed export would put roughly one
 * parcel in nine in front of PropStream and silently drop the rest — and the
 * drop would look like PropStream having no data rather than like us having
 * sent none. APN plus county plus state is on 99.9% of them.
 *
 * Address columns are still emitted where present, because a match on either
 * is better than a match on one.
 */

/** The document's threshold, verbatim. */
export const MIN_POPULATION = 50_000;

export interface PropStreamRow {
  subjectProperty: string | null;
  countyName: string;
  auctionType: string | null;
  saleDate: string;
  openingBid: string | number | null;
  parcelNumber: string | null;
  addressLine: string | null;
  cityStateZip: string | null;
  taxesOwed: string | number | null;
  assessedValue: string | number | null;
  ownerName: string | null;
  buildingSqft: string | number | null;
  landUse: string | null;
  yearBuilt: string | number | null;
  bedsBaths: string | null;
  lotSize: string | null;
  lastSaleDate: string | null;
  arv: string | number | null;
  maxBid: string | number | null;
  arvBasis: string | null;
}

/**
 * Column order and headers, taken from the TDC 2026 Excel Analysis template.
 *
 * The earlier version of this array guessed at PropStream's generic import
 * fields. The real template is an analysis workbook — four tabs, one property
 * per workbook, with "Property Info" carrying a form of labels down column B
 * and a computed expense stack down column I. Headers here are that form's own
 * labels, verbatim, so a row lines up with the sheet it is meant to fill.
 *
 * Only the Property Summary block is emitted. The expense stack is the
 * workbook's own arithmetic — All-In Factor 70%, title insurance at 0.70%,
 * fixed carry for insurance, electric, gas and water — and re-deriving it here
 * would put two versions of the same model in circulation. What the sheet
 * cannot compute for itself is the ARV, so that is supplied, and DeedPilot's
 * own maximum bid rides alongside as a separate column rather than overwriting
 * the sheet's.
 *
 * Fields with no source in this system are absent rather than empty-headed:
 * HOA, amenities, and the Homes/Xome/Movoto/Realtor/Redfin/Zillow value rows,
 * which are the sites this product has no licensed access to.
 */
export const PROPSTREAM_COLUMNS: { header: string; key: keyof PropStreamRow }[] = [
  { header: "Subject Property", key: "subjectProperty" },
  { header: "County", key: "countyName" },
  { header: "Auction Type", key: "auctionType" },
  { header: "Auction Date", key: "saleDate" },
  { header: "Opening Bid", key: "openingBid" },
  { header: "APN#", key: "parcelNumber" },
  { header: "Prop. Address", key: "addressLine" },
  { header: "City/State/Zip", key: "cityStateZip" },
  { header: "Taxes", key: "taxesOwed" },
  { header: "Asses. Value", key: "assessedValue" },
  { header: "Current Owner", key: "ownerName" },
  { header: "Total Sqft", key: "buildingSqft" },
  { header: "Property Type", key: "landUse" },
  { header: "Year Built", key: "yearBuilt" },
  { header: "Beds/Bath", key: "bedsBaths" },
  { header: "Lot Size", key: "lotSize" },
  { header: "WD Date", key: "lastSaleDate" },
  /*
   * The sheet's E8. Everything in its expense stack keys off this one number,
   * and it is the number the sheet has no way to work out for itself.
   */
  { header: "After Rehab Value = ARV", key: "arv" },
  /*
   * Kept apart from the sheet's own "Maximum Bid =" cell on purpose. This one
   * is statute-aware — redemption window, quiet-title requirement and the
   * assessment ratio for the state — where the sheet applies a flat 70%
   * all-in factor. Two different models; the reader should see both rather
   * than have one silently replace the other.
   */
  { header: "DeedPilot Max Bid", key: "maxBid" },
  { header: "DeedPilot ARV Basis", key: "arvBasis" },
];

/**
 * One CSV field.
 *
 * Quoted whenever it contains a delimiter, a quote or a newline, with inner
 * quotes doubled — RFC 4180. Legal descriptions and owner strings in this data
 * carry commas routinely, and an unquoted one shifts every later column on that
 * row, which is the failure that makes an import look like garbage data rather
 * than a formatting bug.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote. Those are
 * formula triggers in Excel and Sheets, and the document's own workflow opens
 * this in a spreadsheet. A parcel number beginning with `-` should be a parcel
 * number, not a subtraction.
 */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toPropStreamCsv(rows: PropStreamRow[]): string {
  const head = PROPSTREAM_COLUMNS.map((c) => csvField(c.header)).join(",");
  const body = rows.map((r) =>
    PROPSTREAM_COLUMNS.map((c) => csvField(r[c.key])).join(","),
  );
  /* CRLF and a trailing newline — RFC 4180, and what Excel expects. */
  return [head, ...body].join("\r\n") + "\r\n";
}

export interface Qualification {
  qualifies: boolean;
  population: number | null;
  reason: string;
}

/**
 * Whether an auction clears the document's population bar.
 *
 * An unknown population does not qualify. The rule is "more than 50,000", and a
 * county we have no figure for has not met it — treating unknown as passing
 * would put the smallest counties, which are exactly the ones missing from the
 * Census table, into a list defined by being large.
 */
export function qualifies(population: number | null | undefined): Qualification {
  if (population === null || population === undefined) {
    return { qualifies: false, population: null, reason: "No population figure for this county" };
  }
  return population > MIN_POPULATION
    ? { qualifies: true, population, reason: `${population.toLocaleString()} residents` }
    : {
        qualifies: false,
        population,
        reason: `${population.toLocaleString()} residents — under the ${MIN_POPULATION.toLocaleString()} threshold`,
      };
}

/** `washington-ar-2026-09-01-propstream.csv` */
export function exportFilename(county: string, state: string, saleDate: string): string {
  const slug = county.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}-${state.toLowerCase()}-${saleDate}-propstream.csv`;
}
