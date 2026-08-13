/**
 * The desk's clock. One place, because "today" is not a global fact.
 *
 * Everything this business runs on is US-local: a sale is attended on a
 * calendar date in a county, a registration deadline closes at a local hour, a
 * working week starts on a local Monday. The server's clock is UTC, and the gap
 * between the two is a whole day for a third of every day.
 *
 * ## The concrete failure this exists to prevent
 *
 * The dispatcher fired at 02:00 UTC, which is **18:00 or 19:00 Pacific the
 * previous day**. So:
 *
 * - The "nightly" crawl read each county's page as it stood at dinner time the
 *   day before, not overnight.
 * - A day-of-week check on the UTC date would have queued "Sunday" research on
 *   Saturday evening, every week, with nothing in the output saying so.
 *
 * Moving the cron to 09:00 UTC puts the tick at 01:00-02:00 Pacific *the same
 * day*, so the UTC date and the desk date agree at the moment work is planned.
 * That removes the class of bug rather than papering over it — but the helpers
 * below still read the desk zone explicitly, because a plan built by hand at
 * 6pm Pacific is still tomorrow in UTC.
 *
 * `Intl` handles PDT/PST. A fixed offset would be wrong for half the year and,
 * at these hours, wrong by a day.
 */

/** IANA zone, not a fixed offset — daylight saving is not optional. */
export const DESK_TIMEZONE = "America/Los_Angeles";

/**
 * The UTC hour the dispatcher fires.
 *
 * Chosen so the tick lands in the small hours Pacific on the *same* calendar
 * day: 09:00 UTC is 02:00 PDT in summer and 01:00 PST in winter. Vercel crons
 * are UTC-only, so the Pacific hour drifts by one across daylight saving; both
 * ends of that drift are still overnight, which is what matters.
 *
 * Keep this in step with `vercel.json`.
 */
export const DISPATCH_UTC_HOUR = 9;

/** Day of the week at the desk, e.g. "Sun". */
export function deskWeekday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DESK_TIMEZONE,
    weekday: "short",
  }).format(now);
}

/**
 * The desk's calendar date as YYYY-MM-DD.
 *
 * `en-CA` because it formats as ISO. Sale dates are plain dates and are
 * compared to this as strings, so the format has to match exactly.
 */
export function deskDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DESK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** A readable desk timestamp for the console, e.g. "Aug 13, 2:04 PM PDT". */
export function deskDateTime(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DESK_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

/** Short desk zone label for a heading, e.g. "PDT". */
export function deskZoneLabel(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DESK_TIMEZONE,
    timeZoneName: "short",
  }).formatToParts(now);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "PT";
}

/**
 * A `Date` whose UTC calendar date equals the desk's calendar date.
 *
 * For code that must keep taking a `Date` — `crawlsDueOn` derives its day from
 * `toISOString()` — this shifts the instant so that read lands on the desk's
 * day rather than the server's. Not a real instant; only its date part is
 * meaningful, which is why it is named for what it is used for.
 */
export function asDeskDay(now: Date = new Date()): Date {
  return new Date(`${deskDate(now)}T12:00:00Z`);
}
