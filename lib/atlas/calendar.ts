/**
 * Tax sale calendar — when each jurisdiction actually sells.
 *
 * This is the scheduling primitive the ingest side was missing. Without it,
 * covering the country means polling 3,142 counties uniformly and discarding
 * almost everything: a county that sells once a year is empty on 364 days, and
 * every one of those fetches costs a request and an LLM extraction.
 *
 * With it, crawling becomes event-driven. Each county resolves to a recurrence
 * rule, the rule projects forward into concrete sale dates, and each date opens
 * a crawl window that runs from when the list is typically published to when
 * results typically appear. A national sweep becomes a few hundred targeted
 * crawls a week.
 *
 * Follows the same honesty contract as the rest of the atlas: counties inherit
 * state defaults, `inherited` names every field that came from the state rather
 * than county research, and `confidence` says whether a schedule is fixed in
 * statute, merely typical, or still unresearched. An unresearched county gets a
 * conservative sweep rather than a confident wrong date.
 */

import type { County } from "./types";
import { getCounty } from "./index";

/** How often a jurisdiction holds tax sales. */
export type SaleCadence =
  | "annual"
  | "biannual"
  | "quarterly"
  | "monthly"
  | "rolling"
  | "irregular";

/**
 * How much to trust a schedule.
 *
 * `statutory` means the timing is fixed in state law and a date can be computed.
 * `typical` means practice is consistent but counties vary, so the projection is
 * a good guess worth crawling around. `unresearched` means we do not know, and
 * the scout should sweep periodically instead of pretending to a date.
 */
export type ScheduleConfidence = "statutory" | "typical" | "unresearched";

/** A recurrence rule for tax sales in one jurisdiction. */
export interface SaleSchedule {
  cadence: SaleCadence;
  confidence: ScheduleConfidence;
  /** Months the sale occurs in, 1-12. Used by annual/biannual/quarterly. */
  months?: number[];
  /**
   * Fixed weekday rule, e.g. Texas's first Tuesday of the month.
   * `nth` is 1-4, or -1 for "last". `weekday` is 0=Sunday .. 6=Saturday.
   */
  nthWeekday?: { nth: 1 | 2 | 3 | 4 | -1; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 };
  /**
   * Days before the sale that the parcel list is typically published. The crawl
   * window opens here — earlier than this and there is nothing to fetch.
   */
  publishLeadDays: number;
  /** Days after the sale that results typically post. The archivist's window. */
  resultsLagDays: number;
  notes?: string;
  /** YYYY-MM this schedule was last verified. */
  asOf?: string;
  sources?: string[];
}

/** A county's schedule after state-default inheritance. */
export interface ResolvedSaleSchedule extends SaleSchedule {
  county: County;
  isStateDefault: boolean;
  inherited: string[];
}

/** One projected sale and the crawl windows around it. */
export interface SaleWindow {
  fips: string;
  state: string;
  /** Projected sale date, YYYY-MM-DD. */
  saleDate: string;
  /** True unless a county has a researched, dated schedule. Always true today. */
  estimated: boolean;
  confidence: ScheduleConfidence;
  /** Crawl for the parcel list from this date through the sale. */
  listingOpensOn: string;
  /** Crawl for results from this date. */
  resultsOpenOn: string;
}

const MS_PER_DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/**
 * The nth given weekday of a month, in UTC.
 *
 * `nth === -1` means the last such weekday. Returns null when a month has no
 * nth occurrence (e.g. a 5th Tuesday that does not exist), which the caller
 * treats as "no sale that period" rather than silently sliding to another week.
 */
export function nthWeekdayOf(
  year: number,
  month: number,
  nth: number,
  weekday: number,
): Date | null {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month, 0));
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return addDays(last, -back);
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const forward = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + forward + (nth - 1) * 7;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCMonth() === month - 1 ? candidate : null;
}

/**
 * State-level sale schedules.
 *
 * Only the jurisdictions whose timing is genuinely fixed in statute are marked
 * `statutory`. Everything else is `typical` or `unresearched` — an honest
 * placeholder beats a fabricated month, because a wrong date does not fail
 * loudly, it just quietly crawls an empty page forever.
 */
