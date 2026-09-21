/**
 * Coverage meta-controller — one cycle of the self-improving national loop.
 *
 *   npm run flywheel:coverage -- --plan          # scoreboard + ranked work (no side effects)
 *   npm run flywheel:coverage -- --cycle         # plan + execute safe actions
 *   npm run flywheel:coverage -- --purge-skeletons
 *   npm run flywheel:coverage -- --enrich-mi [--limit N]
 *
 * High-stakes artifacts (statutes, label rules) are never auto-merged.
 * See docs/self-improving-coverage-loop.md.
 */

import "../lib/env";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isSkeletonAuction } from "../lib/db/inventory";
import { db } from "../lib/db";
import { auctions } from "../lib/db/schema";
import { buildCoverageScoreboard, type CoverageScoreboard } from "../lib/coverage/scoreboard";
import { runEnrichment } from "../lib/ingest/runner";
import { getAdapter } from "../lib/ingest/adapters";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function writeScoreboard(board: CoverageScoreboard): Promise<string> {
  const dir = join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "coverage-scoreboard.json");
  await writeFile(path, JSON.stringify(board, null, 2));
  return path;
}

async function purgeSkeletons(dryRun: boolean): Promise<{ deleted: number }> {
  const today = todayIso();
  const rows = await db
    .select({ id: auctions.id, countyFips: auctions.countyFips, saleDate: auctions.saleDate })
    .from(auctions)
    .where(isSkeletonAuction(today));

  console.log(`Found ${rows.length} skeleton auction(s) — see isSkeletonAuction`);
  if (dryRun || rows.length === 0) return { deleted: 0 };

  // Cascades to lots (none) and related rows.
  await db.delete(auctions).where(isSkeletonAuction(today));
  return { deleted: rows.length };
}

async function enrichMi(limit?: number): Promise<void> {
  const adapter = getAdapter("mi-taxsaleinfo");
  if (!adapter?.enrichLot) {
    console.error("mi-taxsaleinfo adapter missing enrichLot");
    process.exit(1);
  }
  const s = await runEnrichment(adapter, {
    limit: limit ?? 200,
    onProgress: (m) => console.log(m),
  });
  console.log(`\n=== MI enrichment ===`);
  console.log(`attempted: ${s.attempted}`);
  console.log(`enriched:  ${s.enriched}`);
  console.log(`gone:      ${s.gone}`);
  console.log(`failed:    ${s.failed}`);
}

function printPlan(board: CoverageScoreboard): void {
  console.log("\n=== GOLD SCORE ===");
  console.log(
    `score=${board.gold.score}  live=${board.gold.liveShare}  history=${board.gold.historyShare}  price=${board.gold.priceShare}  penalties=${board.gold.penalties}`,
  );
  console.log("\n=== LIVE ===");
  console.log(
    `auctions_with_lots=${board.live.upcomingAuctionsWithLots}  skeletons=${board.live.skeletonAuctions}  lots=${board.live.totalLotsUpcoming}  assessed=${board.live.lotsWithAssessed}  auto_priceable=${board.live.lotsAutoPriceable}`,
  );
  console.log(
    `states_with_lots=${board.live.statesWithLots}  counties_with_lots=${board.live.countiesWithLots}`,
  );
  for (const s of board.live.byState.slice(0, 12)) {
    console.log(
      `  ${s.state}: lots=${s.lots} assessed=${s.withAssessed} auto=${s.autoPriceable} counties=${s.counties}`,
    );
  }
  console.log("\n=== STATUTE ===");
  console.log(
    `${board.statute.nStates} priceable: ${board.statute.statesWithParams.join(", ")}`,
  );
  console.log(`missing (${board.statute.nMissing}): ${board.statute.missingStates.slice(0, 20).join(", ")}…`);
  console.log("\n=== HISTORY ===");
  console.log(
    `rows=${board.history.nRows} price_usable=${board.history.nPriceUsable} states=${board.history.statesWithPriceUsable.join(",") || "—"}`,
  );
  console.log("\n=== REGISTRY ===");
  console.log(
    `counties=${board.registry.nCounties} verified=${board.registry.nVerified} listing=${board.registry.nListing} results=${board.registry.nResults}`,
  );
  console.log("\n=== BUDGET SHARES ===");
  console.log(board.budgetShares);
  console.log("\n=== WORK PLAN (top 15) ===");
  for (const [i, w] of board.workPlan.slice(0, 15).entries()) {
    console.log(
      `${String(i + 1).padStart(2)}. [${w.class}] p=${w.priority.toFixed(1)}  ${w.title}`,
    );
    console.log(`    ${w.reason}`);
  }
}

/**
 * Execute only *safe* work-plan items. Statutes (D) and label rules (C import)
 * are reported as blocked_on_humans, never auto-merged.
 */
