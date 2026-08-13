/**
 * When the standing weekly research pass is due.
 *
 * Pure and free of `server-only` so it can be tested directly, which matters
 * more here than it looks: the dispatcher fires at 02:00 UTC, and a UTC
 * day-of-week check would put "Sunday" research on **Saturday** 21:00 Eastern.
 * The tick that actually lands on a US Sunday is Monday 02:00 UTC — Sunday
 * 22:00 ET — so the day must be read in the desk's timezone, not the server's.
 *
 * The failure mode is silent. Research would queue, drain and produce a report
 * every week, a day earlier than intended, and nothing in the output would say
 * so.
 */

/** The desk's timezone. Tax sales, deadlines and working days are all US-local. */
export const DESK_TIMEZONE = "America/New_York";

/** How many days must pass before a new weekly pass may queue. */
export const RESEARCH_COOLDOWN_DAYS = 6;

/** Day the pass runs unless an operator has changed it in pipeline settings. */
export const DEFAULT_RESEARCH_WEEKDAY = "Sun";

/** Day of the week at the desk, e.g. "Sun". */
export function deskWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DESK_TIMEZONE,
    weekday: "short",
  }).format(now);
}

/**
 * Is this tick the weekly research slot?
 *
 * True on exactly one 02:00-UTC tick per week — the one falling on a Sunday at
 * the desk. Daylight saving is handled by `Intl` rather than a fixed offset,
 * which is why this is not `getUTCDay() === 0` with four subtracted.
 */
export function isResearchDay(now: Date, weekday: string = DEFAULT_RESEARCH_WEEKDAY): boolean {
  return deskWeekday(now) === weekday;
}

/** The earliest creation time that still counts as "already researched". */
export function cooldownSince(now: Date, days: number = RESEARCH_COOLDOWN_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