export const STATE_SALE_SCHEDULE: Record<string, SaleSchedule> = {
  // --- Fixed in statute -----------------------------------------------------
  TX: {
    cadence: "monthly",
    confidence: "statutory",
    nthWeekday: { nth: 1, weekday: 2 },
    publishLeadDays: 21,
    resultsLagDays: 7,
    notes:
      "Sales are held on the first Tuesday of each month at the county courthouse. Notice must be posted at least 21 days ahead.",
    asOf: "2026-07",
    sources: ["https://statutes.capitol.texas.gov/Docs/TX/htm/TX.34.htm"],
  },
  GA: {
    cadence: "monthly",
    confidence: "statutory",
    nthWeekday: { nth: 1, weekday: 2 },
    publishLeadDays: 28,
    resultsLagDays: 7,
    notes:
      "Sheriff's sales are held on the first Tuesday of the month on the courthouse steps. Advertised for four weeks beforehand. Mostly in person, so listings are often PDFs or legal-organ notices rather than a feed.",
    asOf: "2026-07",
    sources: ["https://law.justia.com/codes/georgia/title-48/chapter-4/"],
  },
  AZ: {
    cadence: "annual",
    confidence: "statutory",
    months: [2],
    publishLeadDays: 45,
    resultsLagDays: 14,
    notes:
      "Annual tax lien sale in February. Liens are bid down on the interest rate from 16%.",
    asOf: "2026-07",
    sources: ["https://www.azleg.gov/arsDetail/?title=42"],
  },
  MI: {
    cadence: "biannual",
    confidence: "statutory",
    months: [8, 10],
    publishLeadDays: 30,
    resultsLagDays: 3,
    notes:
      "Foreclosure auctions run late summer through autumn, with a second-round sale for unsold parcels. Redemption is extinguished at the foreclosure judgment, so no post-sale redemption occurs.",
    asOf: "2026-07",
    sources: ["https://www.tax-sale.info/"],
  },

  // --- Consistent practice, county-varying dates ----------------------------
  FL: {
    cadence: "monthly",
    confidence: "typical",
    publishLeadDays: 30,
    resultsLagDays: 2,
    notes:
      "Tax deed sales are scheduled by each clerk as applications ripen, so cadence varies by county. Most of the state runs through RealAuction, which is policy-blocked — prefer the clerk of court as source of record.",
    asOf: "2026-07",
  },
  IL: {
    cadence: "annual",
    confidence: "typical",
    months: [11],
    publishLeadDays: 30,
    resultsLagDays: 30,
    notes:
      "Annual tax sale, month varies by county (Cook runs its own calendar). Liens are bid down on the penalty rate, so the sale price is the delinquent tax owed rather than a market clearing price.",
    asOf: "2026-07",
  },
  MD: {
    cadence: "annual",
    confidence: "typical",
    months: [5, 6],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes:
      "Annual tax sale in late spring, date set per county. High-bid-premium structure — the recorded bid is not directly comparable to a clearing price.",
    asOf: "2026-07",
  },
  CA: {
    cadence: "annual",
    confidence: "typical",
    months: [3, 10],
    publishLeadDays: 30,
    resultsLagDays: 21,
    notes:
      "Tax-defaulted land sales are scheduled by each county, commonly spring or autumn. Sale is final; there is no post-sale right of redemption.",
    asOf: "2026-07",
  },
  CO: {
    cadence: "annual",
    confidence: "typical",
    months: [10, 11],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Annual lien sale in the autumn, bid up as a premium over the lien.",
    asOf: "2026-07",
  },
  NJ: {
    cadence: "annual",
    confidence: "typical",
    months: [6],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Municipal lien sales, bid down on interest then up as premium.",
    asOf: "2026-07",
  },
  IN: {
    cadence: "annual",
    confidence: "typical",
    months: [9, 10],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "County commissioners' certificate sales in early autumn.",
    asOf: "2026-07",
  },
  IA: {
    cadence: "annual",
    confidence: "typical",
    months: [6],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Annual June lien sale.",
    asOf: "2026-07",
  },
  MS: {
    cadence: "annual",
    confidence: "typical",
    months: [8],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Annual late-August lien sale.",
    asOf: "2026-07",
  },
  SC: {
    cadence: "annual",
    confidence: "typical",
    months: [10, 11],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Annual autumn sale, redeemable.",
    asOf: "2026-07",
  },
  TN: {
    cadence: "irregular",
    confidence: "typical",
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Judicial sales scheduled by chancery court; timing varies widely.",
    asOf: "2026-07",
  },
  NY: {
    cadence: "irregular",
    confidence: "typical",
    publishLeadDays: 30,
    resultsLagDays: 21,
    notes:
      "In-rem foreclosure auctions run per municipality, frequently via third-party auctioneers.",
    asOf: "2026-07",
  },
  OH: {
    cadence: "irregular",
    confidence: "typical",
    publishLeadDays: 21,
    resultsLagDays: 7,
    notes:
      "Sheriff's sales run on a rolling docket; some counties also hold bulk lien certificate sales.",
    asOf: "2026-07",
  },
  PA: {
    cadence: "annual",
    confidence: "typical",
    months: [9],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "Upset sale in September, judicial sale later for unsold parcels.",
    asOf: "2026-07",
  },
  WI: {
    cadence: "annual",
    confidence: "typical",
    months: [9, 10],
    publishLeadDays: 30,
    resultsLagDays: 14,
    notes: "County-run surplus land sales after tax deed is taken.",
    asOf: "2026-07",
  },
  OR: {
    cadence: "annual",
    confidence: "typical",
    months: [9, 10],
    publishLeadDays: 30,
    resultsLagDays: 21,
    notes: "County surplus property auctions following foreclosure.",
    asOf: "2026-07",
  },
  NC: {
    cadence: "irregular",
    confidence: "typical",
    publishLeadDays: 21,
    resultsLagDays: 14,
    notes:
      "Judicial foreclosure sales with a 10-day upset-bid period, so the winning bid is not final at the hammer.",
    asOf: "2026-07",
  },
};

