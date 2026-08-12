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
  parcelNumber: string | null;
  addressLine: string | null;
  city: string | null;
  zip: string | null;
  countyName: string;
  state: string;
  ownerName: string | null;
  openingBid: string | number | null;
  assessedValue: string | number | null;
  acreage: string | number | null;
  landUse: string | null;
  saleDate: string;
}

/**
 * Column order and headers.
 *
 * These are PropStream's standard property-list import fields. The exact header
 * row in the TDC template has not been seen, and the document is explicit that
 * matching it matters — "make sure to match the format to get the best results.
 * This is usually obtained by being exact in importing the template". So this
 * lives in one place, as data, and reconciling it against the real template is
 * an edit to this array rather than a change to the exporter.
 */
export const PROPSTREAM_COLUMNS: { header: string; key: keyof PropStreamRow }[] = [
  { header: "APN", key: "parcelNumber" },
  { header: "County", key: "countyName" },
  { header: "State", key: "state" },
  { header: "Address", key: "addressLine" },
  { header: "City", key: "city" },
  { header: "Zip", key: "zip" },
  { header: "Owner Name", key: "ownerName" },
  { header: "Opening Bid", key: "openingBid" },
  { header: "Assessed Value", key: "assessedValue" },
  { header: "Acres", key: "acreage" },
  { header: "Land Use", key: "landUse" },
  { header: "Sale Date", key: "saleDate" },
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
