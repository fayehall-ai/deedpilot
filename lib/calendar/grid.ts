/**
 * Month-grid geometry and filter-state encoding for the auction calendar.
 *
 * Pure string/date functions — no DB, no React — because the two things most
 * likely to be quietly wrong on a calendar are which square a sale lands on and
 * whether a filter survives a month change, and neither is worth discovering in
 * a browser.
 *
 * Every date here is a plain `YYYY-MM-DD` interpreted in UTC. Sale dates are
 * stored as SQL `date` with no time and no zone: a Michigan foreclosure sale on
 * 2026-08-11 is on the 11th, and a bidder reading this page from Honolulu must
 * see it on the 11th too. Constructing `new Date("2026-08-11")` and calling
 * `getDate()` puts it on the 10th west of UTC, which is exactly the class of
 * error that makes someone miss a sale.
 */

/** Sale-type filter slugs — stable in URLs even if display labels change. */
export const SALE_TYPE_BY_SLUG: Record<string, string> = {
  deed: "Tax Deed",
  lien: "Tax Lien",
  redeemable: "Redeemable Deed",
  hybrid: "Hybrid",
};

export const SLUG_BY_SALE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(SALE_TYPE_BY_SLUG).map(([slug, label]) => [label, slug]),
);

const MS_PER_DAY = 86_400_000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today in UTC as YYYY-MM-DD, matching how sale dates are stored. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The month a YYYY-MM-DD date falls in. */
export function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/**
 * A user-supplied month, or the fallback.
 *
 * Anything not exactly `YYYY-MM` with a real month number is rejected rather
 * than coerced — `?m=lol` should show this month, not January of year NaN.
 */
export function parseMonth(raw: unknown, fallback: string): string {
  return typeof raw === "string" && MONTH_RE.test(raw) ? raw : fallback;
}

/** Shift a `YYYY-MM` by whole months, rolling the year over. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const mon = total - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/** "September 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

/** First and last day of a month, inclusive. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  return {
    first: iso(new Date(Date.UTC(y, m - 1, 1))),
    last: iso(new Date(Date.UTC(y, m, 0))),
  };
}

export interface DayCell {
  /** YYYY-MM-DD */
  iso: string;
  dayOfMonth: number;
  /** False for the leading/trailing days borrowed from adjacent months. */
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

/**
 * The visible grid range — whole Sunday-to-Saturday weeks covering the month.
 *
 * Queried rather than the month itself so the spillover squares show real
 * sales. A bidder looking at the last week of August is planning for the first
 * week of September; blanking those squares hides the busiest day in the data.
 */
export function gridRange(month: string): { start: string; end: string } {
  const { first, last } = monthBounds(month);
  const firstDate = new Date(`${first}T00:00:00Z`);
  const lastDate = new Date(`${last}T00:00:00Z`);
  return {
    start: iso(addDays(firstDate, -firstDate.getUTCDay())),
    end: iso(addDays(lastDate, 6 - lastDate.getUTCDay())),
  };
}

