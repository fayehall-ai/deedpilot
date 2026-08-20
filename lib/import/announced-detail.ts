/**
 * What an imported auction knows, read back out of its source row.
 *
 * An imported sale has no parcels, and for a while that made its detail page
 * almost empty — a date, a county, and a table with nothing in it. But the row
 * that created it is not empty at all: it carries where the sale physically
 * happens, how bidding works, the total being offered, and the collector's
 * phone number and email. That is most of what somebody deciding whether to
 * attend actually needs, and it was already in the database, unread, in `raw`.
 *
 * ## Why this reads `raw` rather than new columns
 *
 * Every field here is prose published by an aggregator: a registration note, a
 * venue address, a fax number. None of it is queried, filtered, sorted or
 * summed — it is displayed once, on one page, when somebody opens a sale. Nine
 * more nullable columns on `auctions` would carry a migration, a place in every
 * insert, and a standing invitation to compute something from a value nobody
 * has verified. `raw` already holds it losslessly and is already written.
 *
 * The trade is that these keys are the *file's* column names, so a differently
 * shaped export yields fewer fields rather than an error. Everything here is
 * optional and absence renders as nothing at all — never as a blank label, and
 * never as a placeholder that could be mistaken for a real value.
 */

/** A labelled value ready to render, or nothing when the source was blank. */
export interface DetailField {
  label: string;
  value: string;
  /** Rendered as a link when set. */
  href?: string;
}

export interface AnnouncedDetail {
  /** Where a live sale is held, assembled from the address columns. */
  venue: string | null;
  facts: DetailField[];
  contacts: DetailField[];
  /** Registration terms, as published. Long, and shown in full. */
  registration: string | null;
  notes: string | null;
}

/** True when this auction came from a calendar import rather than a crawl. */
export function isImported(externalId: string): boolean {
  return externalId.startsWith("ustla:");
}

/**
 * Publishers write "None" and "N/A" where they mean an empty cell.
 *
 * Rendered literally, a notes field reading "None" becomes a paragraph on the
 * auction page that says None, which looks like a value and is not one.
 */
const EMPTY_WORDS = new Set(["none", "n/a", "na", "-", "--", "tbd", "unknown"]);

function text(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || EMPTY_WORDS.has(t.toLowerCase())) return null;
  return t;
}

/** A published site, normalised to something an anchor can use. */
function siteHref(site: string): string {
  return /^https?:\/\//i.test(site) ? site : `https://${site}`;
}

function push(into: DetailField[], label: string, value: string | null, href?: string): void {
  if (value) into.push({ label, value, ...(href ? { href } : {}) });
}

export function readAnnouncedDetail(raw: Record<string, unknown> | null): AnnouncedDetail | null {
  if (!raw) return null;

  const facts: DetailField[] = [];
  const contacts: DetailField[] = [];

  push(facts, "Venue", text(raw, "Online or Onsite"));
  push(facts, "Bidding", text(raw, "Bid Procedures"));
  push(facts, "Sale runs", text(raw, "Sale Duration"));

  const endDate = text(raw, "Sale End Date");
  const startDate = text(raw, "Sale Date");
  // Only worth saying when the sale spans more than the one day already shown.
  if (endDate && endDate !== startDate) push(facts, "Through", endDate);

  const amount = text(raw, "Aggregate Sale Amount (USD)");
  if (amount) {
    const n = Number(amount);
    push(
      facts,
      "Total offered",
      Number.isFinite(n)
        ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
        : amount,
    );
  }

  for (const [label, key] of [
    ["Bidding site", "Online Site (Lien)"],
    ["Deed sale site", "Online Site (Deed)"],
    ["Foreclosure site", "Online Site (Foreclosure)"],
  ] as const) {
    const site = text(raw, key);
    if (site) push(facts, label, site, siteHref(site));
  }

  push(contacts, "Collector", text(raw, "County Treasurer"));
  const phone = text(raw, "County Phone");
  if (phone) push(contacts, "Phone", phone, `tel:${phone.replace(/[^\d+]/g, "")}`);
  const email = text(raw, "County Email");
  if (email) push(contacts, "Email", email, `mailto:${email}`);
  push(contacts, "Fax", text(raw, "County Fax"));

  /*
   * The venue address is only meaningful for a sale someone can physically
   * attend. "Online auction" appears in the address column for online sales,
   * which would render as a street address for a courthouse that does not
   * exist, so anything that is not a real address line is dropped.
   */
  const line1 = text(raw, "Sale Address 1");
  const city = text(raw, "Sale City");
  const zip = text(raw, "Sale Zip");
  const looksPhysical = line1 !== null && !/^online/i.test(line1);
  const venue = looksPhysical
    ? [line1, text(raw, "Sale Address 2"), [city, zip].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
    : null;

  const detail: AnnouncedDetail = {
    venue: venue || null,
    facts,
    contacts,
    registration: text(raw, "Registration / County Laws"),
    notes: text(raw, "Additional Sale Notes"),
  };

  const empty =
    !detail.venue &&
    detail.facts.length === 0 &&
    detail.contacts.length === 0 &&
    !detail.registration &&
    !detail.notes;
  return empty ? null : detail;
}
