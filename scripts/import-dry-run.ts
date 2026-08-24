/**
 * Import a sale calendar without writing anything.
 * Run: npx tsx scripts/import-dry-run.ts data/leads/auctions_next_8_weeks.csv
 *
 * Every stage of the real import except the writes: the file is parsed, each
 * row is translated, counties are resolved against the live reference table,
 * and the de-duplication plan is computed against the auctions actually in the
 * database. What it prints is the report the console would show, plus a
 * breakdown of anything that did not resolve.
 *
 * The point is to see what an upload *would* do to production before it does
 * it. Nothing here opens a transaction, and the only queries are reads.
 */

import "../lib/env";
import { readFileSync } from "node:fs";
import { and, gte, inArray, lte } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties } from "../lib/db/schema";
import { CsvTable, parseCsv } from "../lib/import/csv";
import { REQUIRED_COLUMNS, readRow, type ImportedAuction } from "../lib/import/auction-rows";
import { CountyIndex, describeFailure, type CountyRef } from "../lib/import/counties";
import { planImport, type ExistingAuction } from "../lib/import/plan";
import type { ResolvedAuction } from "../lib/import/apply";
import { resolveSourceUrl } from "../lib/import/source-url";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx scripts/import-dry-run.ts <file.csv>");
    process.exit(1);
  }

  const table = new CsvTable(parseCsv(readFileSync(path, "utf8")));
  const missing = table.missing(REQUIRED_COLUMNS);
  if (missing.length > 0) {
    console.error(`Not an auction export — missing ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`file      ${path}`);
  console.log(`columns   ${table.headers.length}`);
  console.log(`rows      ${table.rows.length}`);

  // ---- translate --------------------------------------------------------------

  const parsed: { row: ImportedAuction; line: number }[] = [];
  const rejected: { line: number; label: string; problem: string }[] = [];

  table.rows.forEach((cells, i) => {
    const line = i + 2;
    if (cells.every((c) => c.trim() === "")) return;
    const outcome = readRow(
      {
        cell: (name) => table.cell(cells, name),
        all: () => Object.fromEntries(table.headers.map((h, j) => [h, cells[j] ?? ""])),
      },
      line,
    );
    if (outcome.ok) parsed.push({ row: outcome.value, line });
    else
      rejected.push({
        line,
        label: `${table.cell(cells, "County")}, ${table.cell(cells, "State")}`,
        problem: outcome.problem,
      });
  });

  console.log(`parsed    ${parsed.length}`);

  // ---- resolve counties -------------------------------------------------------

  const refs: CountyRef[] = await db
    .select({
      fips: counties.fips,
      name: counties.name,
      state: counties.state,
      stateName: counties.stateName,
    })
    .from(counties);
  const index = new CountyIndex(refs);
  const byFips = new Map(refs.map((r) => [r.fips, r]));

  const resolved: ResolvedAuction[] = [];
  let municipal = 0;
  for (const { row, line } of parsed) {
    const m = index.resolve(row.stateLabel, row.countyLabel);
    if (m.ok) {
      const title =
        m.via === "parent" && m.municipality
          ? [m.municipality, row.title].filter(Boolean).join(" — ")
          : row.title;
      const ref = byFips.get(m.fips);
      const sourceUrl = resolveSourceUrl({
        countyFips: m.fips,
        state: ref?.state ?? row.stateLabel,
        countyName: ref?.name ?? row.countyLabel,
        raw: row.raw,
      }).url;
      resolved.push({ ...row, title, countyFips: m.fips, line, sourceUrl });
      if (m.via === "parent") municipal++;
    }
    else
      rejected.push({
        line,
        label: `${row.countyLabel}, ${row.stateLabel}`,
        problem: describeFailure(m.reason),
      });
  }
  console.log(`resolved  ${resolved.length}` + (municipal ? `  (${municipal} municipal, filed under the parent county)` : ""));

  if (resolved.length === 0) {
    console.log("\nnothing to plan");
    process.exit(0);
  }

  // ---- plan against what is really in the database ----------------------------

  const dates = resolved.map((r) => r.saleDate).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  const fipsList = [...new Set(resolved.map((r) => r.countyFips))];

  const existing: ExistingAuction[] = await db
    .select({
      id: auctions.id,
      countyFips: auctions.countyFips,
      saleDate: auctions.saleDate,
      externalId: auctions.externalId,
    })
    .from(auctions)
    .where(
      and(
        inArray(auctions.countyFips, fipsList),
        gte(auctions.saleDate, from),
        lte(auctions.saleDate, to),
      ),
    );

  const plan = planImport(resolved, existing);
  const tally = plan.decisions.reduce<Record<string, number>>((acc, d) => {
    acc[d.kind] = (acc[d.kind] ?? 0) + 1;
    return acc;
  }, {});

  console.log("");
  console.log(`dates     ${from} → ${to}`);
  console.log(`counties  ${fipsList.length}`);
  console.log(`existing  ${existing.length} auction(s) already held in that county/date window`);
  console.log("");
  console.log("WOULD DO");
  console.log(`  insert            ${tally.insert ?? 0}`);
  console.log(`  update            ${tally.update ?? 0}   (rows a previous upload created)`);
  console.log(`  merge             ${tally.merge ?? 0}   (into an auction already crawled)`);
  console.log(`  duplicate in file ${tally.duplicate_in_file ?? 0}`);
  console.log(`  not imported      ${rejected.length}`);

  // ---- what a person has to look at -------------------------------------------

  if (rejected.length > 0) {
    console.log("\nNOT IMPORTED");
    const byProblem = new Map<string, { line: number; label: string }[]>();
    for (const r of rejected) {
      // Group by the shape of the problem, not its exact text, so 40 unmatched
      // counties read as one class of failure rather than 40 unrelated lines.
      const kind = r.problem.replace(/"[^"]*"/g, "…");
      const list = byProblem.get(kind);
      if (list) list.push(r);
      else byProblem.set(kind, [r]);
    }
    for (const [kind, rows] of [...byProblem].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${rows.length}× ${kind}`);
      for (const r of rows.slice(0, 8)) console.log(`      line ${r.line}: ${r.label}`);
      if (rows.length > 8) console.log(`      … and ${rows.length - 8} more`);
    }
  }

  if (plan.ambiguous.length > 0) {
    console.log("\nAMBIGUOUS — inserted, not merged, for a person to judge");
    for (const a of plan.ambiguous) {
      console.log(
        `  ${a.countyLabel} on ${a.saleDate}: ${a.existing} already held, ${a.imported} in the file`,
      );
    }
  }

  // ---- what the calendar would gain -------------------------------------------

  const inserts = plan.decisions.filter((d) => d.kind === "insert");
  const parcels = inserts.reduce((n, d) => n + (d.row.announcedParcelCount ?? 0), 0);
  const noCount = inserts.filter((d) => !d.row.announcedParcelCount).length;
  console.log("");
  console.log(`announced parcels on new rows: ${parcels.toLocaleString()}`);
  console.log(
    `new rows with no parcel count:  ${noCount}` +
      (noCount > 0 ? "  ← these stay off the calendar until a crawl finds parcels" : ""),
  );

  const byType = inserts.reduce<Record<string, number>>((acc, d) => {
    acc[d.row.saleType] = (acc[d.row.saleType] ?? 0) + 1;
    return acc;
  }, {});
  const byPlatform = inserts.reduce<Record<string, number>>((acc, d) => {
    acc[d.row.platform] = (acc[d.row.platform] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`sale types:  ${JSON.stringify(byType)}`);
  console.log(`platforms:   ${JSON.stringify(byPlatform)}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
