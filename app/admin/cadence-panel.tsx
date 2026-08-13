import { Card, Callout, Stat } from "@/components/ui";
import { AdminTable, type AdminColumn } from "@/components/admin-table";
import { getPipelineConfig, LIMITS, WEEKDAYS } from "@/lib/admin/pipeline-settings";
import { deskWeekday, deskZoneLabel, deskDateTime, dispatchTimeAtDesk } from "@/lib/desk-time";
import { spendReport, DEFAULT_RATES, type SpendRow } from "@/lib/ai/usage";
import { runCrawlPlanNow, runResearchNow, savePipelineSettings } from "./run-actions";

const button =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90";
const input = "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm";
const ghost =
  "rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground";

const usd = (cents: number) =>
  cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${cents.toFixed(1)}¢`;

/**
 * What the pipeline costs, and how hard it is allowed to run.
 *
 * Spend and cadence sit together because they are the same decision. Raising
 * the crawl cap or the weekly state count is the only way this system spends
 * more, so the number and its consequence belong on one screen rather than in
 * two places that have to be read against each other.
 */
export async function CadencePanel() {
  const [config, spend] = await Promise.all([getPipelineConfig(), spendReport(30)]);
  const now = new Date();

  const columns: AdminColumn<SpendRow>[] = [
    { key: "op", header: "What for", cell: (r) => r.operation },
    { key: "provider", header: "Provider", cell: (r) => <span className="font-mono text-xs">{r.provider}</span> },
    { key: "calls", header: "Calls", numeric: true, cell: (r) => r.calls.toLocaleString() },
    {
      key: "units",
      header: "Units consumed",
      cell: (r) => (
        <span className="font-mono text-xs text-muted">
          {r.inputTokens > 0 || r.outputTokens > 0
            ? `${(r.inputTokens / 1000).toFixed(0)}k in / ${(r.outputTokens / 1000).toFixed(0)}k out`
            : ""}
          {r.searchCalls > 0 ? `  ${r.searchCalls} searches` : ""}
          {r.requests > 0 ? `  ${r.requests} lookups` : ""}
        </span>
      ),
    },
    { key: "cents", header: "Est. cost", numeric: true, cell: (r) => usd(r.cents) },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Cadence and spend</h2>
        <p className="mt-1 text-sm text-muted">
          The only things here that cost money are model calls and property
          lookups, and the only way to spend more is to raise a number on this
          screen — so the settings and the bill sit together.
        </p>
      </div>

      {/* ---- spend ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Est. spend, 30 days" value={usd(spend.totalCents)} />
        <Stat label="Paid calls" value={spend.rows.reduce((n, r) => n + r.calls, 0).toLocaleString()} />
        <Stat label="Web searches" value={spend.rows.reduce((n, r) => n + r.searchCalls, 0).toLocaleString()} />
        <Stat label="Property lookups" value={spend.rows.reduce((n, r) => n + r.requests, 0).toLocaleString()} />
      </div>

      <Card>
        <h3 className="mb-1 font-medium">Where it went</h3>
        <p className="mb-3 text-xs text-muted">
          Units are exact — they come from each provider&rsquo;s own response and never change after
          the fact. <strong>The dollar figures are estimates</strong> against list rates configured in{" "}
          <code className="font-mono">lib/ai/usage.ts</code>: xAI at{" "}
          {DEFAULT_RATES.xai.perSearchCall}¢ a search and ${(DEFAULT_RATES.xai.outputPerMTok / 100).toFixed(2)}/M
          output tokens, property lookups at {DEFAULT_RATES.attom.perRequest}¢ each. Check them
          against your actual bill — a negotiated contract is not list, and a price stored in a row
          would be wrong the moment either moved.
        </p>
        <AdminTable
          rows={spend.rows}
          columns={columns}
          rowKey={(r) => `${r.operation}:${r.provider}`}
          minWidth="44rem"
          empty="No paid calls recorded yet. Usage is captured from here on — it cannot be backfilled."
        />
      </Card>

      {spend.daily.length > 0 && (
        <Card>
          <h3 className="mb-2 font-medium">By day</h3>
          <div className="space-y-1">
            {spend.daily.slice(0, 10).map((d) => {
              const peak = Math.max(...spend.daily.map((x) => x.cents), 1);
              return (
                <div key={d.day} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-muted">{d.day}</span>
                  <span
                    className="h-2 shrink-0 rounded-sm bg-accent"
                    style={{ width: `${Math.max(2, (d.cents / peak) * 200)}px` }}
                    aria-hidden
                  />
                  <span className="tabular-nums">{usd(d.cents)}</span>
                  <span className="text-xs text-muted">{d.calls} call{d.calls === 1 ? "" : "s"}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ---- run now ---- */}
      <Card>
        <h3 className="mb-1 font-medium">Run now</h3>
        <p className="mb-3 text-xs text-muted">
          Both queue rather than crawl — a full pass is hundreds of fetches and a form submission
          cannot hold that open. The dispatcher drains what they queue, so pressing before the
          overnight tick brings the day&rsquo;s work forward rather than duplicating it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <form action={runCrawlPlanNow}>
            <button type="submit" className={button}>
              Run Crawl Scout now
            </button>
          </form>
          <span className="text-xs text-muted">
            queues up to {config.crawlMaxTasks} counties, highest priority first · free
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <form action={runResearchNow}>
            <button type="submit" className={ghost}>
              Run Research Scout now
            </button>
          </form>
          <span className="text-xs text-warn">
            queues {config.researchStates} paid searched call
            {config.researchStates === 1 ? "" : "s"} — roughly{" "}
            {usd(config.researchStates * 30 * DEFAULT_RATES.xai.perSearchCall)} at ~30 searches each
          </span>
        </div>
      </Card>

      {/* ---- schedules ---- */}
      <Card>
        <h3 className="mb-1 font-medium">Schedules</h3>
        <p className="mb-3 text-xs text-muted">
          These were hardcoded across three files, so changing how hard the pipeline runs meant a
          deploy — the wrong shape for the setting most likely to need changing at short notice.
          {config.edited && config.updatedAt ? (
            <>
              {" "}
              Last changed by <strong>{config.updatedBy}</strong> on{" "}
              {deskDateTime(config.updatedAt)}.
            </>
          ) : (
            " Currently on the built-in defaults."
          )}
        </p>

        <form action={savePipelineSettings} className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Crawl Scout</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="crawlEnabled" defaultChecked={config.crawlEnabled} /> enabled
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Counties per tick</span>
                <input
                  name="crawlMaxTasks"
                  type="number"
                  min={LIMITS.crawlMaxTasks.min}
                  max={LIMITS.crawlMaxTasks.max}
                  defaultValue={config.crawlMaxTasks}
                  className={`${input} w-28`}
                />
              </label>
              <span className="pb-2 text-xs text-muted">
                runs nightly at {dispatchTimeAtDesk(now)} · ~3.0s a county against a 195s claiming
                budget, so past ~60 the queue grows rather than the throughput
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Research Scout</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="researchEnabled" defaultChecked={config.researchEnabled} />{" "}
                enabled
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Day at the desk</span>
                <select name="researchWeekday" defaultValue={config.researchWeekday} className={input}>
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">States per pass</span>
                <input
                  name="researchStates"
                  type="number"
                  min={LIMITS.researchStates.min}
                  max={LIMITS.researchStates.max}
                  defaultValue={config.researchStates}
                  className={`${input} w-24`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Cooldown (days)</span>
                <input
                  name="researchCooldownDays"
                  type="number"
                  min={LIMITS.researchCooldownDays.min}
                  max={LIMITS.researchCooldownDays.max}
                  defaultValue={config.researchCooldownDays}
                  className={`${input} w-24`}
                />
              </label>
            </div>
            <p className="text-xs text-muted">
              Days are counted at the desk, so a Sunday pass runs on Sunday here rather than on
              whatever day the server thinks it is. Today is <strong>{deskWeekday(now)}</strong>,{" "}
              {deskZoneLabel(now)}.
            </p>
          </div>

          <div className="flex gap-2">
            <button type="submit" className={button}>
              Save schedules
            </button>
            <button type="submit" name="intent" value="reset" className={ghost}>
              Reset to defaults
            </button>
          </div>
        </form>
      </Card>

      {!config.crawlEnabled && (
        <Callout tone="warn" title="Calendar crawling is switched off">
          The dispatcher will drain whatever is already queued and plan nothing new. Inventory goes
          stale from here, silently — nothing else in the console will say so.
        </Callout>
      )}
    </section>
  );
}
