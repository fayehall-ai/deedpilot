/**
 * What each calendar import did, kept so somebody can look it up later.
 *
 * ## Why this exists
 *
 * `importAuctionCsv` returned a report and nothing wrote it down. The console's
 * Server Action audited a summary of it, so a *browser* upload left a trace —
 * but the terminal path (`npm run import:apply`) recorded nothing at all, and
 * that is the path a large calendar actually arrives through. The eight-week
 * national calendar that populated this database was loaded from a script, and
 * afterwards the console could not say when it happened, from what file, or
 * what it changed. "When was the last import?" had no answer anywhere.
 *
 * So recording moved *into* `importAuctionCsv`, below both callers. A path that
 * can write auctions cannot now do it unobserved, which is the property that
 * was missing — an audit the caller has to remember to make is one a new caller
 * will forget.
 *
 * ## Why `admin_audit` rather than a new table
 *
 * `admin_audit` is already the operations log, already append-only, already
 * indexed on `created_at`, and its `detail` is `jsonb`. An `import_runs` table
 * would carry a migration and a second place to look for "what happened on this
 * console", and would buy querying nobody has asked for. The same reasoning the
 * schema applies to `auctions.raw` applies here: prose and per-stage tallies
 * that are displayed once and never summed do not need columns.
 *
 * The cost is that these keys are a shape rather than a schema, so
 * `readImportHistory` treats every field as absent-until-proven and renders
 * nothing where a value is missing. Rows written before this module existed
 * carry the older, flatter detail and still list — with their stages blank,
 * which is the truth about them.
 *
 * ## Why the stages are recorded separately
 *
 * `run.ts` already describes an import as three stages that "each fail
 * differently", and the operator's next move depends entirely on which one gave
 * up. A file with the wrong columns is a wrong-file problem; forty unreadable
 * dates is a formatting problem; four unresolved counties is a coverage
 * problem. Collapsing those into `rejected: 44` throws away the diagnosis and
 * leaves a person to re-run the import to find out what it was.
 */

import { desc, inArray } from "drizzle-orm";
import { db } from "../db";
import { adminAudit } from "../db/schema";

/** How the file reached the importer. */
/** `drive`: picked up from CAPE/Auction Scout on Drive by the Sunday CAPE run. */
export type ImportVia = "console" | "cli" | "drive";

/** Where an import came from and who asked for it. */
export interface ImportContext {
  /** File name for an upload, path for a script run. */
  source: string;
  via: ImportVia;
  /** Byte size of the file, when the caller knows it. */
  bytes?: number;
  actor?: string;
}

/**
 * Per-stage tallies, in the order the stages run.
 *
 * Every number is a count of *rows*, except `read.columns`. `read.rows` counts
 * data rows in the file including the blank trailing ones, so
 * `read.rows - read.blank` is what the later stages were handed.
 */
export interface ImportStages {
  read: { columns: number; rows: number; blank: number };
  translate: { parsed: number; rejected: number };
  resolve: { resolved: number; viaParent: number; rejected: number };
  write: {
    inserted: number;
    updated: number;
    merged: number;
    duplicateInFile: number;
    ambiguous: number;
  };
}

export interface ImportRecord {
  id: string;
  at: Date;
  /** False when the file was refused before any stage ran. */
  ok: boolean;
  source: string;
  via: ImportVia | null;
  actor: string;
  bytes: number | null;
  /** Absent on a refused file, and on rows written before this module existed. */
  stages: ImportStages | null;
  dateRange: { from: string; to: string } | null;
  counties: number | null;
  durationMs: number | null;
  /** Why the file was refused. Only set when `ok` is false. */
  error: string | null;
  /** A sample of the rows that did not import, for fixing the file. */
  rejects: { line: number; label: string; problem: string }[];
  /** How many rows did not import in total — `rejects` may be a prefix. */
  rejectedTotal: number;
}

/**
 * How many rejected rows travel with the record.
 *
 * Enough to fix a file in one pass without re-running the import, and few
 * enough that a pathological upload — every row rejected — cannot write a
 * multi-megabyte audit row. The total is stored separately so the panel can say
 * how many were not listed rather than implying these were all of them.
 */
const REJECT_SAMPLE = 40;

export const IMPORT_ACTIONS = ["import.applied", "import.rejected"] as const;