/**
 * The fallback for states with no researched schedule.
 *
 * Deliberately `irregular`, which makes the scout sweep on a slow cadence rather
 * than target a date it does not have. Being obviously uninformed is cheaper
 * than being confidently wrong.
 */
export const UNRESEARCHED_SCHEDULE: SaleSchedule = {
  cadence: "irregular",
  confidence: "unresearched",
  publishLeadDays: 30,
  resultsLagDays: 21,
  notes:
    "No researched sale schedule for this state. Swept on the irregular cadence until the Source Prospector or county research fills it in.",
};

/**
 * County-level overrides.
 *
 * Populated as counties are researched, exactly like COUNTY_DATA. Cook County
 * is the worked example: it runs its own annual calendar rather than the
 * generic Illinois autumn window.
 */
export const COUNTY_SALE_SCHEDULE: Record<string, Partial<SaleSchedule>> = {
  // Cook County IL — annual tax sale, historically running in the first half of
  // the year and separate from the downstate autumn pattern.
  "17031": {
    cadence: "annual",
    confidence: "typical",
    months: [1, 2],
    publishLeadDays: 45,
    resultsLagDays: 45,
    notes:
      "Cook County runs its own annual tax sale calendar, distinct from the downstate autumn window. Sold results publish to the county open-data catalog.",
    asOf: "2026-07",
    sources: ["https://datacatalog.cookcountyil.gov/"],
  },
  // Maricopa AZ — the largest February lien sale in the country.
  "04013": {
    months: [2],
    publishLeadDays: 60,
    asOf: "2026-07",
    notes: "Large online February lien sale; list posts well ahead of the sale.",
  },
  // Wayne County MI — Detroit; the largest Michigan auction.
  "26163": {
    months: [9, 10],
    asOf: "2026-07",
    notes: "Runs later than the state pattern, with a large second-round sale.",
  },
};

/** Fields a county may override; anything unset is inherited from the state. */
const INHERITABLE: (keyof SaleSchedule)[] = [
  "cadence",
  "confidence",
  "months",
  "nthWeekday",
  "publishLeadDays",
  "resultsLagDays",
  "notes",
  "asOf",
  "sources",
];

