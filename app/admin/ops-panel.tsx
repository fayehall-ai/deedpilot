import { Card, Callout } from "@/components/ui";
import { OPS_TASKS, TERMINAL_ONLY, type OpsStage, type OpsTask } from "@/lib/ops/tasks";
import { runOpsTask } from "./ops-actions";

/**
 * Every pipeline operation as a button.
 *
 * ## Why one panel rather than a button inside each stage
 *
 * The stages above answer "how is the pipeline doing". This answers "what can I
 * make it do", which is a different motion and is the one that used to require
 * a terminal. Scattering eleven controls across six collapsed stages would hide
 * most of them; grouping them under their stage names in one place keeps the
 * vocabulary without hiding the controls.
 *
 * ## Why every button carries a limit
 *
 * Not caution — arithmetic. A Server Function has a hard ceiling and several of
 * these operations are national in scope, so a run that ignored a bound would
 * be killed mid-write rather than finishing. Each task stops at its limit or the
 * clock, whichever comes first, and reports what it did not reach; pressing
 * again continues.
 *
 * ## Why the terminal-only list is on the page
 *
 * Eleven more operations exist and cannot be buttons yet, all for one reason:
 * they read or write `data/source-registry.json` and similar files, and that
 * path is read-only on Vercel. Listing them with the blocker turns "why is the
 * prospector not here" from a question into a sentence.
 */

const STAGE_ORDER: OpsStage[] = ["Discover", "Crawl", "Observe", "Price", "Package", "Operate"];

function TaskForm({ task }: { task: OpsTask }) {
  return (
    <form
      action={runOpsTask}
      className="flex flex-wrap items-end gap-3 border-b border-border/50 py-4 last:border-0"
    >
      <input type="hidden" name="key" value={task.key} />

      <div className="min-w-[16rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{task.label}</span>
          {task.paid ? (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--warn)]">
              metered API
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm leading-snug text-muted">{task.blurb}</p>
        <p className="mt-1 font-mono text-xs text-muted">{task.script}</p>
      </div>

      {task.defaultLimit > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted">Limit</span>
          <input
            id={`limit-${task.key}`}
            name="limit"
            type="number"
            min={1}
            max={500}
            defaultValue={task.defaultLimit}
            className="w-24 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm tabular-nums"
          />
        </label>
      )}

      {task.stateful && (
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted">State</span>
          <input
            id={`state-${task.key}`}
            name="state"
            maxLength={2}
            placeholder="all"
            className="w-20 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm uppercase"
          />
        </label>
      )}

      <button
        type="submit"
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        Run
      </button>
    </form>
  );
}

export function OpsPanel({
  outcome,
}: {
  outcome?: Record<string, string | string[] | undefined>;
}) {
  const one = (k: string): string | null => {
    const v = outcome?.[k];
    return typeof v === "string" ? v : null;
  };
  const ranKey = one("op");
  const ranTask = ranKey ? OPS_TASKS.find((t) => t.key === ranKey) : undefined;
  const message = one("msg");
  const ok = one("ok") !== "0";

  const stages = STAGE_ORDER.filter((s) => OPS_TASKS.some((t) => t.stage === s));

  return (
    <div id="ops" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Run an operation</h2>
        <p className="mt-1 text-sm text-muted">
          The pipeline jobs that used to be terminal commands. Each runs here and now, bounded by
          its limit and the request clock, and reports what it changed — press again to continue
          where it stopped.
        </p>
      </div>

      {message ? (
        <Callout
          tone={ok ? "info" : "danger"}
          title={`${ranTask?.label ?? "Operation"} — ${ok ? "ran" : "failed"}`}
        >
          {message}
        </Callout>
      ) : null}

      <Card>
        {stages.map((stage) => (
          <section key={stage} className="mb-2 last:mb-0">
            <h3 className="text-xs uppercase tracking-[0.12em] text-muted">{stage}</h3>
            {OPS_TASKS.filter((t) => t.stage === stage).map((task) => (
              <TaskForm key={task.key} task={task} />
            ))}
          </section>
        ))}
      </Card>

      <details>
        <summary className="cursor-pointer text-sm text-muted underline underline-offset-2">
          {`${TERMINAL_ONLY.length} operations still need the terminal`}
        </summary>
        <Card className="mt-3">
          <p className="mb-3 text-sm text-muted">
            These read or write files under <code className="font-mono text-xs">data/</code> — the
            prospector&rsquo;s source registry, the atlas, the coverage scoreboard. That path is
            read-only on Vercel, so they cannot run from a request until that state moves into
            Postgres or Blob. Moving it is a change to where the registry lives, not to how these
            are triggered.
          </p>
          <ul className="space-y-1.5">
            {TERMINAL_ONLY.map((t) => (
              <li key={t.script} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-mono text-xs">{t.script}</span>
                <span>{t.label}</span>
                <span className="text-xs text-muted">— {t.blocker}</span>
              </li>
            ))}
          </ul>
        </Card>
      </details>
    </div>
  );
}
