/**
 * The "code judges" half of the pipeline.
 *
 * Extraction is allowed to be fuzzy (an LLM reading a county PDF, a selector
 * guessing at a table cell). Acceptance is not. Everything that reaches the
 * database passes deterministic validation here, and every rejection is
 * counted — a spike in `rejected` for one adapter is the signal that a source
 * changed its layout, which is otherwise indistinguishable from "no sales
 * scheduled this month".
 *
 * These bounds exist to catch parser errors, not to second-guess counties.
 * They are deliberately wide: a $12 rural lot and a $4M commercial parcel are
 * both real, but a $0 opening bid on a parsed currency field usually means a
 * "$" landed in the wrong column.
 */

import type { DiscoveredAuction, DiscoveredLot } from "./types";

export interface Judgement<T> {
  accepted: T[];
  rejected: { record: unknown; reasons: string[] }[];
  /**
   * Field-level fixes applied to otherwise-good records.
   *
   * The distinction matters commercially: a parcel with a placeholder ZIP of
   * "0000000000" is still a real parcel someone can profitably buy. Throwing
   * it away to keep the dataset tidy costs the subscriber a deal. We null the
   * junk field, keep the record, and count the repair — a rising repair rate
   * flags a degrading source just as well as a rising rejection rate, without
   * silently dropping inventory.
   */
  repairs: { field: string; value: unknown; reason: string }[];
}

/** Sanity ceilings. Above these, assume a parse error, not a real number. */
const MAX_MONEY = 500_000_000;
const MAX_ACREAGE = 1_000_000;
const MIN_YEAR_BUILT = 1600;

/** Contiguous US + AK/HI bounding box, generous at the edges. */
const US_BOUNDS = { minLat: 17.5, maxLat: 72.0, minLon: -180.0, maxLon: -64.0 };

/**
 * A parcel identifier that a spreadsheet turned into a float.
 *
 * Excel coerces a long numeric parcel number to a double and renders it as
 * `3.05711E+12`. The digits past the sixth are gone before the county ever
 * publishes the file, so the value is not a recoverable identifier — it is a
 * different number that happens to start the same way.
 *
 * This has to be caught rather than passed through. A parcel number is a join
 * key: enrichment sends it to an assessor or a property API, and one that has
 * been rounded either resolves to nothing or, worse, resolves to a *different
 * parcel* whose assessed value then drives a walk-away price. Five New Mexico
 * parcels in Grant County arrive this way, and it is the same class of failure
 * as the Brevard account numbers (`docs/brevard-apn-resolution.md`).
 */
const SPREADSHEET_FLOAT = /^\d(\.\d+)?[eE][+-]?\d+$/;

