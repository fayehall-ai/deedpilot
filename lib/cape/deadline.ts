/**
 * CAPE Component Eight — production calendar and deadlines.
 *
 * "Live-auction packages must be completed by Monday night. Online-auction
 * packages must be completed by Tuesday night."
 *
 * The document gives the weekday and not the week, so the week is inferred:
 * the deadline is the Monday or Tuesday of the week the sale falls in. That is
 * the reading the schedule's own purpose supports — investors are meant to
 * receive the package "early enough to conduct additional research, contact
 * county officials, inspect properties when possible, arrange funding". A
 * Monday deadline for a Tuesday sale gives one day; anything later gives none.
 *
 * Texas is the case that makes it concrete: sales are the first Tuesday of the
 * month, and on 1 September 2026 seventeen of them land at once. Under this
 * rule every one of those packages is due Monday 31 August.
 *
 * All arithmetic is UTC on plain `YYYY-MM-DD` strings, matching how sale dates
 * are stored — the same reason `lib/calendar/grid.ts` is written that way. A
 * package deadline that moves with the reader's timezone would be a bug that
 * only appeared west of UTC.
 */

/** Live sales are in a room; everything else is hosted. */
export type AuctionMode = "live" | "online";

export interface ProductionDeadline {
  mode: AuctionMode;
  /** `YYYY-MM-DD` the package is due, end of day. */
  dueDate: string;
  /** Whole days between the deadline and the sale. */
  leadDays: number;
  /**
   * True when the deadline has passed and the sale has not.
   *
   * The state worth alerting on: the package is late for a sale that is still
   * coming, which is the only window in which doing the work still helps
   * anyone.
   */
  overdue: boolean;
  /** True when the sale itself is in the past. Not overdue — finished. */
  salePassed: boolean;
}

/**
 * `platform` is the only signal we hold for how a sale is conducted.
 *
 * `in_person` is New Mexico's Property Tax Division, which auctions in a
 * county building. Everything else routes through a platform or a county
 * portal, which the document calls online.
 */
export function modeForPlatform(platform: string | null | undefined): AuctionMode {
  return platform === "in_person" ? "live" : "online";
}

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * The Monday of the ISO week containing `iso`.
 *
 * Sunday is day 0 in JS and belongs to the *previous* ISO week, so it maps back
 * six days rather than forward one. Getting that wrong would push a Sunday
 * sale's deadline to the day after the sale.
 */
function mondayOfWeek(iso: string): Date {
  const d = parse(iso);
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(d.getTime() - back * DAY_MS);
}

export function productionDeadline(opts: {
  saleDate: string;
  platform: string | null | undefined;
  /** Today, as `YYYY-MM-DD`. Injected so this stays pure and testable. */
  today: string;
}): ProductionDeadline {
  const mode = modeForPlatform(opts.platform);
  const monday = mondayOfWeek(opts.saleDate);
  const offset = mode === "live" ? 0 : 1;
  let due = new Date(monday.getTime() + offset * DAY_MS);

  /*
   * A deadline on or after the sale is not a deadline. A Monday live sale, or a
   * Monday/Tuesday online one, falls back a week — the package still has to be
   * finished before anyone can act on it.
   */
  if (fmt(due) >= opts.saleDate) {
    due = new Date(due.getTime() - 7 * DAY_MS);
  }

  const dueDate = fmt(due);
  const leadDays = Math.round((parse(opts.saleDate).getTime() - due.getTime()) / DAY_MS);
  const salePassed = opts.saleDate < opts.today;

  return {
    mode,
    dueDate,
    leadDays,
    overdue: !salePassed && dueDate < opts.today,
    salePassed,
  };
}
