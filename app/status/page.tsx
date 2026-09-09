import { Suspense } from "react";
import type { Metadata } from "next";
import { getCopilotStatus } from "@/lib/status";
import { num, percent } from "@/lib/format";
import { Breadcrumbs, Callout, Card, EmptyState, Stat } from "@/components/ui";
import { TableSkeleton } from "@/components/skeleton";
import { CalibrationChart, CorpusBars, PolicyBars } from "@/components/status-charts";

export const metadata: Metadata = {
  title: "Corpus and simulation status",
  description:
    "What the recorded corpus actually observes, which redemption priors are measured rather than assumed, how the clearing-price model calibrates out of time, and how the bid policy scores against baselines.",
};


/**
 * The other honesty page.
 *
 * `/coverage` shows which counties we ingest. This shows whether the data behind
 * the numbers means what it appears to mean. Both exist because the failure mode
 * that costs a subscriber money is not a visible gap — it is a figure that looks
 * like evidence and is not.
 */
/*
 * No `unstable_instant` here. Both ops pages read fully-cached aggregates, so
 * the whole page is prerenderable and validation objects to the static
 * `metadata` export as the one thing keeping it from being so. The Suspense
 * boundary below still does the work that matters — these are the two screens
 * where a slow query is most likely and least urgent.
 */
export default function StatusPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Suspense fallback={<TableSkeleton />}>
        <StatusBody />
      </Suspense>
    </main>
  );
}