/** Record a completed import. Never throws — see `recordSafely`. */
export async function recordImport(
  ctx: ImportContext,
  stages: ImportStages,
  extra: {
    dateRange: { from: string; to: string } | null;
    counties: number;
    durationMs: number;
    rejects: { line: number; label: string; problem: string }[];
  },
): Promise<void> {
  await db.insert(adminAudit).values({
    action: "import.applied",
    target: ctx.source,
    actor: ctx.actor ?? (ctx.via === "cli" ? "cli" : "admin"),
    detail: {
      via: ctx.via,
      bytes: ctx.bytes ?? null,
      stages,
      dateRange: extra.dateRange,
      counties: extra.counties,
      durationMs: extra.durationMs,
      rejectedTotal: extra.rejects.length,
      rejects: extra.rejects.slice(0, REJECT_SAMPLE),
    },
  });
}

/** Record a file that was refused before anything was written. */
export async function recordImportRejected(
  ctx: ImportContext,
  error: string,
): Promise<void> {
  await db.insert(adminAudit).values({
    action: "import.rejected",
    target: ctx.source,
    actor: ctx.actor ?? (ctx.via === "cli" ? "cli" : "admin"),
    detail: { via: ctx.via, bytes: ctx.bytes ?? null, error },
  });
}

/**
 * Recording must never be the reason an import fails.
 *
 * The rows are already committed by the time this runs. Throwing here would
 * report a failure for work that succeeded, and the operator's recovery — run
 * it again — would be the wrong move on an import that had already landed.
 */
export async function recordSafely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("[import] could not write history:", e);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Stages, if this row has them.
 *
 * Returns null rather than a zero-filled shape for a row written before the
 * stages existed: zeroes would render as an import that read nothing and wrote
 * nothing, which is a false statement about a real import.
 */
function readStages(d: Record<string, unknown>): ImportStages | null {
  const s = obj(d.stages);
  if (Object.keys(s).length === 0) return null;
  const r = obj(s.read), t = obj(s.translate), rs = obj(s.resolve), w = obj(s.write);
  return {
    read: { columns: num(r.columns) ?? 0, rows: num(r.rows) ?? 0, blank: num(r.blank) ?? 0 },
    translate: { parsed: num(t.parsed) ?? 0, rejected: num(t.rejected) ?? 0 },
    resolve: {
      resolved: num(rs.resolved) ?? 0,
      viaParent: num(rs.viaParent) ?? 0,
      rejected: num(rs.rejected) ?? 0,
    },
    write: {
      inserted: num(w.inserted) ?? 0,
      updated: num(w.updated) ?? 0,
      merged: num(w.merged) ?? 0,
      duplicateInFile: num(w.duplicateInFile) ?? 0,
      ambiguous: num(w.ambiguous) ?? 0,
    },
  };
}

function readRejects(v: unknown): { line: number; label: string; problem: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw) => {
    const r = obj(raw);
    const line = num(r.line);
    if (line === null) return [];
    return [{ line, label: str(r.label) ?? "—", problem: str(r.problem) ?? "" }];
  });
}

/**
 * The most recent imports, newest first.
 *
 * Reads both actions together so a refused file appears in the history at the
 * position it happened. An operator who uploaded the wrong export and saw an
 * error needs that visible next to the import before it — otherwise the log
 * shows a quiet gap where a person was actively trying something.
 */
export async function readImportHistory(limit = 20): Promise<ImportRecord[]> {
  const rows = await db
    .select()
    .from(adminAudit)
    .where(inArray(adminAudit.action, [...IMPORT_ACTIONS]))
    .orderBy(desc(adminAudit.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const d = obj(row.detail);
    const via = str(d.via);
    const rejects = readRejects(d.rejects);
    return {
      id: row.id,
      at: row.createdAt,
      ok: row.action === "import.applied",
      source: row.target ?? "—",
      via: via === "console" || via === "cli" || via === "drive" ? via : null,
      actor: row.actor,
      bytes: num(d.bytes),
      stages: readStages(d),
      dateRange: (() => {
        const r = obj(d.dateRange);
        const from = str(r.from), to = str(r.to);
        return from && to ? { from, to } : null;
      })(),
      counties: num(d.counties),
      durationMs: num(d.durationMs),
      error: str(d.error),
      rejects,
      rejectedTotal: num(d.rejectedTotal) ?? rejects.length,
    };
  });
}
