/*
 * No `server-only` guard, matching `lib/admin/queue.ts`, `lib/ingest/runner.ts`
 * and `lib/admin/plan-jobs.ts` rather than the console-facing modules.
 *
 * An importer is genuinely useful from a terminal — running a calendar in
 * headlessly, or checking what a file would do before anyone clicks anything,
 * is the main way to tell whether an import is sane — and `server-only` throws
 * under plain tsx. The Server Action that wraps this is where the cookie is
 * checked; the guard here was belt-and-braces, and it cost the ability to run
 * the thing from a script or a cron.
 */
import { CsvTable, parseCsv } from "./csv";
import { REQUIRED_COLUMNS, readRow, type ImportedAuction } from "./auction-rows";
import { applyImport, resolveCounties, type ImportReport, type RejectedRow } from "./apply";

/**
 * A whole upload, from file text to a report.
 *
 * The three stages are kept separate — read the grammar, translate the rows,
 * write what resolved — because each fails differently and the operator needs
 * to be told which one gave up. A file with the wrong columns is a different
 * problem from a file with three unreadable dates, and both are different from
 * a file whose counties do not exist.
 */

/** Thrown when the file is not this format at all. Nothing is written. */
export class UnreadableFile extends Error {}

export async function importAuctionCsv(text: string): Promise<ImportReport> {
  const table = new CsvTable(parseCsv(text));

  if (table.headers.length === 0) {
    throw new UnreadableFile("The file is empty.");
  }
  const missing = table.missing(REQUIRED_COLUMNS);
  if (missing.length > 0) {
    /*
     * Refused whole rather than imported partially. Missing columns almost
     * always mean the wrong file, and a partial import of the wrong file leaves
     * rows on the calendar that nobody meant to add and that no re-upload of
     * the right file will clean up.
     */
    throw new UnreadableFile(
      `Not an auction export — missing ${missing.map((m) => `"${m}"`).join(", ")}. ` +
        `Found: ${table.headers.slice(0, 12).join(", ")}${table.headers.length > 12 ? "…" : ""}`,
    );
  }

  const parsed: { row: ImportedAuction; line: number }[] = [];
  const rejected: RejectedRow[] = [];

  table.rows.forEach((cells, i) => {
    // The header is line 1, so the first data row is line 2 — which is what a
    // spreadsheet shows the operator when they go to look at it.
    const line = i + 2;

    // A row of empty cells is what a trailing blank line in a spreadsheet
    // looks like. Skipping it silently is right; reporting it as an error
    // would put a scary number on every export that ends with a newline.
    if (cells.every((c) => c.trim() === "")) return;

    const outcome = readRow(
      {
        cell: (name) => table.cell(cells, name),
        all: () => Object.fromEntries(table.headers.map((h, j) => [h, cells[j] ?? ""])),
      },
      line,
    );

    if (outcome.ok) parsed.push({ row: outcome.value, line });
    else {
      rejected.push({
        line,
        label: `${table.cell(cells, "County")}, ${table.cell(cells, "State")}`.trim(),
        problem: outcome.problem,
      });
    }
  });

  const { resolved, rejected: unresolved } = await resolveCounties(parsed);
  const written = await applyImport(resolved, table.rows.length);

  return { ...written, rejected: [...rejected, ...unresolved].sort((a, b) => a.line - b.line) };
}