/** The state's schedule, or the honest unresearched fallback. */
export function getStateSchedule(stateAbbr: string): SaleSchedule {
  return STATE_SALE_SCHEDULE[stateAbbr] ?? UNRESEARCHED_SCHEDULE;
}

/**
 * Resolve a county's sale schedule, recording what was inherited.
 *
 * Mirrors `resolveCountyRule` so the UI can label an inherited schedule the same
 * way it labels inherited rules.
 */
export function resolveSaleSchedule(fips: string): ResolvedSaleSchedule | null {
  const county = getCounty(fips);
  if (!county) return null;

  const stateSchedule = getStateSchedule(county.state);
  const override = COUNTY_SALE_SCHEDULE[fips];
  const inherited: string[] = [];

  // Only fields the county actually sets override the state; everything else is
  // recorded as inherited so the UI can label it, exactly as the rules atlas does.
  const applied: Partial<SaleSchedule> = {};
  for (const field of INHERITABLE) {
    if (override && override[field] !== undefined) {
      Object.assign(applied, { [field]: override[field] });
    } else {
      inherited.push(field);
    }
  }
  const merged: SaleSchedule = { ...stateSchedule, ...applied };

  return {
    ...merged,
    county,
    isStateDefault: !override,
    inherited,
  };
}

/**
 * Cadence → days between sweep visits when no date can be computed.
 *
 * Exhaustive over `SaleCadence` and unasserted, so adding a cadence to the union
 * fails the build here rather than silently defaulting to a 90-day sweep.
 */
const SWEEP_INTERVAL_DAYS: Record<SaleCadence, number> = {
  monthly: 30,
  quarterly: 91,
  biannual: 182,
  annual: 365,
  rolling: 30,
  irregular: 90,
};

/** Fixed anchor for sweep recurrence. Arbitrary but must never move. */
const SWEEP_EPOCH = Date.UTC(2020, 0, 1);

/**
 * Deterministic per-county offset into the sweep cycle.
 *
 * Spreads unscheduled counties across the interval instead of having every one
 * of them come due on the same day. Stable across processes — same county, same
 * phase, forever — so a restart does not reshuffle the whole crawl plan.
 */
function sweepPhase(fips: string, interval: number): number {
  let h = 0;
  for (let i = 0; i < fips.length; i++) h = (h * 31 + fips.charCodeAt(i)) | 0;
  return Math.abs(h) % interval;
}

/**
 * Project the next `count` sale windows for a county.
 *
 * Rules that pin a date (statutory weekday rules, month lists) produce real
 * projected dates. Rules that do not — `rolling`, `irregular`, anything
 * unresearched — produce evenly spaced sweep windows instead, so those counties
 * still get visited without the system claiming to know when they sell.
 */
export function nextSaleWindows(
  fips: string,
  opts: { from?: Date; count?: number } = {},
): SaleWindow[] {
  const schedule = resolveSaleSchedule(fips);
  if (!schedule) return [];

  const from = opts.from ?? new Date();
  const count = opts.count ?? 4;
  const state = schedule.county.state;
  const dates: Date[] = [];

  const pinned =
    schedule.confidence !== "unresearched" &&
    (schedule.nthWeekday !== undefined ||
      (schedule.months !== undefined && schedule.months.length > 0));

  if (pinned) {
    const startYear = from.getUTCFullYear();
    for (let y = startYear; y <= startYear + 3 && dates.length < count * 2; y++) {
      const months =
        schedule.months && schedule.months.length
          ? schedule.months
          : Array.from({ length: 12 }, (_, i) => i + 1);
      for (const m of months) {
        const d = schedule.nthWeekday
          ? nthWeekdayOf(y, m, schedule.nthWeekday.nth, schedule.nthWeekday.weekday)
          : // No weekday rule: assume mid-month, which is a guess and is
            // reported as such via `estimated`.
            new Date(Date.UTC(y, m - 1, 15));
        if (d && d.getTime() >= from.getTime()) dates.push(d);
      }
    }
    dates.sort((a, b) => a.getTime() - b.getTime());
  } else {
    // Sweep dates must be anchored to a fixed epoch, never to the query date.
    // Deriving them from `from` makes every window slide with the caller, so
    // every day falls inside one and an "irregular" county ends up polled daily
    // — precisely what the calendar exists to avoid.
    //
    // The per-county phase offset also staggers the sweeps, so 2,900 unscheduled
    // counties do not all come due on the same morning.
    const interval = SWEEP_INTERVAL_DAYS[schedule.cadence];
    const phase = sweepPhase(fips, interval);
    const elapsed = Math.floor((from.getTime() - SWEEP_EPOCH) / MS_PER_DAY);
    const k = Math.ceil((elapsed - phase) / interval);
    for (let i = 0; i < count; i++) {
      dates.push(new Date(SWEEP_EPOCH + (phase + (k + i) * interval) * MS_PER_DAY));
    }
  }

  return dates.slice(0, count).map((d) => ({
    fips,
    state,
    saleDate: iso(d),
    // Nothing in the atlas carries a confirmed per-sale date yet, so every
    // projection is an estimate. The Scout replaces these with observed dates
    // once it has actually seen a listing.
    estimated: true,
    confidence: schedule.confidence,
    listingOpensOn: iso(addDays(d, -schedule.publishLeadDays)),
    resultsOpenOn: iso(addDays(d, schedule.resultsLagDays)),
  }));
}

