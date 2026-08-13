import type { ReactNode } from "react";

/**
 * One table, driven by a column config.
 *
 * Every table in the console was hand-written — the same `overflow-x-auto`
 * wrapper, the same uppercase header row, the same `border-b border-border/50
 * last:border-0`, each copy free to drift. That is a tax on adding a surface,
 * and the tax is what stops surfaces being added.
 *
 * Built here for the label queue rather than by rewriting the tables that
 * already work. A refactor of working UI buys nothing a reader can see; what
 * matters is that the *next* table is a config rather than a page.
 *
 * Deliberately not editable. Inline editing needs a client component, a pending
 * state and an error surface per row, and the two things the console can edit —
 * auction corrections and source overrides — are already server-action forms
 * whose validation lives server-side. A generic editor would have to reproduce
 * that validation in the browser to be useful, which is how the two copies
 * start disagreeing.
 */

export interface AdminColumn<T> {
  key: string;
  header: string;
  /** Cell contents. Return a string for plain text, or a node for anything else. */
  cell: (row: T) => ReactNode;
  /** Right-aligns and applies tabular figures — use for anything counted. */
  numeric?: boolean;
  /** Tailwind width hint, e.g. "w-24". */
  width?: string;
}

export function AdminTable<T>({
  rows,
  columns,
  rowKey,
  empty = "Nothing to show.",
  minWidth = "36rem",
}: {
  rows: readonly T[];
  columns: readonly AdminColumn<T>[];
  rowKey: (row: T, index: number) => string;
  empty?: ReactNode;
  minWidth?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">{empty}</p>;
  }

  return (
    /*
     * The scroll container is the table's own, never the page's. A wide table
     * that scrolls the body sideways breaks every other panel on the screen.
     */
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`py-2 pr-3 font-semibold ${c.numeric ? "text-right" : ""} ${c.width ?? ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className="border-b border-border/50 align-top last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`py-2 pr-3 ${c.numeric ? "text-right tabular-nums" : ""}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
