import type { ReactNode } from "react";

/**
 * One numbered stage of the pipeline, collapsed to a line you can scan.
 *
 * Borrowed wholesale from the CAPE board, which had already solved this: ten
 * components in a fixed order, each collapsed to a title and a state, ranked by
 * what it holds back, expanding to item-level detail only when asked. That page
 * carries far more information than the console did and reads in seconds,
 * because nothing is open that you did not open.
 *
 * The console had fourteen peer sections, no hierarchy, and the same controls in
 * two places — Run now and Schedules each appeared twice. Everything was
 * expanded, so nothing was emphasised, and "what needs me?" could only be
 * answered by reading all of it.
 *
 * ## The state chip is the whole point
 *
 * CAPE's insight is not the numbering, it is that every item resolves to one of
 * three states rather than a boolean. `ok` needs nothing. `attention` is work
 * this system can do and hasn't. `blocked` needs a person — a statute reviewed,
 * a rule written, a plan purchased. Collapsing "not done" into one state would
 * put a crawl that will run tonight next to a decision only Faye can make.
 */

export type StageState = "ok" | "attention" | "blocked";

const CHIP: Record<StageState, { cls: string; label: string }> = {
  ok: { cls: "bg-surface-2 text-muted", label: "ok" },
  attention: { cls: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200", label: "needs a run" },
  blocked: { cls: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200", label: "needs you" },
};

export function Stage({
  n,
  title,
  question,
  state = "ok",
  summary,
  defaultOpen = false,
  children,
}: {
  /** Position in the pipeline. Order is meaningful: work flows down it. */
  n: number;
  title: string;
  /** The one question this stage answers, in the reader's words. */
  question: string;
  state?: StageState;
  /** The number that decides whether to open it. */
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const chip = CHIP[state];
  return (
    <details
      open={defaultOpen}
      className="group rounded-xl border border-border bg-surface transition-colors open:border-border/80"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 p-4">
        <span className="font-mono text-xs tabular-nums text-faint">{String(n).padStart(2, "0")}</span>
        <span className="text-base font-semibold tracking-tight">{title}</span>
        {state !== "ok" && (
          <span className={`rounded px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide ${chip.cls}`}>
            {chip.label}
          </span>
        )}
        <span className="ml-auto text-sm tabular-nums text-muted">{summary}</span>
        <span className="w-full text-xs text-muted">{question}</span>
      </summary>
      {/* Padding only on the open body, so a closed stage is one tidy line. */}
      <div className="space-y-6 border-t border-border px-4 pb-5 pt-5">{children}</div>
    </details>
  );
}

/**
 * A long list that stays out of the way until asked for.
 *
 * The console's tables ran to hundreds of rows inline — 3,142 counties of plan,
 * every adapter, every recent run — which is what made scrolling to the section
 * you wanted a chore.
 */
export function Collapsed({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className="rounded-lg border border-border/60">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm text-muted hover:text-foreground">
        {label} <span className="tabular-nums font-medium text-foreground">{count.toLocaleString()}</span>
        <span className="ml-2 text-xs text-faint">show</span>
      </summary>
      <div className="border-t border-border/60 p-3">{children}</div>
    </details>
  );
}
