/**
 * Weekly research scheduling invariants.
 * Run: npx tsx lib/admin/research-day.test.ts
 *
 * The dispatcher tick is defined in UTC and the desk is in Pacific. At the old
 * 02:00 UTC hour those disagreed by a whole day — the tick landed at 18:00-19:00
 * Pacific the PREVIOUS day — so a UTC day-of-week check would have run "Sunday"
 * research on Saturday evening, every week, silently.
 */
import { cooldownSince, isResearchDay, RESEARCH_COOLDOWN_DAYS } from "./research-day";
import { DISPATCH_UTC_HOUR, deskDate, deskWeekday } from "../desk-time";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/* The dispatcher tick on each day, at the hour vercel.json actually fires. */
const tick = (isoDay: string) =>
  new Date(`${isoDay}T${String(DISPATCH_UTC_HOUR).padStart(2, "0")}:00:00Z`);

// --- exactly one tick a week fires ------------------------------------------

const week = ["2026-08-14","2026-08-15","2026-08-16","2026-08-17","2026-08-18","2026-08-19","2026-08-20"];
const firing = week.filter((d) => isResearchDay(tick(d)));
assert(firing.length === 1, `exactly one tick a week must fire, got ${firing.length}: ${firing}`);
assert(firing[0] === "2026-08-16", `the Sunday tick should be Sunday at the desk, got ${firing[0]}`);

/*
 * The whole point of moving the hour: at 09:00 UTC the tick is overnight
 * Pacific on the SAME calendar day, so the two no longer disagree.
 */
for (const day of week) {
  assert(
    deskDate(tick(day)) === day,
    `at ${DISPATCH_UTC_HOUR}:00 UTC the desk date must match the UTC date, ${day} gave ${deskDate(tick(day))}`,
  );
}

// --- the trap this file exists for ------------------------------------------

/*
 * The old hour, kept as a regression: 02:00 UTC on a UTC Sunday is Saturday
 * evening Pacific. Anything that reverts the cron hour without revisiting this
 * check reintroduces a whole-day error.
 */
const oldHourSunday = new Date("2026-08-16T02:00:00Z");
assert(oldHourSunday.getUTCDay() === 0, "fixture check: 02:00 UTC that day is Sunday in UTC");
assert(deskWeekday(oldHourSunday) === "Sat", "…and Saturday at the Pacific desk");
assert(!isResearchDay(oldHourSunday), "a UTC Sunday that is Saturday at the desk must not fire");

// --- daylight saving is handled, not assumed --------------------------------

/*
 * Pacific is UTC-7 in August and UTC-8 in January, so a hard-coded offset would
 * drift by an hour and, at the wrong tick hour, by a whole day. Both winter and
 * summer must still fire on exactly one tick.
 */
for (const [label, days] of [
  ["winter", ["2026-01-11","2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16","2026-01-17"]],
  ["summer", ["2026-06-14","2026-06-15","2026-06-16","2026-06-17","2026-06-18","2026-06-19","2026-06-20"]],
] as const) {
  const n = days.filter((d) => isResearchDay(tick(d))).length;
  assert(n === 1, `${label}: exactly one tick a week must fire, got ${n}`);
}

// --- the cooldown ------------------------------------------------------------

const now = tick("2026-08-16");
const since = cooldownSince(now);
assert(
  Math.round((now.getTime() - since.getTime()) / 86_400_000) === RESEARCH_COOLDOWN_DAYS,
  "the cooldown window is six days back from the tick",
);
assert(since < now, "the cooldown boundary is in the past");

console.log("research-day.test.ts — all assertions passed");