/** Weeks of day cells covering `month`, Sunday-first. */
export function monthGrid(month: string, today: string): DayCell[][] {
  const { start, end } = gridRange(month);
  const weeks: DayCell[][] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  while (cursor.getTime() <= endDate.getTime()) {
    const week: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const dayIso = iso(cursor);
      const weekday = cursor.getUTCDay();
      week.push({
        iso: dayIso,
        dayOfMonth: cursor.getUTCDate(),
        inMonth: dayIso.startsWith(month),
        isToday: dayIso === today,
        isWeekend: weekday === 0 || weekday === 6,
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// ---------------------------------------------------------------------------
// Grouping repeated county sales
// ---------------------------------------------------------------------------

/**
 * A county can hold several genuinely separate sales on one day.
 *
 * Texas is the case in the data: Harris County sells through eight constable
 * precincts, each its own auction with its own parcel list, so August 4 lists
 * "TX · Harris" eight times. They are not duplicate records — collapsing them
 * to a single row would lose seven real sale lists — but eight identical lines
 * read as an ingest bug and crowd out the other counties selling that day.
 */
/*
 * `parcelsShown` is imported rather than reimplemented so the calendar and the
 * auction pages cannot drift on what a sale's parcel count means. It is pure
 * formatting logic with no DB or React dependency, which keeps this module's
 * own guarantee intact.
 */
import { parcelsShown } from "../format";

export interface GroupableSale {
  countyFips: string;
  saleType: string;
  listingKind: string;
  saleDateConfirmed: boolean;
  lotCount: number;
  /** Published count for a sale nothing has crawled. See `parcelsShown`. */
  announcedParcelCount?: number | null;
  status: string;
  title: string | null;
  /** Summed across the group when present. Absent is fine — see `bidTotal`. */
  totalOpeningBids?: string | null;
}

export interface SaleGroup<T> {
  key: string;
  sales: T[];
  /** Per-sale labels distinguishing members, e.g. "precinct 1". Null if none. */
  labels: (string | null)[];
  /**
   * Parcels across the group: those held, plus those a county has announced.
   *
   * Sums `parcelsShown` rather than `lotCount` so an imported sale of 16,062
   * parcels does not sort and display as a zero. `announcedTotal` says how much
   * of this figure is still only a claim.
   */
  lotTotal: number;
  /** The part of `lotTotal` that comes from announced, uncrawled sales. */
  announcedTotal: number;
  /**
   * Summed opening bids, or null when not one member published any.
   *
   * Null rather than 0 on purpose: "$0" claims every parcel in this county
   * opens free, and a missing bid sheet must not be able to say that.
   */
  bidTotal: number | null;
  cancelledCount: number;
  allCancelled: boolean;
}

/** Statuses that mean this sale is not happening as listed. */
function isCancelled(status: string): boolean {
  return status === "cancelled" || status === "postponed";
}

/**
 * Collapse same-county sales on one day into groups.
 *
 * The key deliberately includes sale type and lead status, not just the county:
 * a row carries a type colour and possibly a "projected" tag, and a group can
 * only wear one of each honestly. A projected sale folded into a group of
 * confirmed ones would lose its warning, which is the one thing on this page
 * that must never happen silently.
 *
 * Input order is preserved within a group; groups are returned largest-first by
 * lot count, so a county running seven small precinct sales does not outrank a
 * single 400-lot sale simply by having more rows.
 */
export function groupSalesByCounty<T extends GroupableSale>(sales: T[]): SaleGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const s of sales) {
    const isLead = s.listingKind !== "sale_list" || !s.saleDateConfirmed;
    const key = `${s.countyFips}|${s.saleType}|${isLead ? "lead" : "confirmed"}`;
    const existing = groups.get(key);
    if (existing) existing.push(s);
    else groups.set(key, [s]);
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const cancelledCount = members.filter((m) => isCancelled(m.status)).length;
      // Filtered before the cast, not after: `Number(null)` is 0, so summing
      // the raw values would turn "this county published no opening bids" into
      // a confident $0.
      const bids = members
        .map((m) => m.totalOpeningBids)
        .filter((v): v is string => v !== null && v !== undefined && v !== "")
        .map(Number)
        .filter(Number.isFinite);
      return {
        key,
        sales: members,
        labels: distinguishingLabels(members.map((m) => m.title)),
        lotTotal: members.reduce((n, m) => n + parcelsShown(m).count, 0),
        announcedTotal: members.reduce(
          (n, m) => n + (parcelsShown(m).announced ? parcelsShown(m).count : 0),
          0,
        ),
        bidTotal: bids.length ? bids.reduce((a, b) => a + b, 0) : null,
        cancelledCount,
        allCancelled: cancelledCount === members.length,
      };
    })
    .sort((a, b) => b.lotTotal - a.lotTotal || a.key.localeCompare(b.key));
}

/** Characters that read as "the shared part of the title ends here". */
const TITLE_SEPARATORS = "—–-:|·,";

/**
 * What actually differs between a group's titles.
 *
 * Given eight titles of the form "HARRIS COUNTY tax sale — precinct N", returns
 * "precinct 1" … "precinct 8" rather than the bare digits: the shared prefix is
 * cut back to the last separator, so the remainder stays a readable phrase.
 * Returns nulls when the titles are absent, identical, or the only member —
 * the caller then falls back to something it can always show, like lot count.
 */
export function distinguishingLabels(titles: (string | null)[]): (string | null)[] {
  const present = titles.filter((t): t is string => Boolean(t && t.trim()));
  if (titles.length < 2 || present.length < 2) return titles.map(() => null);

  // Longest prefix common to every present title.
  let n = 0;
  const first = present[0];
  outer: while (n < first.length) {
    for (const t of present) if (t[n] !== first[n]) break outer;
    n++;
  }

  // Cut back to a boundary so the remainder is a phrase, not a fragment.
  let cut = n;
  const head = first.slice(0, n);
  const sep = Math.max(...[...TITLE_SEPARATORS].map((c) => head.lastIndexOf(c)));
  if (sep >= 0) cut = sep + 1;
  else {
    const space = head.lastIndexOf(" ");
    if (space >= 0) cut = space + 1;
  }

  return titles.map((t) => {
    if (!t) return null;
    const rest = t.slice(cut).replace(/^[\s—–\-:|·,]+/, "").trim();
    return rest || null;
  });
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

export interface CalendarFilters {
  /**
   * The route these filter links point back at.
   *
   * The same calendar renders on `/calendar` and on the home page, and a chip
   * must return you to the page you clicked it on — hardcoding `/calendar`
   * silently teleported anyone filtering from home.
   */
  basePath: string;
  /** YYYY-MM currently shown. */
  month: string;
  /** The month containing today. What the "Today" chip returns to. */
  currentMonth: string;
  /**
   * The month a bare URL resolves to — omitted from hrefs to keep `/calendar`
   * clean.
   *
   * Usually the current month, but the caller may hand us a later one when
   * this month has no sales left. It has to travel with the filters rather than
   * be recomputed from `currentMonth`, because `calendarHref` decides whether
   * to write `?m=` by comparing against it: if the two disagreed, the bare URL
   * and the "Today" chip would resolve to different months and one of them
   * would be wrong.
   */
  defaultMonth: string;
  /** State abbreviations. Empty means all. */
  states: string[];
  /** Sale-type labels ("Tax Deed"), decoded from URL slugs. Empty means all. */
  saleTypes: string[];
  /** Platform enum values. Empty means all. */
  platforms: string[];
  /**
   * Show delinquent rolls, lands-available inventory, and sales sitting under a
   * date this system projected rather than read from the county.
   *
   * Off by default and never silently on. A projected date on a calendar is a
   * claim that a sale happens that day, and the calendar is the surface where
   * that claim is most likely to be believed without reading the label.
   */
  includeLeads: boolean;
}

type RawParams = Record<string, string | string[] | undefined>;

function csv(raw: string | string[] | undefined): string[] {
  const joined = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return Array.from(
    new Set(
      joined
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Every query parameter the calendar reads. `proxy.ts` routes a home-page URL
 * carrying any of these to the dynamic copy of the page; keep the two in step
 * with `parseCalendarFilters` below.
 */
export const CALENDAR_PARAMS = ["m", "state", "type", "platform", "leads"] as const;

export function parseCalendarFilters(
  params: RawParams,
  today: string,
  basePath = "/calendar",
  /** Where a bare URL lands. Defaults to today's month; see `CalendarFilters`. */
  defaultMonth?: string,
): CalendarFilters {
  const currentMonth = monthOf(today);
  const landing = defaultMonth && MONTH_RE.test(defaultMonth) ? defaultMonth : currentMonth;
  return {
    basePath,
    month: parseMonth(params.m, landing),
    currentMonth,
    defaultMonth: landing,
    states: csv(params.state)
      .map((s) => s.toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s))
      .sort(),
    saleTypes: csv(params.type)
      .map((s) => SALE_TYPE_BY_SLUG[s.toLowerCase()])
      .filter((s): s is string => Boolean(s)),
    platforms: csv(params.platform).filter((s) => /^[a-z_]{2,30}$/.test(s)),
    includeLeads: params.leads === "1",
  };
}

/** The filters' own route with `patch` applied, e.g. `/calendar?m=2026-09`. */
export function calendarHref(
  filters: CalendarFilters,
  patch: Partial<CalendarFilters> = {},
): string {
  const next = { ...filters, ...patch };
  const p = new URLSearchParams();
  // Against the landing month, not today's: those differ whenever this month
  // has run out of sales, and writing `?m=` by the wrong one either dirties
  // every URL or points "Today" at the month it is already on.
  if (next.month !== next.defaultMonth) p.set("m", next.month);
  if (next.states.length) p.set("state", [...next.states].sort().join(","));
  if (next.saleTypes.length) {
    p.set("type", next.saleTypes.map((t) => SLUG_BY_SALE_TYPE[t] ?? t).join(","));
  }
  if (next.platforms.length) p.set("platform", [...next.platforms].sort().join(","));
  if (next.includeLeads) p.set("leads", "1");
  const qs = p.toString();
  return qs ? `${next.basePath}?${qs}` : next.basePath;
}

/** Add `value` if absent, remove it if present. */
export function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function hasActiveFilters(f: CalendarFilters): boolean {
  return (
    f.states.length > 0 || f.saleTypes.length > 0 || f.platforms.length > 0 || f.includeLeads
  );
}