function isMoneyish(v: number | undefined, label: string, reasons: string[]): void {
  if (v === undefined) return;
  if (!Number.isFinite(v)) reasons.push(`${label} is not a finite number (${v})`);
  else if (v < 0) reasons.push(`${label} is negative (${v})`);
  else if (v > MAX_MONEY) reasons.push(`${label} exceeds sanity ceiling (${v})`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function judgeAuctions(
  records: DiscoveredAuction[],
  opts: { countyFips: string },
): Judgement<DiscoveredAuction> {
  const accepted: DiscoveredAuction[] = [];
  const rejected: { record: unknown; reasons: string[] }[] = [];
  const seen = new Set<string>();

  for (const r of records) {
    const reasons: string[] = [];

    if (!r.externalId?.trim()) reasons.push("missing externalId");
    if (!r.sourceUrl?.trim()) reasons.push("missing sourceUrl");
    if (r.countyFips !== opts.countyFips) {
      reasons.push(`countyFips ${r.countyFips} does not match requested ${opts.countyFips}`);
    }
    if (!/^\d{5}$/.test(r.countyFips ?? "")) reasons.push("countyFips is not 5 digits");

    if (!ISO_DATE.test(r.saleDate ?? "")) {
      reasons.push(`saleDate is not YYYY-MM-DD (${r.saleDate})`);
    } else {
      const d = new Date(`${r.saleDate}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) reasons.push(`saleDate is not a real date (${r.saleDate})`);
      else {
        // Sales are scheduled, not archaeological. A date far outside this
        // window means a two-digit year or a swapped day/month.
        const year = d.getUTCFullYear();
        if (year < 2000 || year > new Date().getUTCFullYear() + 5) {
          reasons.push(`saleDate year ${year} is implausible`);
        }
      }
    }

    if (r.externalId && seen.has(r.externalId)) {
      reasons.push(`duplicate externalId within this batch (${r.externalId})`);
    }

    if (reasons.length) rejected.push({ record: r, reasons });
    else {
      seen.add(r.externalId);
      accepted.push(r);
    }
  }

  return { accepted, rejected, repairs: [] };
}

export function judgeLots(records: DiscoveredLot[]): Judgement<DiscoveredLot> {
  const accepted: DiscoveredLot[] = [];
  const rejected: { record: unknown; reasons: string[] }[] = [];
  const repairs: { field: string; value: unknown; reason: string }[] = [];
  const seenParcels = new Set<string>();

  for (const input of records) {
    const r = { ...input };
    const reasons: string[] = [];
    const repair = (field: string, value: unknown, reason: string) => {
      repairs.push({ field, value, reason });
    };

    // --- Identifier repair, before identity is judged --------------------
    // Ordering is deliberate: a rounded parcel number must stop being an
    // identifier *before* we ask whether the record has one, so the answer
    // falls through to externalId instead of accepting a corrupted key.

    if (r.parcelNumber && SPREADSHEET_FLOAT.test(r.parcelNumber.trim())) {
      repair("parcelNumber", r.parcelNumber, "scientific notation — digits lost upstream, not a usable join key");
      r.parcelNumber = undefined;
    }

    // --- Hard rejections -----------------------------------------------
    // Only two things justify discarding a parcel: we can't identify it, or
    // its money is wrong in a way that would mislead someone placing a bid.

    if (!r.parcelNumber?.trim() && !r.externalId?.trim()) {
      reasons.push("no parcelNumber and no externalId — record is unidentifiable");
    }

    isMoneyish(r.openingBid, "openingBid", reasons);
    isMoneyish(r.assessedValue, "assessedValue", reasons);
    isMoneyish(r.taxesOwed, "taxesOwed", reasons);
    isMoneyish(r.soldAmount, "soldAmount", reasons);

    // Dedupe on the *effective* key the runner will use — `parcelNumber ??
    // externalId` — not on parcelNumber alone. Sources that publish no parcel
    // number (Michigan's catalogs) would otherwise pass duplicates straight
    // through to a single INSERT ... ON CONFLICT, which Postgres rejects with
    // "cannot affect row a second time", failing the whole county.
    const key = r.parcelNumber?.trim() || r.externalId?.trim();
    if (key && seenParcels.has(key)) {
      reasons.push(`duplicate lot key within this auction (${key})`);
    }

    // --- Field repairs --------------------------------------------------
    // Descriptive metadata. Wrong here is annoying, not dangerous, so we null
    // the field and keep the parcel.

    if (r.zip !== undefined && r.zip !== "" && !/^\d{5}(-\d{4})?$/.test(r.zip)) {
      repair("zip", r.zip, "not a US ZIP");
      r.zip = undefined;
    }

    if (r.acreage !== undefined && (!Number.isFinite(r.acreage) || r.acreage < 0 || r.acreage > MAX_ACREAGE)) {
      repair("acreage", r.acreage, "out of range");
      r.acreage = undefined;
    }

    if (r.yearBuilt !== undefined) {
      const max = new Date().getUTCFullYear() + 2;
      // 0 is the standard "no structure" placeholder for vacant land.
      if (r.yearBuilt === 0) {
        r.yearBuilt = undefined;
      } else if (!Number.isInteger(r.yearBuilt) || r.yearBuilt < MIN_YEAR_BUILT || r.yearBuilt > max) {
        repair("yearBuilt", r.yearBuilt, "out of range");
        r.yearBuilt = undefined;
      }
    }

    if (
      r.buildingSqft !== undefined &&
      (!Number.isFinite(r.buildingSqft) || r.buildingSqft < 0 || r.buildingSqft > 5_000_000)
    ) {
      repair("buildingSqft", r.buildingSqft, "out of range");
      r.buildingSqft = undefined;
    }

    const hasLat = r.latitude !== undefined;
    const hasLon = r.longitude !== undefined;
    if (hasLat !== hasLon) {
      repair("coordinates", [r.latitude, r.longitude], "latitude and longitude must come as a pair");
      r.latitude = undefined;
      r.longitude = undefined;
    } else if (hasLat && hasLon) {
      const { minLat, maxLat, minLon, maxLon } = US_BOUNDS;
      const bad =
        !Number.isFinite(r.latitude!) ||
        !Number.isFinite(r.longitude!) ||
        r.latitude! < minLat ||
        r.latitude! > maxLat ||
        r.longitude! < minLon ||
        r.longitude! > maxLon;
      if (bad) {
        // Almost always a swapped lat/lon pair or a dropped minus sign.
        repair("coordinates", [r.latitude, r.longitude], "outside US bounds");
        r.latitude = undefined;
        r.longitude = undefined;
      }
    }

    if (reasons.length) rejected.push({ record: input, reasons });
    else {
      if (key) seenParcels.add(key);
      accepted.push(r);
    }
  }

  return { accepted, rejected, repairs };
}

/**
 * Parse a currency string from scraped HTML into a number.
 *
 * Returns undefined rather than 0 for unparseable input — a missing opening
 * bid and a $0 opening bid mean very different things to someone deciding
 * what to spend, and silently coercing one into the other is how a bidder
 * gets hurt.
 */
export function parseMoney(input: string | null | undefined): number | undefined {
  if (input == null) return undefined;
  const cleaned = String(input).replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalise a scraped date into YYYY-MM-DD, or undefined if unparseable. */
export function parseDate(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();

  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (ISO_DATE.test(s)) return s;

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return undefined;
}