async function StatusBody() {
  const s = await getCopilotStatus();

  if (!s) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <Breadcrumbs items={[{ href: "/", label: "DeedPilot" }, { label: "Status" }]} />
        <EmptyState title="No status snapshot has been exported yet">
          Run <code className="font-mono">deedpilot-copilot export-status</code> and commit{" "}
          <code className="font-mono">copilot/data/status.json</code>.
        </EmptyState>
      </main>
    );
  }

  const { corpus, priors, splits, worldModel, policies } = s;
  const unusable = corpus.nRows - corpus.nPriceUsable;

  return (
    <>
      <Breadcrumbs items={[{ href: "/", label: "DeedPilot" }, { label: "Status" }]} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Corpus and simulation status</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        What the recorded data actually observes, and how the model built on it holds up on sales it
        never saw. Snapshot exported {s.generatedAt.slice(0, 10)}.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-5 rounded-xl border border-border bg-surface p-5 sm:grid-cols-4">
        <Stat label="Recorded rows" value={num(corpus.nRows)} hint="the headline number" />
        <Stat
          label="Usable price data"
          value={num(corpus.nPriceUsable)}
          hint={`${percent(corpus.sharePriceUsable, 0)} of rows`}
        />
        <Stat
          label="Observed redemption"
          value={num(corpus.nRedemptionObserved)}
          hint="Michigan only"
        />
        <Stat
          label="Model training rows"
          value={worldModel.fitted ? num(worldModel.nTrain) : "—"}
          hint={worldModel.fitted ? `${worldModel.nCounties} counties` : "not fitted"}
        />
      </div>

      <div className="mt-4">
        <Callout tone="warn" title="Read the second figure, not the first">
          {num(unusable)} of {num(corpus.nRows)} rows carry no usable price. A source whose money
          column is a delinquent tax amount contributes no price signal however many rows it has,
          and a source that never revisits a parcel observes no redemption at all.
        </Callout>
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Corpus composition
        </h2>
        <Card className="mt-3">
          <CorpusBars rules={corpus.byRule} total={corpus.nRows} />
        </Card>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Redemption priors
        </h2>
        <Card className="mt-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 pr-3 font-medium">Bucket</th>
                  <th className="pb-2 pr-3 font-medium">Basis</th>
                  <th className="pb-2 pr-3 text-right font-medium">Rows</th>
                  <th className="pb-2 pr-3 text-right font-medium">Observed</th>
                  <th className="pb-2 pr-3 text-right font-medium">p_redeem</th>
                  <th className="pb-2 text-right font-medium">Expert prior</th>
                </tr>
              </thead>
              <tbody>
                {priors.buckets.map((b) => (
                  <tr key={b.key} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{b.key}</td>
                    <td className="py-2 pr-3">
                      <span
                        className="rounded px-1.5 py-0.5 text-xs uppercase tracking-wide"
                        style={{
                          color: b.source === "observed" ? "var(--accent)" : "var(--warn)",
                          background:
                            b.source === "observed"
                              ? "color-mix(in srgb, var(--accent) 13%, transparent)"
                              : "color-mix(in srgb, var(--warn) 13%, transparent)",
                        }}
                      >
                        {b.source}
                      </span>
                    </td>
                    <td className="tnum py-2 pr-3 text-right">{num(b.n)}</td>
                    <td className="tnum py-2 pr-3 text-right">{num(b.nObserved)}</td>
                    <td className="tnum py-2 pr-3 text-right">{b.pRedeem.toFixed(3)}</td>
                    <td className="tnum py-2 text-right text-muted">
                      {b.expertPRedeem.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            A bucket marked <span className="font-mono text-xs">expert</span> has zero observations —
            its rate is the prior, not a measurement. That is the honest answer where a source
            publishes which parcels sold and never revisits them: counting those defaults as
            observed non-redemptions is what previously pinned Illinois at 0.02, against a prior of
            0.72.
          </p>
        </Card>
      </section>

      {worldModel.fitted ? (
        <section className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Clearing-price model
            </h2>
            <span className="text-xs text-muted">
              trained on {worldModel.states.join(", ")} · held-out splits below
            </span>
          </div>
          <Card className="mt-3">
            <CalibrationChart val={worldModel.val} test={worldModel.test} />
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Both splits sit just under the diagonal, so real prices come in slightly above what the
              model expects — it under-predicts the top of the market rather than over-predicting
              it, which is the safer direction for a bid ceiling. Against a single global
              distribution, conditioning on county and year improves pinball loss by{" "}
              {percent(worldModel.val.pinball_improvement_vs_global ?? 0, 1)} on validation and{" "}
              {percent(worldModel.test.pinball_improvement_vs_global ?? 0, 1)} on test.
            </p>
          </Card>
        </section>
      ) : null}

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Bid policy — test split
          </h2>
          <span className="text-xs text-muted">
            ground truth is the recorded clearing price · cut {splits.policy.cutTest}
          </span>
        </div>
        <Card className="mt-3">
          <PolicyBars rows={policies.test} />
          <p className="mt-4 text-sm leading-relaxed text-muted">
            The search wins fewer auctions deliberately — it stops paying far over the clearing price
            to win parcels that were going to clear cheaply. Surplus is oracle-derived value, not
            realised P&amp;L: no row in the corpus records an exit price.
          </p>
        </Card>
      </section>

      <section className="mt-10 grid gap-5 md:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Not observed anywhere
          </h2>
          <Card className="mt-3">
            <p className="mb-3 text-sm text-muted">
              Zero rows populate these, so the simulator takes them from statute and expert ranges
              rather than data.
            </p>
            <ul className="flex flex-wrap gap-2">
              {priors.unobservedFields.map((f) => (
                <li
                  key={f}
                  className="rounded bg-surface-2 px-2 py-1 font-mono text-xs text-muted"
                >
                  {f}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Frozen splits
          </h2>
          <Card className="mt-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th className="pb-2 pr-3 font-medium">Split</th>
                    <th className="pb-2 pr-3 text-right font-medium">Rows</th>
                    <th className="pb-2 text-right font-medium">Priced</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(splits.counts).map(([k, v]) => (
                    <tr key={k} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">{k}</td>
                      <td className="tnum py-2 pr-3 text-right">{num(v)}</td>
                      <td className="tnum py-2 text-right text-muted">
                        {num(splits.clearingPrice[k] ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Temporal, not random — the same county&rsquo;s spring and autumn sales must not land on
              both sides. Undated rows are excluded rather than guessed. Promotion is decided on
              validation; test is reported and never gated on.
            </p>
          </Card>
        </div>
      </section>

      <p className="mt-10 border-t border-border pt-4 text-xs text-muted">
        Exported from the copilot with{" "}
        <code className="font-mono">deedpilot-copilot export-status</code>. This page reads the
        committed snapshot rather than a live service, so figures change when the model is refitted
        and the export re-run.
      </p>
    </>
  );
}