async function executeSafeActions(
  board: CoverageScoreboard,
  opts: { dryRun: boolean; enrichLimit: number },
): Promise<{
  actions: string[];
  blockedOnHumans: string[];
}> {
  const actions: string[] = [];
  const blockedOnHumans: string[] = [];

  // Class E first (cheap, immediate honesty), then A enrich, then notes.
  const ordered = [
    ...board.workPlan.filter((i) => i.class === "E"),
    ...board.workPlan.filter((i) => i.class === "A"),
    ...board.workPlan.filter((i) => i.class !== "E" && i.class !== "A"),
  ];

  let purged = false;
  let miEnriched = false;

  for (const item of ordered) {
    if (item.class === "D") {
      blockedOnHumans.push(`${item.title} — cartographer draft requires human PR`);
      continue;
    }
    if (item.class === "C") {
      blockedOnHumans.push(`${item.title} — label rules / archivist require human semantics`);
      continue;
    }
    if (item.class === "E" && item.title.toLowerCase().includes("skeleton") && !purged) {
      purged = true;
      if (opts.dryRun) {
        actions.push(`[dry-run] would purge skeletons (${board.live.skeletonAuctions})`);
      } else {
        const r = await purgeSkeletons(false);
        actions.push(`purged ${r.deleted} skeleton auction(s)`);
      }
      continue;
    }
    if (item.class === "A" && item.target?.adapter === "mi-taxsaleinfo" && !miEnriched) {
      miEnriched = true;
      // CLI --limit wins over plan suggestion so operators can throttle.
      const limit = opts.enrichLimit || item.target.limit || 200;
      if (opts.dryRun) {
        actions.push(`[dry-run] would enrich MI SEV (limit ${limit})`);
      } else {
        console.log(`\n--- Executing: ${item.title} (limit ${limit}) ---`);
        await enrichMi(limit);
        actions.push(`MI enrich attempted (limit ${limit})`);
      }
      continue;
    }
    if (item.class === "B") {
      blockedOnHumans.push(
        `${item.title} — prospector/scout expansion not auto-run in cycle (use npm run prospect / scout)`,
      );
      continue;
    }
    if (item.class === "A" && !(item.target?.adapter === "mi-taxsaleinfo")) {
      actions.push(`noted: ${item.title} (no auto executor yet)`);
    }
  }

  return { actions, blockedOnHumans };
}

async function main() {
  const planOnly = flag("plan") || (!flag("cycle") && !flag("purge-skeletons") && !flag("enrich-mi"));
  const dryRun = flag("dry-run");
  const limitRaw = arg("limit");
  const enrichLimit = limitRaw ? Number(limitRaw) : 200;

  if (flag("purge-skeletons")) {
    const r = await purgeSkeletons(dryRun);
    console.log(dryRun ? `(dry-run) would delete skeletons` : `deleted ${r.deleted}`);
    process.exit(0);
  }

  if (flag("enrich-mi") && !flag("cycle")) {
    await enrichMi(enrichLimit);
    // Refresh scoreboard after enrich
    const board = await buildCoverageScoreboard();
    const path = await writeScoreboard(board);
    console.log(`scoreboard → ${path}  gold=${board.gold.score}`);
    process.exit(0);
  }

  console.log("Building coverage scoreboard…");
  let board = await buildCoverageScoreboard();
  let path = await writeScoreboard(board);
  console.log(`Wrote ${path}`);
  printPlan(board);

  if (planOnly && !flag("cycle")) {
    console.log("\n(plan only — pass --cycle to execute safe actions)");
    process.exit(0);
  }

  console.log("\n=== EXECUTING SAFE ACTIONS ===");
  const { actions, blockedOnHumans } = await executeSafeActions(board, {
    dryRun,
    enrichLimit,
  });
  for (const a of actions) console.log(`  ✓ ${a}`);
  console.log("\n=== BLOCKED ON HUMANS ===");
  for (const b of blockedOnHumans.slice(0, 20)) console.log(`  • ${b}`);

  // Re-score after actions
  board = await buildCoverageScoreboard();
  path = await writeScoreboard(board);
  console.log(`\nPost-cycle gold=${board.gold.score}  scoreboard → ${path}`);
  console.log(
    `auto_priceable=${board.live.lotsAutoPriceable}/${board.live.totalLotsUpcoming}  skeletons=${board.live.skeletonAuctions}`,
  );

  // Persist cycle report
  const reportPath = join(process.cwd(), "data", "coverage-cycle-latest.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        gold: board.gold,
        actions,
        blockedOnHumans,
        live: board.live,
      },
      null,
      2,
    ),
  );
  console.log(`cycle report → ${reportPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
