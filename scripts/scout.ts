/**
 * Auction Scout CLI — calendar-driven crawling.
 *
 *   npm run scout -- --plan                      # today's queue, no crawling
 *   npm run scout -- --plan --date 2026-09-01    # what would run on a date
 *   npm run scout -- --plan --backlog            # counties with a source, no parser
 *   npm run scout -- --dry-run --max 5           # crawl and judge, write nothing
 *   npm run scout -- --max 20                    # for real
 *
 * `--plan` touches neither the network nor the database, which makes it the
 * right thing to look at before letting this loose on government servers.
 */
import "../lib/env";
import { readFileSync } from "node:fs";
import { ALL_COUNTIES } from "../lib/atlas";
import { calendarCoverage } from "../lib/atlas/calendar";
import { planScoutRun, runScout } from "../lib/scout";
import type { SourceRegistry } from "../lib/prospector/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function loadRegistry(): SourceRegistry | undefined {
  const path = arg("registry") ?? "data/source-registry.json";
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SourceRegistry;
  } catch {
    console.warn(
      `[scout] no source registry at ${path} — counties without an adapter will ` +
        `report as 'no_source' rather than as an adapter backlog. Build one with the Prospector.`,
    );
    return undefined;
  }
}

async function main() {
  const on = arg("date") ? new Date(`${arg("date")}T00:00:00Z`) : new Date();
  const maxTasks = arg("max") ? Number(arg("max")) : undefined;
  const stateFilter = arg("state")?.toUpperCase();

  const fipsList = ALL_COUNTIES.filter((c) => !stateFilter || c.state === stateFilter).map(
    (c) => c.fips,
  );

  const registry = loadRegistry();
  const opts = { fipsList, registry, on, maxTasks };

  if (flag("plan")) {
    const plan = await planScoutRun(opts);
    const cov = plan.coverage;
    console.log(`\nScout plan for ${plan.date}${stateFilter ? ` (${stateFilter})` : ""}`);
    console.log(
      `  due today ${cov.dueToday} | runnable ${cov.runnable} | ` +
        `no adapter ${cov.noAdapter} | no source ${cov.noSource} | backed off ${cov.backedOff}`,
    );

    console.log("\n  top of queue:");
    for (const t of plan.tasks.slice(0, 15)) {
      console.log(
        `    ${t.fips} ${t.state} ${t.kind.padEnd(7)} p=${String(t.priority).padStart(3)} ` +
          `${t.adapter} — ${t.reason}`,
      );
    }
    if (plan.tasks.length > 15) console.log(`    … and ${plan.tasks.length - 15} more`);

    if (flag("backlog")) {
      const { adapterBacklog } = await import("../lib/scout/schedule");
      const backlog = adapterBacklog(plan);
      console.log(`\n  adapter backlog (${backlog.length} counties with a live source, no parser):`);
      for (const b of backlog.slice(0, 25)) console.log(`    ${b.fips} ${b.state}  ${b.url}`);
    }

    const cal = calendarCoverage();
    console.log(
      `\n  calendar: ${cal.statesWithSchedule} states scheduled ` +
        `(${cal.byConfidence.statutory} statutory, ${cal.byConfidence.typical} typical), ` +
        `${cal.statesUnresearched} unresearched\n`,
    );
    return;
  }

  const result = await runScout({
    ...opts,
    dryRun: flag("dry-run"),
    onProgress: (m) => console.log(m),
  });

  const t = result.totals;
  console.log(
    `\nScout ${result.plan.date}: attempted ${t.attempted}, ok ${t.ok}, failed ${t.failed}, ` +
      `blocked ${t.blocked}`,
  );
  console.log(
    `  auctions ${t.auctions}, lots ${t.lots}, rejected ${t.rejected}, repaired ${t.repaired}`,
  );
  if (result.backlog.length) {
    console.log(`  adapter backlog: ${result.backlog.length} counties — run with --plan --backlog`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
