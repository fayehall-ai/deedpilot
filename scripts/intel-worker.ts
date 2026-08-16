/**
 * The background intel loop.
 *
 *   npm run intel:worker                    # run until stopped
 *   npm run intel:worker -- --once          # one pass, for cron or a check
 *   npm run intel:worker -- --state AR --batch 10
 *   npm run intel:worker -- --source fema   # one source, e.g. a fast backfill
 *   npm run intel:status                    # what it has covered so far
 *
 * ## Why a long-running process and not a cron
 *
 * The dispatcher in `app/api/cron/dispatch/route.ts` runs once a day, because
 * a Vercel Hobby account rejects any cron more frequent than that at *build*
 * time. One tick a day is enough for ingest, where a county's sale list changes
 * weekly at most. It is nowhere near enough here: Overpass needs tens of
 * seconds per parcel, there are thousands of parcels, and the work is
 * open-ended by nature.
 *
 * So this is a plain process that claims work, does it, and sleeps. It runs
 * anywhere something can stay running — a laptop under launchd, a container, a
 * VM — and it needs nothing from the platform except the database URL. See
 * `docs/intel-loop.md` for the launchd unit.
 *
 * ## Why it paces itself
 *
 * Every source here is a free public service run by a government agency or a
 * volunteer project, and none of them are being paid to answer us. `lib/ingest/
 * policy.ts` already treats politeness as architecture rather than manners;
 * this holds the same line. The delay between parcels is deliberate and is not
 * a tuning knob to be turned to zero.
 */

import "../lib/env";
import { enrichLotIntel } from "../lib/property/signals";
import { intelCoverage, planIntelWork } from "../lib/property/signals/scheduler";
import { configuredSignalSources } from "../lib/property/signals";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds between parcels. See the note on pacing above. */
const PARCEL_DELAY_MS = Number(arg("delay") ?? 3_000);
/** How long to wait when there is nothing to do before asking again. */
const IDLE_DELAY_MS = 60_000;

/*
 * Shut down on the parcel boundary rather than mid-fetch.
 *
 * A SIGTERM in the middle of a source's write would leave `lot_signals` half
 * replaced with no ledger row to say so — the parcel would look enriched and be
 * missing half its features. Finishing the parcel in hand costs a few seconds
 * and makes every stop clean.
 */
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // A second one means they mean it.
    stopping = true;
    console.log(`\n${sig} — finishing the parcel in hand, then stopping.`);
  });
}

async function status() {
  const rows = await intelCoverage();
  console.log("\nIntel coverage — confirmed sale-list inventory with coordinates\n");
  console.table(
    rows.map((r) => ({
      source: r.source,
      "found something": r.ok,
      "checked, nothing there": r.empty,
      failed: r.failed,
      "blocked (no coords)": r.skipped,
      "never asked": r.never,
    })),
  );
  const sources = configuredSignalSources().map((s) => `${s.name} (${s.ttlDays}d)`);
  console.log(`Sources configured: ${sources.join(", ") || "none"}`);
  if (!process.env.CENSUS_API_KEY) {
    console.log(
      "\nCENSUS_API_KEY is not set, so neighborhood signals are skipped.\n" +
        "  Free, instant: https://api.census.gov/data/key_signup.html",
    );
  }
}

async function pass(): Promise<number> {
  const tasks = await planIntelWork({
    limit: Number(arg("batch") ?? 20),
    state: arg("state"),
    source: arg("source"),
    includeNonInventory: flag("include-non-inventory"),
  });

  if (tasks.length === 0) return 0;

  /*
   * Grouped by parcel so one parcel's sources run together. The alternative —
   * strict priority order across the whole list — would interleave four
   * different parcels and leave every one of them half enriched for as long as
   * the loop ran, which is the state that reads worst on the page.
   */
  const byLot = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const list = byLot.get(t.lotId) ?? [];
    list.push(t);
    byLot.set(t.lotId, list);
  }

  let done = 0;
  for (const [lotId, lotTasks] of byLot) {
    if (stopping) break;

    const head = lotTasks[0];
    const wanted = new Set(lotTasks.map((t) => t.source));
    const sources = configuredSignalSources().filter((s) => wanted.has(s.name));

    console.log(
      `\n▸ ${head.label}\n  ${head.why} · priority ${Math.round(head.priority)} · ` +
        `${[...wanted].join(", ")}`,
    );

    const result = await enrichLotIntel(lotId, {
      sources,
      onProgress: (m) => console.log(m),
    });

    if (result.skipped) console.log(`  skipped: ${result.skipped}`);
    else console.log(`  ${result.totalSignals} signal(s) recorded`);

    done++;
    await sleep(PARCEL_DELAY_MS);
  }

  return done;
}

async function main() {
  if (flag("status")) {
    await status();
    return;
  }

  const sources = configuredSignalSources();
  console.log(
    `Intel worker starting. Sources: ${sources.map((s) => s.name).join(", ")}. ` +
      `${PARCEL_DELAY_MS}ms between parcels.`,
  );

  if (flag("once")) {
    const n = await pass();
    console.log(`\nOne pass: ${n} parcel(s).`);
    return;
  }

  let idle = 0;
  while (!stopping) {
    const n = await pass();
    if (n === 0) {
      idle++;
      /*
       * Nothing due is the normal steady state, not an error — it means every
       * parcel in confirmed inventory has been asked and nothing has expired
       * yet. Announced once rather than every minute, so the log stays readable
       * over days.
       */
      if (idle === 1) {
        console.log(
          `\nNothing due. Waiting — new sale lists and expiring TTLs will bring work back.`,
        );
      }
      await sleep(IDLE_DELAY_MS);
    } else {
      idle = 0;
    }
  }

  console.log("Stopped cleanly.");
}

/*
 * Explicit exit, matching the other CLI scripts. `lib/db` holds a long-lived
 * pool with no close on it, which keeps a finished process alive forever.
 */
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
