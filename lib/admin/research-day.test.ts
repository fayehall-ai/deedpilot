/**
 * Weekly research scheduling invariants.
 * Run: npx tsx lib/admin/research-day.test.ts
 *
 * The dispatcher fires at 02:00 UTC. A UTC day-of-week check would read
 * "Sunday" on the tick that is Saturday 21:00 at the desk — research would run
 * every week, one day early, and nothing in the output would say so.
 */
import { cooldownSince, deskWeekday, isResearchDay, RESEARCH_COOLDOWN_DAYS } from "./research-day";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/* The 02:00 UTC tick on each day of one week. */
const tick = (isoDay: string) => new Date(`${isoDay}T02:00:00Z`);

// --- exactly one tick a week fires ------------------------------------------

const week = ["2026-08-14","2026-08-15","2026-08-16","2026-08-17","2026-08-18","2026-08-19","2026-08-20"];
const firing = week.filter((d) => isResearchDay(tick(d)));
assert(firing.length === 1, `exactly one tick a week must fire, got ${firing.length}: ${firing}`);
assert(firing[0] === "2026-08-17", `the Monday 02:00 UTC tick is Sunday at the desk, got ${firing[0]}`);

// --- the trap this file exists for ------------------------------------------

/*
 * 2026-08-16T02:00Z *is* Sunday in UTC and Saturday 22:00 Eastern. A naive
 * getUTCDay() check would have queued the week's research on Saturday night.
 */
const utcSundayTick = tick("2026-08-16");
assert(utcSundayTick.getUTCDay() === 0, "fixture check: that tick is Sunday in UTC");
assert(deskWeekday(utcSundayTick) === "Sat", "…and Saturday at the desk");
assert(!isResearchDay(utcSundayTick), "a UTC Sunday that is Saturday at the desk must not fire");

// --- daylight saving is handled, not assumed --------------------------------

/*
 * Eastern is UTC-4 in August and UTC-5 in January, so a hard-coded offset would
 * drift by an hour and, at 02:00 UTC, by a whole day. Both winter and summer
 * must still fire on exactly one tick.
 */
for (const [label, days] of [
  ["winter", ["2026-01-09","2026-01-10","2026-01-11","2026-01-12","2026-01-13","2026-01-14","2026-01-15"]],
  ["summer", ["2026-06-12","2026-06-13","2026-06-14","2026-06-15","2026-06-16","2026-06-17","2026-06-18"]],
] as const) {
  const n = days.filter((d) => isResearchDay(tick(d))).length;
  assert(n === 1, `${label}: exactly one tick a week must fire, got ${n}`);
}

// --- the cooldown ------------------------------------------------------------

const now = tick("2026-08-17");
const since = cooldownSince(now);
assert(
  Math.round((now.getTime() - since.getTime()) / 86_400_000) === RESEARCH_COOLDOWN_DAYS,
  "the cooldown window is six days back from the tick",
);
assert(since < now, "the cooldown boundary is in the past");

console.log("research-day.test.ts — all assertions passed");
