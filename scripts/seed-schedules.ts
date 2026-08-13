/**
 * Seed the recurring crawl schedules.
 *
 * `run_schedules` was empty, which is why nothing ran: `/api/cron/dispatch`
 * fired nightly at 02:00 UTC, called `enqueueDueSchedules()`, found no rows and
 * did nothing. Every ingest run on record came from someone's terminal.
 *
 * ## Why the intervals are what they are
 *
 * The dispatcher claims work for `BUDGET_MS - RESERVE_MS` = **195 seconds**,
 * once a day on a Hobby plan. That is the entire daily drain rate, and
 * `enqueueDueSchedules` does not dedupe — it enqueues on every due schedule
 * whether or not the last one ever ran. Scheduling more work per day than 195s
 * therefore does not "run a bit behind", it grows the queue without bound.
 *
 * So total expected daily work is sized just under the drain rate, using
 * measured per-county durations (`ingest_runs`, 7,632 county-level runs):
 *
 * | adapter          | counties | p50/county | full sweep |
 * |------------------|---------:|-----------:|-----------:|
 * | generic-county   |      154 |      3.6s  |     ~555s  |
 * | mi-taxsaleinfo   |       75 |      2.9s  |     ~218s  |
 * | ar-cosl          |       46 |      3.7s  |     ~170s  |
 * | tx-lgbs          |       41 |      7.4s  |     ~303s  |
 * | the other eight  |       67 |         —  |      ~71s  |
 *
 * The eight cheap adapters sweep fully in about seventy seconds and run
 * nightly. The four heavy ones are capped and spread across the week.
 *
 * ## Two known compromises, both fixed by later work
 *
 * **`limit` starves the tail.** `runAdapter` does `bindings.slice(0, limit)` —
 * always the *first* N counties. A limit of 40 on generic-county means counties
 * 41-154 are never crawled, not "crawled later". This is front-bias, not
 * sampling, and it is the clearest argument for driving jobs per-county from
 * `planScout` instead of sweeping per-adapter.
 *
 * **Adapter-wide sweeps ignore the calendar.** They re-fetch counties whose sale
 * is eight months away, which is exactly the shape `lib/scout/schedule.ts` was
 * written to replace. Interim measure: this is what can run today, against a
 * dispatcher that otherwise does nothing at all.
 *
 * Both go away when `planScout` feeds the queue; at that point the per-county
 * re-crawl interval (7d / 3d / 1d by proximity to sale) governs instead, and
 * these rows should be deleted rather than retuned.
 *
 * Idempotent: re-running updates intervals in place and never duplicates a row.
 *
 *   npx tsx scripts/seed-schedules.ts [--dry-run]
 */
import "../lib/env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { runSchedules } from "../lib/db/schema";

interface Plan {
  adapter: string;
  intervalMinutes: number;
  /** Counties per enqueue. Null sweeps every county the adapter serves. */
  limit: number | null;
  /** Days from now the first run is due, to stagger the heavy adapters. */
  firstDueInDays: number;
  note: string;
}

const DAY = 1440;

