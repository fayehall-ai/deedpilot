/**
 * When the standing weekly research pass is due.
 *
 * Pure and free of `server-only` so it can be tested directly. The clock itself
 * lives in `lib/desk-time`, which explains why the desk zone rather than UTC
 * decides what day it is — at the old 02:00 UTC tick the two differed by a
 * whole day in Pacific, and a UTC check would have queued "Sunday" research on
 * Saturday evening every week with nothing in the output saying so.
 */

import { deskWeekday } from "../desk-time";

export { DESK_TIMEZONE, deskWeekday } from "../desk-time";

/** How many days must pass before a new weekly pass may queue. */
export const RESEARCH_COOLDOWN_DAYS = 6;

/** Day the pass runs unless an operator has changed it in pipeline settings. */
export const DEFAULT_RESEARCH_WEEKDAY = "Sun";

/**
 * Is this tick the weekly research slot?
 *
 * True on exactly one dispatcher tick per week — the one falling on the chosen
 * weekday at the desk. Daylight saving is handled by `Intl` rather than a fixed
 * offset, which is why this is not arithmetic on `getUTCDay()`.
 */
export function isResearchDay(now: Date, weekday: string = DEFAULT_RESEARCH_WEEKDAY): boolean {
  return deskWeekday(now) === weekday;
}

/** The earliest creation time that still counts as "already researched". */
export function cooldownSince(now: Date, days: number = RESEARCH_COOLDOWN_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
