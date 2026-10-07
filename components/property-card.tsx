/**
 * The parcel's property record in PropStream's layout: a summary strip of four
 * cards (property, value, mortgage & debt, opportunity), then tabs whose first
 * panel runs ownership → characteristics → size → land → legal → assessment →
 * HOA → last transfers. Bidders read properties in that order elsewhere, so
 * they find each fact where they already look for it.
 *
 * All shaping is in `lib/property/reapi-view.ts`; this file only draws.
 */
import type { PropertyView, Section, Stat, Table } from "@/lib/property/reapi-view";
import { PropertyTabs } from "./property-tabs";

const CARD =
  "rounded-3xl border border-border/70 bg-surface shadow-[var(--shadow-sm)] overflow-hidden";

export function PropertySummary({
  view,
  photo,
}: {
  view: PropertyView;
  /** The street-level photo, when Google has one; rendered top-left like PropStream's. */
  photo?: React.ReactNode;
}) {
  return (
    /*
     * Laid out by the room the strip actually has, not the viewport: the lot
     * page and the home-page lookup sit in different widths at different base
     * sizes, and one breakpoint left numbers breaking mid-figure in one or the
     * other. Four across only when there is room for four; otherwise the
     * property card takes its own row and the three figure cards sit beneath.
     */
    <div className="@container">
      <div className="grid gap-4 @3xl:grid-cols-3 @[80rem]:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]">
        <div className={`${CARD} @container p-4 @3xl:col-span-3 @[80rem]:col-span-1`}>
          {/*
            Narrow: photo, facts, status stacked. Medium: photo across the top,
            facts and status side by side. Full row: all three across, as in
            PropStream's header. An empty photo slot drops out of the grid.
          */}
          <div className="grid gap-4 @[26rem]:grid-cols-2 @[44rem]:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="empty:hidden @[26rem]:col-span-2 @[44rem]:col-span-1">{photo}</div>
            <FactList fields={view.facts} />
            <FactList fields={view.status} />
          </div>
        </div>

      {view.value.length ? <StatCard title="Value" stats={view.value} /> : null}

      {view.debt.length || view.lastSale.length ? (
        <StatCard title="Mortgage & Debt" stats={view.debt}>
          {view.lastSale.length ? (
            <>
              <h3 className="px-4 pt-3 text-base font-semibold text-accent">Last Sale</h3>
              <StatGrid stats={view.lastSale} />
            </>
          ) : null}
        </StatCard>
      ) : null}

      {view.opportunity.length ? <StatCard title="Opportunity" stats={view.opportunity} /> : null}
      </div>
    </div>
  );
}

export function PropertyDetailTabs({ view }: { view: PropertyView }) {
  const tabs = view.tabs
    .filter((t) => t.sections.length || t.tables.length)
    .map((t) => ({
      id: t.id,
      label: t.label,
      panel: (
        <div className="space-y-3">
          {t.sections.map((s) => (
            <SectionCard key={s.title} section={s} />
          ))}
          {t.tables.map((tb) => (
            <TableCard key={tb.title} table={tb} />
          ))}
        </div>
      ),
    }));
  return <PropertyTabs tabs={tabs} />;
}

function FactList({ fields }: { fields: { label: string; value: string }[] }) {
  if (!fields.length) return null;
  return (
    <dl className="overflow-hidden rounded-xl text-sm">
      {fields.map((f, i) => (
        <div
          key={f.label}
          className={`flex items-baseline justify-between gap-2 px-2.5 py-1.5 ${
            i % 2 === 0 ? "bg-surface-2/70" : ""
          }`}
        >
          <dt className="min-w-0 font-semibold text-accent">{f.label}</dt>
          <dd className="tnum min-w-0 text-right [overflow-wrap:normal]">
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatCard({
  title,
  stats,
  children,
}: {
  title: string;
  stats: Stat[];
  children?: React.ReactNode;
}) {
  return (
    // A column, so the figure band can take the height the row gives the card
    // rather than leaving it white under one or two figures.
    <div className={`${CARD} flex flex-col`}>
      <h3 className="whitespace-nowrap px-4 pt-4 text-xl font-semibold text-accent">{title}</h3>
      <StatGrid stats={stats} />
      {children}
    </div>
  );
}

/** Two figures to a row, on a tinted band, as PropStream's header cards are. */
function StatGrid({ stats }: { stats: Stat[] }) {
  if (!stats.length) return null;
  return (
    <dl className="mt-3 grid flex-1 auto-rows-fr grid-cols-2 bg-surface-2/70">
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={`min-w-0 px-3 py-2.5 ${i % 2 === 1 ? "border-l border-border/60" : ""} ${
            i >= 2 ? "border-t border-border/60" : ""
          } ${
            // An odd one out takes the whole last row instead of leaving half of it blank.
            i === stats.length - 1 && i % 2 === 0 ? "col-span-2" : ""
          }`}
        >
          <dt className="text-xs leading-tight text-muted">{s.label}</dt>
          {/* No mid-number wraps: "$6,570,\n860" reads as two figures. */}
          <dd className="tnum mt-1 text-base font-semibold leading-snug [overflow-wrap:normal]">
            {s.value}
          </dd>
          {s.note ? <dd className="mt-0.5 text-xs text-muted">{s.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function SectionCard({ section }: { section: Section }) {
  return (
    <section className={`${CARD} p-6`}>
      <h3 className="text-lg font-semibold">{section.title}</h3>
      <div className="mt-2 space-y-4">
        {section.groups.map((g, i) => (
          <div key={g.title ?? i}>
            {g.title ? <h4 className="mb-1 text-base font-semibold">{g.title}</h4> : null}
            {g.fields.length === 1 && !g.fields[0].label ? (
              <p className="text-sm leading-relaxed text-muted">{g.fields[0].value}</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
                {g.fields.map((f) => (
                  <div key={f.label} className="min-w-0">
                    <dt className="font-semibold text-accent">{f.label}</dt>
                    <dd className="tnum mt-0.5 break-words text-muted">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TableCard({ table }: { table: Table }) {
  return (
    <section className={`${CARD} p-6`}>
      <h3 className="mb-3 text-lg font-semibold">{table.title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              {table.columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold text-accent">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} className="border-t border-border/60">
                {r.map((v, j) => (
                  <td key={j} className="tnum whitespace-nowrap px-3 py-2 text-muted">
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