const PLANS: Plan[] = [
  // --- cheap enough to sweep whole, nightly (~71s combined) ----------------
  { adapter: "govease", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "31 counties, 0.14s each — trivial" },
  { adapter: "ga-counties", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "11 counties; GA sells first Tuesday monthly" },
  { adapter: "fl-clerks", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "8 clerk sources; RealAuction stays policy-blocked" },
  { adapter: "tx-mvba", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "7 counties" },
  { adapter: "nm-ptd", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "6 counties" },
  { adapter: "sri", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "2 counties" },
  { adapter: "mo-collector", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "1 county; MO sells in August" },
  { adapter: "clark-nv", intervalMinutes: DAY, limit: null, firstDueInDays: 0, note: "1 county" },

  // --- heavy: capped and spread, staggered so night one is not a pile-up ---
  {
    adapter: "ar-cosl",
    intervalMinutes: 3 * DAY,
    limit: null,
    firstDueInDays: 1,
    note: "46 counties, ~170s full sweep. Statewide COSL catalog, largest lot block in the system",
  },
  {
    adapter: "tx-lgbs",
    intervalMinutes: 7 * DAY,
    limit: 25,
    firstDueInDays: 2,
    note: "41 counties at 7.4s. Capped at 25 (~185s); counties 26-41 wait for planScout",
  },
  {
    adapter: "mi-taxsaleinfo",
    intervalMinutes: 7 * DAY,
    limit: 50,
    firstDueInDays: 4,
    note: "75 counties at 2.9s. Capped at 50 (~145s); counties 51-75 wait for planScout",
  },
  {
    /*
     * Capped hardest of the four, because it is the lowest-yield fetch on the
     * list: 154 counties discovered by pattern, most of which have never
     * produced a parcel. Arkansas keeps the shorter interval instead — it has
     * sales on 18, 19 and 25 August and 1 September and carries the largest
     * block of live inventory in the system, so freshness there is worth more
     * than breadth here.
     */
    adapter: "generic-county",
    intervalMinutes: 7 * DAY,
    limit: 20,
    firstDueInDays: 6,
    note: "154 counties, p90 20.6s and one run hit 270s. Capped at 20; the other 134 wait for planScout",
  },
];

function expectedDailySeconds(): number {
  // Rough: full-sweep seconds amortised over the interval. Only used to print
  // the headroom check, so the reviewer sees the budget rather than trusting it.
  const sweepSeconds: Record<string, number> = {
    govease: 4, "ga-counties": 14, "fl-clerks": 12, "tx-mvba": 19,
    "nm-ptd": 11, sri: 3, "mo-collector": 7, "clark-nv": 1,
    "ar-cosl": 170, "tx-lgbs": 185, "mi-taxsaleinfo": 145, "generic-county": 72,
  };
  return PLANS.reduce((total, p) => {
    const perRun = sweepSeconds[p.adapter] ?? 0;
    return total + perRun / (p.intervalMinutes / DAY);
  }, 0);
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const now = Date.now();

  const daily = Math.round(expectedDailySeconds());
  console.log(`expected ~${daily}s of crawl work per day against a 195s/day drain rate`);
  if (daily > 195) {
    console.warn(
      `WARNING: ${daily}s > 195s. The queue will grow without bound until the ` +
        `dispatcher ticks more than once a day. Lengthen an interval or raise the cadence.`,
    );
  }

  for (const p of PLANS) {
    const nextDueAt = new Date(now + p.firstDueInDays * 86_400_000);
    console.log(
      `${dry ? "[dry] " : ""}${p.adapter.padEnd(16)} every ${String(p.intervalMinutes / DAY).padStart(2)}d` +
        `  limit ${String(p.limit ?? "all").padStart(3)}  first due ${nextDueAt.toISOString().slice(0, 10)}`,
    );
    if (dry) continue;

    const [existing] = await db
      .select({ id: runSchedules.id })
      .from(runSchedules)
      .where(eq(runSchedules.adapter, p.adapter))
      .limit(1);

    if (existing) {
      // Re-running must not reset `nextDueAt` on a live schedule — that would
      // let a re-seed trigger every adapter at once.
      await db
        .update(runSchedules)
        .set({
          intervalMinutes: p.intervalMinutes,
          limit: p.limit,
          enabled: true,
          note: p.note,
          updatedAt: new Date(),
        })
        .where(eq(runSchedules.id, existing.id));
    } else {
      await db.insert(runSchedules).values({
        adapter: p.adapter,
        intervalMinutes: p.intervalMinutes,
        limit: p.limit,
        enabled: true,
        nextDueAt,
        note: p.note,
      });
    }
  }

  console.log(`\n${dry ? "would seed" : "seeded"} ${PLANS.length} schedule(s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