/** Which crawl a window is eligible for on a given date. */
export type CrawlKind = "listing" | "results";

export interface DueCrawl {
  fips: string;
  state: string;
  kind: CrawlKind;
  saleDate: string;
  confidence: ScheduleConfidence;
  /** Days until (negative) or since (positive) the sale. */
  daysFromSale: number;
}

/**
 * Counties whose crawl window is open on `on`.
 *
 * This is the function the Auction Scout schedules against. A listing crawl is
 * due between the publish lead and the sale; a results crawl is due for a couple
 * of weeks after results typically post.
 */
export function crawlsDueOn(
  fipsList: readonly string[],
  on: Date = new Date(),
  opts: { resultsWindowDays?: number } = {},
): DueCrawl[] {
  const resultsWindow = opts.resultsWindowDays ?? 21;
  const onMs = on.getTime();
  const due: DueCrawl[] = [];

  for (const fips of fipsList) {
    // Look slightly backwards so a sale that has just happened is still visible
    // for its results crawl.
    const windows = nextSaleWindows(fips, {
      from: addDays(on, -120),
      count: 6,
    });
    for (const w of windows) {
      const sale = new Date(`${w.saleDate}T00:00:00Z`).getTime();
      const listingOpens = new Date(`${w.listingOpensOn}T00:00:00Z`).getTime();
      const resultsOpens = new Date(`${w.resultsOpenOn}T00:00:00Z`).getTime();
      const daysFromSale = Math.round((onMs - sale) / MS_PER_DAY);

      if (onMs >= listingOpens && onMs <= sale) {
        due.push({
          fips,
          state: w.state,
          kind: "listing",
          saleDate: w.saleDate,
          confidence: w.confidence,
          daysFromSale,
        });
      } else if (
        onMs >= resultsOpens &&
        onMs <= resultsOpens + resultsWindow * MS_PER_DAY
      ) {
        due.push({
          fips,
          state: w.state,
          kind: "results",
          saleDate: w.saleDate,
          confidence: w.confidence,
          daysFromSale,
        });
      }
    }
  }
  return due;
}

/** Coverage accounting for `/coverage` and the design doc's honesty contract. */
export function calendarCoverage(): {
  statesWithSchedule: number;
  statesUnresearched: number;
  countyOverrides: number;
  byConfidence: Record<ScheduleConfidence, number>;
} {
  const byConfidence: Record<ScheduleConfidence, number> = {
    statutory: 0,
    typical: 0,
    unresearched: 0,
  };
  for (const s of Object.values(STATE_SALE_SCHEDULE)) {
    byConfidence[s.confidence]++;
  }
  return {
    statesWithSchedule: Object.keys(STATE_SALE_SCHEDULE).length,
    statesUnresearched: 51 - Object.keys(STATE_SALE_SCHEDULE).length,
    countyOverrides: Object.keys(COUNTY_SALE_SCHEDULE).length,
    byConfidence,
  };
}
