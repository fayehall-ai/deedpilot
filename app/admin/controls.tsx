import { Card } from "@/components/ui";
import type { QueueView } from "@/lib/admin/queue";
import type { RunSchedule, SourceOverride, PolicyOverride } from "@/lib/db/schema";
import {
  runNow,
  cancelRun,
  saveSchedule,
  deleteSchedule,
  saveSource,
  deleteSource,
  savePolicy,
  deletePolicy,
} from "./run-actions";

const input =
  "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm";
const button =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90";
const ghost =
  "rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-danger hover:text-danger";

function when(d: Date | string | null): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  const m = (Date.now() - t.getTime()) / 60000;
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * The write half of the console.
 *
 * Every control posts to a Server Function that re-checks the admin cookie —
 * rendering a form is not an authorisation check, because the action endpoint
 * is reachable on its own. Each one also writes an `admin_audit` row.
 *
 * "Run now" enqueues rather than executes. A full adapter pass takes ten
 * minutes and no request can hold that long, so the button's job is to put
 * work in front of the dispatcher, not to do it.
 */
export function OpsControls({
  adapters,
  queue,
  schedules,
  sourceOverrides,
  policyOverrides,
}: {
  adapters: string[];
  queue: QueueView;
  schedules: RunSchedule[];
  sourceOverrides: SourceOverride[];
  policyOverrides: PolicyOverride[];
}) {
  const scheduleFor = (a: string) => schedules.find((s) => s.adapter === a);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Run control</h2>

      {/* ---- run now ---- */}
      <Card>
        <form action={runNow} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted">Adapter</span>
            <select name="adapter" className={input} defaultValue={adapters[0]}>
              {adapters.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted">
              County FIPS
            </span>
            <input name="countyFips" placeholder="optional" className={`${input} w-28`} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted">Limit</span>
            <input name="limit" type="number" min="1" placeholder="all" className={`${input} w-20`} />
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm">
            <input type="checkbox" name="dryRun" /> dry run
          </label>
          <button type="submit" className={button}>
            Queue an adapter run
          </button>
          <p className="w-full text-xs text-muted">
            Queued, not executed — the dispatcher picks it up within the minute. An adapter that
            already has work in flight is skipped rather than doubled.
          </p>
        </form>
      </Card>

      {/* ---- queue ---- */}
      <Card>
        <div className="mb-2 flex items-baseline gap-3">
          <h3 className="font-medium">Job queue</h3>
          <span className="text-sm text-muted">
            {queue.queued} queued · {queue.leased} running · {queue.failed} failed
          </span>
        </div>
        {queue.recent.length === 0 ? (
          <p className="text-sm text-muted">Nothing queued yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3">Adapter</th>
                  <th className="py-1.5 pr-3">Scope</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">By</th>
                  <th className="py-1.5 pr-3">Created</th>
                  <th className="py-1.5 pr-3" />
                </tr>
              </thead>
              <tbody>
                {queue.recent.map((j) => (
                  <tr key={j.id} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3">{j.adapter}</td>
                    <td className="py-1.5 pr-3 text-muted">
                      {j.countyFips ?? "all"}
                      {j.limit ? ` · limit ${j.limit}` : ""}
                      {j.dryRun ? " · dry" : ""}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={j.status === "failed" ? "text-danger" : ""}>{j.status}</span>
                      {j.lastError ? (
                        <div className="max-w-xs text-xs text-danger">{j.lastError.slice(0, 90)}</div>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-muted">{j.requestedBy}</td>
                    <td className="py-1.5 pr-3 text-muted">{when(j.createdAt)}</td>
                    <td className="py-1.5 pr-3">
                      {j.status === "queued" || j.status === "leased" ? (
                        <form action={cancelRun}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <button type="submit" className={ghost}>
                            cancel
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---- schedules ---- */}
      <Card>
        <h3 className="mb-1 font-medium">Adapter sweeps — superseded</h3>
        <p className="mb-3 text-xs text-muted">
          The old per-adapter cadence, kept switchable but no longer how crawling is scheduled. These
          swept every county an adapter serves regardless of when it sells, and a capped adapter
          permanently starved its tail because the runner slices the first N bindings each time. The
          calendar planner replaced them; the cadence that governs the pipeline lives in{" "}
          <strong>Operate → Cadence and spend</strong> above.
        </p>
        <div className="space-y-2">
          {adapters.map((a) => {
            const s = scheduleFor(a);
            return (
              <form key={a} action={saveSchedule} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="hidden" name="adapter" value={a} />
                <span className="w-40 shrink-0 font-mono text-xs">{a}</span>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name="enabled" defaultChecked={s?.enabled ?? false} /> on
                </label>
                <input
                  name="intervalMinutes"
                  type="number"
                  min="15"
                  defaultValue={s?.intervalMinutes ?? 1440}
                  className={`${input} w-24`}
                  title="minutes between runs"
                />
                <span className="text-xs text-muted">min</span>
                <input
                  name="limit"
                  type="number"
                  min="1"
                  defaultValue={s?.limit ?? undefined}
                  placeholder="limit"
                  className={`${input} w-20`}
                />
                <button type="submit" className={button}>
                  Save
                </button>
                <span className="text-xs text-muted">
                  {s ? `next ${when(s.nextDueAt)} · last ${when(s.lastEnqueuedAt)}` : "not scheduled"}
                </span>
              </form>
            );
          })}
        </div>
        {schedules.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {schedules.map((s) => (
              <form key={s.id} action={deleteSchedule}>
                <input type="hidden" name="adapter" value={s.adapter} />
                <button type="submit" className={ghost}>
                  remove {s.adapter}
                </button>
              </form>
            ))}
          </div>
        )}
      </Card>

      {/* ---- source overrides ---- */}
      <Card>
        <h3 className="mb-1 font-medium">Source overrides</h3>
        <p className="mb-3 text-xs text-muted">
          Overlays the registry in code, never replaces it — the registry entry keeps its
          verification in the commit that added it, and this corrects a moved page without a
          deploy. Leave the URL blank to keep the registry&rsquo;s and only change on/off.
        </p>
        <form action={saveSource} className="flex flex-wrap items-end gap-2">
          <select name="adapter" className={input} defaultValue={adapters[0]}>
            {adapters.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input name="countyFips" placeholder="FIPS" className={`${input} w-24`} required />
          <input name="url" placeholder="https://… (optional)" className={`${input} w-72`} />
          <label className="flex items-center gap-1.5 pb-1.5 text-sm">
            <input type="checkbox" name="enabled" defaultChecked /> enabled
          </label>
          <input name="note" placeholder="note" className={`${input} w-40`} />
          <button type="submit" className={button}>
            Save
          </button>
        </form>
        {sourceOverrides.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-sm">
            {sourceOverrides.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">
                  {o.adapter}/{o.countyFips}
                </span>
                {!o.enabled && <span className="text-xs text-danger">disabled</span>}
                {o.url && <span className="text-xs text-muted">{o.url.slice(0, 60)}</span>}
                <span className="text-xs text-muted">{when(o.updatedAt)}</span>
                <form action={deleteSource}>
                  <input type="hidden" name="id" value={o.id} />
                  <button type="submit" className={ghost}>
                    revert
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- policy overrides ---- */}
      <Card>
        <h3 className="mb-1 font-medium">Access policy overrides</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          These decisions are why this project is not crawling USTLA or the Georgia Press
          Association, and neither is blocked by robots — both are blocked by terms a crawler
          cannot read. A written reason is required, and required to be substantive before a host
          can be moved to <code className="font-mono">allow</code>. Every change is recorded in the
          audit log.
        </p>
        <form action={savePolicy} className="flex flex-wrap items-end gap-2">
          <input name="host" placeholder="example.com" className={`${input} w-52`} required />
          <select name="decision" className={input} defaultValue="requires_agreement">
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="requires_agreement">requires_agreement</option>
          </select>
          <input
            name="minDelayMs"
            type="number"
            min="0"
            step="500"
            defaultValue={5000}
            className={`${input} w-24`}
            title="minimum delay between requests, ms"
          />
          <input
            name="reason"
            placeholder="why — what was checked, and when"
            className={`${input} w-80`}
            required
          />
          <button type="submit" className={button}>
            Save
          </button>
        </form>
        {policyOverrides.length > 0 && (
          <ul className="mt-3 space-y-2 text-sm">
            {policyOverrides.map((p) => (
              <li key={p.host}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{p.host}</span>
                  <span
                    className={
                      p.decision === "allow" ? "text-xs text-danger" : "text-xs text-muted"
                    }
                  >
                    {p.decision}
                  </span>
                  <span className="text-xs text-muted">{when(p.updatedAt)}</span>
                  <form action={deletePolicy}>
                    <input type="hidden" name="host" value={p.host} />
                    <button type="submit" className={ghost}>
                      revert to code
                    </button>
                  </form>
                </div>
                <p className="text-xs text-muted">{p.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
