/**
 * The auction calendar, as a component.
 *
 * Rendered by both `/calendar` and the home page. It lives here rather than in
 * either route because the two must not drift: the home page is where most
 * people meet this thing, and a second copy would be the one that quietly
 * stopped grouping Harris County's precincts or stopped labelling projected
 * dates.
 *
 * `basePath` is what lets one component serve two routes — every filter chip,
 * month arrow and "clear all" builds its href from it, so a click returns you
 * to the page you clicked on.
 */
import Link from "next/link";
import { connection } from "next/server";
import {
  getCalendarAuctions,
  getCalendarFacets,
  getNextCalendarDate,
  type CalendarAuctionRow,
  type CalendarFacet,
} from "@/lib/queries";
import { num, platformLabel, relativeDays, saleDate, saleTypeColor } from "@/lib/format";
import { STATE_NAMES, countyLabel } from "@/lib/atlas";
import {
  calendarHref,
  gridRange,
  groupSalesByCounty,
  hasActiveFilters,
  monthBounds,
  monthGrid,
  monthLabel,
  monthOf,
  parseCalendarFilters,
  shiftMonth,
  toggle,
  todayIso,
  WEEKDAY_LABELS,
  type CalendarFilters,
  type SaleGroup,
} from "@/lib/calendar/grid";

/**
 * Entries shown in a day square before the rest fold into a disclosure.
 *
 * September 1 2026 carries 17 sales — Texas's statutory first Tuesday. Letting
 * that square run to full height drags every other row in the grid down with
 * it, and the month stops being scannable at exactly the moment it matters.
 */
const MAX_PER_CELL = 5;


/*
 * Links that only change what this calendar shows keep the page where it is.
 *
 * Next's default is to scroll to the top of the Page element whenever that
 * element is not in the viewport. On the home page the calendar sits ~800px
 * down, so paging August → September threw the reader back up to the hero
 * mid-interaction. These are in-place view changes, not navigations somewhere
 * else — the sale links below deliberately keep the default, because opening
 * a parcel *should* start at the top.
 */
const STAY_PUT = { scroll: false } as const;

export async function CalendarView(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  /** Route the filter links point back at. */
  basePath?: string;
}) {
  /*
   * Which square is "today" is a genuinely per-request answer, and this is the
   * component that asks. `connection()` marks the point where prerendering
   * stops — without it the current date would be baked into the prefetched
   * shell and the highlighted day would be whenever the page was last built.
   */
  await connection();
  const params = await props.searchParams;
  const today = todayIso();
  const filters = parseCalendarFilters(params, today, props.basePath ?? "/calendar");

  const { start, end } = gridRange(filters.month);
  const { first, last } = monthBounds(filters.month);
  const query = {
    states: filters.states,
    saleTypes: filters.saleTypes,
    platforms: filters.platforms,
    includeUnconfirmed: filters.includeLeads,
  };

  const [rows, facets] = await Promise.all([
    getCalendarAuctions({ ...query, from: start, to: end }),
    getCalendarFacets({ includeUnconfirmed: filters.includeLeads }),
  ]);

  const byDay = new Map<string, CalendarAuctionRow[]>();
  for (const r of rows) {
    const day = byDay.get(r.saleDate);
    if (day) day.push(r);
    else byDay.set(r.saleDate, [r]);
  }

  // Headline counts describe the month, not the grid — the spillover squares
  // belong to a neighbouring month and would double-count if paged through.
  const inMonth = rows.filter((r) => r.saleDate >= first && r.saleDate <= last);
  const lotTotal = inMonth.reduce((n, r) => n + r.lotCount, 0);
  const countyTotal = new Set(inMonth.map((r) => r.countyFips)).size;

  // Sales cluster into a few months a year, so an empty grid is the normal
  // result of paging forward. Offer the next month that has something.
  const nextMonthFirst = monthBounds(shiftMonth(filters.month, 1)).first;
  const nextDate =
    inMonth.length === 0
      ? await getNextCalendarDate({
          ...query,
          after: nextMonthFirst > today ? nextMonthFirst : today,
        })
      : null;

  const weeks = monthGrid(filters.month, today);
  const typesInView = [...new Set(rows.map((r) => r.saleType))];

  return (
    <>
      <header className="-mt-4 mb-6">
        <div>
          <p className="mt-1 text-sm text-muted">
            {inMonth.length === 0 ? (
              <>No sales in {monthLabel(filters.month)} matching these filters.</>
            ) : (
              <>
                {num(inMonth.length)} {inMonth.length === 1 ? "sale" : "sales"} across{" "}
                {num(countyTotal)} {countyTotal === 1 ? "county" : "counties"} in{" "}
                {monthLabel(filters.month)} · {num(lotTotal)} lots
              </>
            )}
          </p>
        </div>
      </header>

      <MonthNav filters={filters} />

      <Filters filters={filters} facets={facets} />

      {typesInView.length > 0 ? <Legend types={typesInView} /> : null}

      {/* Desktop: the month grid. */}
      <div className="hidden md:block">
        <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-border bg-surface">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="border-b border-border bg-surface-2/60 px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted"
            >
              {label}
            </div>
          ))}
          {weeks.flat().map((cell, i) => {
            const sales = byDay.get(cell.iso) ?? [];
            const groups = groupSalesByCounty(sales);
            return (
              <div
                key={cell.iso}
                className={[
                  "min-h-28 border-border p-1.5",
                  // No right border on the last column, no bottom on the last row.
                  (i + 1) % 7 === 0 ? "" : "border-r",
                  i < weeks.flat().length - 7 ? "border-b" : "",
                  cell.inMonth ? "" : "bg-surface-2/50",
                  cell.inMonth && cell.isWeekend ? "bg-surface-2/25" : "",
                ].join(" ")}
              >
                <div className="mb-1 flex items-center justify-between gap-1">
                  <span
                    className={
                      cell.isToday
                        ? "grid h-5 w-5 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg"
                        : `text-[11px] ${cell.inMonth ? "text-muted" : "text-muted/50"}`
                    }
                  >
                    {cell.dayOfMonth}
                  </span>
                  {/* Lots, not sales — the number that says where the volume is.
                      A day with one 400-lot county outranks a day with four
                      counties selling three parcels each. */}
                  {sales.length > 0 ? (
                    <span
                      className="tnum text-[10px] text-muted"
                      title={`${num(sales.reduce((n, a) => n + a.lotCount, 0))} lots across ${num(sales.length)} ${sales.length === 1 ? "sale" : "sales"}`}
                    >
                      {num(sales.reduce((n, a) => n + a.lotCount, 0))}
                    </span>
                  ) : null}
                </div>

                <ul className="space-y-0.5">
                  {groups.slice(0, MAX_PER_CELL).map((g) => (
                    <li key={g.key}>
                      <SaleEntry group={g} />
                    </li>
                  ))}
                </ul>

                {groups.length > MAX_PER_CELL ? (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer list-none px-1 text-[10px] text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                      +{groups.length - MAX_PER_CELL} more
                    </summary>
                    <ul className="mt-0.5 space-y-0.5">
                      {groups.slice(MAX_PER_CELL).map((g) => (
                        <li key={g.key}>
                          <SaleEntry group={g} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile: the same days as an agenda. A 7-column grid on a phone is
          unreadable, and this is the view someone opens standing in a
          courthouse hallway. */}
      <div className="md:hidden">
        {[...byDay.entries()].length === 0 ? null : (
          <div className="space-y-5">
            {[...byDay.entries()].map(([day, sales]) => (
              <section key={day}>
                <div className="mb-2 flex items-baseline gap-2 border-b border-border pb-1.5">
                  <h2 className="text-sm font-semibold">{saleDate(day)}</h2>
                  <span className="text-xs text-muted">{relativeDays(day)}</span>
                  <span className="tnum ml-auto text-xs text-muted">
                    {num(sales.length)} {sales.length === 1 ? "sale" : "sales"}
                  </span>
                </div>
                <ul className="space-y-1">
                  {groupSalesByCounty(sales).map((g) => (
                    <li key={g.key}>
                      <SaleEntry group={g} verbose />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {inMonth.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="font-medium">Nothing scheduled in {monthLabel(filters.month)}</p>
          <div className="mx-auto mt-2 max-w-prose text-sm text-muted">
            {nextDate ? (
              <p>
                The next matching sale is{" "}
                <Link
                  href={calendarHref(filters, { month: monthOf(nextDate) })}
                  {...STAY_PUT}
                  className="underline hover:text-foreground"
                >
                  {saleDate(nextDate)}
                </Link>
                .
              </p>
            ) : (
              <p>
                No sales match these filters on any future date.{" "}
                {hasActiveFilters(filters) ? (
                  <Link
                    href={calendarHref(filters, {
                      states: [],
                      saleTypes: [],
                      platforms: [],
                      includeLeads: false,
                    })}
                    {...STAY_PUT}
                    className="underline hover:text-foreground"
                  >
                    Clear filters
                  </Link>
                ) : (
                  <Link href="/coverage" className="underline hover:text-foreground">
                    Check coverage
                  </Link>
                )}
                .
              </p>
            )}
          </div>
        </div>
      ) : null}

      <p className="mt-6 text-xs leading-relaxed text-muted">
        {filters.includeLeads ? (
          <>
            <strong className="text-foreground">Research leads are shown.</strong> Entries marked{" "}
            <em>projected</em> sit on a date this system inferred from the state&apos;s typical
            schedule, not one the county published — the sale may not happen that day, or at all.
            Entries marked <em>roll</em> or <em>lands</em> come from a delinquent tax roll or
            lands-available inventory rather than a sale list, and are not bidding inventory.{" "}
            <Link
              href={calendarHref(filters, { includeLeads: false })}
              {...STAY_PUT}
              className="underline hover:text-foreground"
            >
              Show confirmed sales only
            </Link>
            .
          </>
        ) : (
          <>
            Showing only published sale lists on county-published dates. Sale dates and lot counts
            change; confirm with the county before travelling or wiring funds.
          </>
        )}
      </p>
    </>
  );
}

/**
 * A county's sales on one day: one link, or a disclosure when there are several.
 *
 * Harris County TX runs eight constable-precinct sales on August 4, each a real
 * and separate parcel list. Listed flat they fill the square and read as an
 * ingest bug; collapsed to a single row they would hide seven sale lists. So
 * the county gets one line with a ×8 badge that opens to the precincts.
 */
function SaleEntry({
  group,
  verbose = false,
}: {
  group: SaleGroup<CalendarAuctionRow>;
  verbose?: boolean;
}) {
  if (group.sales.length === 1) return <SaleLink auction={group.sales[0]} verbose={verbose} />;

  const lead = group.sales[0];
  const stateName = STATE_NAMES[lead.state] ?? lead.state;
  const county = countyLabel(lead.state, lead.countyName);
  const isLead = lead.listingKind !== "sale_list" || !lead.saleDateConfirmed;

  return (
    <details className="group/entry">
      <summary
        title={`${county}, ${stateName} — ${num(group.sales.length)} separate ${lead.saleType} sales, ${num(group.lotTotal)} lots total, ${platformLabel(lead.platform)}${
          group.cancelledCount ? ` (${num(group.cancelledCount)} cancelled)` : ""
        }`}
        className={[
          "flex cursor-pointer list-none items-start gap-1.5 rounded px-1 py-0.5 leading-tight transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden",
          verbose ? "text-sm" : "text-[11px]",
          isLead ? "border-l-2 border-dashed border-border pl-1" : "",
        ].join(" ")}
      >
        <span
          aria-hidden
          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: saleTypeColor(lead.saleType) }}
        />
        <span
          className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 ${
            group.allCancelled ? "text-muted line-through" : ""
          }`}
        >
          <span className="max-w-full truncate">
            <span className="font-medium">{verbose ? stateName : lead.state}</span>
            <span className="text-muted"> · </span>
            {lead.countyName}
          </span>
          {/* The badge doubles as the disclosure affordance — a summary row
              styled like every other entry gives no hint that it opens. */}
          <span className="tnum inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-surface-2 px-1 text-[9px] text-muted">
            ×{group.sales.length}
            <span aria-hidden className="transition-transform group-open/entry:rotate-90">
              ›
            </span>
          </span>
          {isLead ? <LeadTag auction={lead} /> : null}
          {/* A cancellation must be visible without opening the group — the one
              thing collapsing rows could otherwise bury. */}
          {group.cancelledCount > 0 && !group.allCancelled ? (
            <span className="whitespace-nowrap text-[9px] uppercase tracking-wide text-warn">
              {num(group.cancelledCount)} cancelled
            </span>
          ) : null}
        </span>
        {verbose ? (
          <span className="tnum ml-auto shrink-0 pl-2 text-xs text-muted">
            {num(group.lotTotal)}
          </span>
        ) : null}
      </summary>

      <ul className="mt-0.5 space-y-0.5 border-l border-border pl-2 ml-2">
        {group.sales.map((a, i) => {
          const cancelled = a.status === "cancelled" || a.status === "postponed";
          return (
            <li key={a.id}>
              <Link
                href={`/auctions/${a.id}`}
                title={`${a.title ?? county} — ${num(a.lotCount)} lots${cancelled ? `, ${a.status}` : ""}`}
                className={`flex items-baseline gap-2 rounded px-1 py-0.5 transition-colors hover:bg-surface-2 ${
                  verbose ? "text-sm" : "text-[11px]"
                }`}
              >
                <span
                  className={`min-w-0 flex-1 truncate ${cancelled ? "text-muted line-through" : ""}`}
                >
                  {/* Falls back to an ordinal when the county publishes no
                      distinguishing title — never an unlabelled row. */}
                  {group.labels[i] ?? `Sale ${i + 1}`}
                </span>
                <span className="tnum shrink-0 text-muted">{num(a.lotCount)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * One county's sale, as it appears in a day square.
 *
 * `verbose` spells the state out for the agenda view, where there is room; the
 * grid uses the postal abbreviation and hangs the full name off the tooltip.
 */
function SaleLink({ auction, verbose = false }: { auction: CalendarAuctionRow; verbose?: boolean }) {
  const stateName = STATE_NAMES[auction.state] ?? auction.state;
  const county = countyLabel(auction.state, auction.countyName);
  const isLead = auction.listingKind !== "sale_list" || !auction.saleDateConfirmed;
  const cancelled = auction.status === "cancelled" || auction.status === "postponed";

  return (
    <Link
      href={`/auctions/${auction.id}`}
      title={`${county}, ${stateName} — ${auction.saleType}, ${num(auction.lotCount)} lots, ${platformLabel(auction.platform)}`}
      className={[
        // Wraps rather than truncates: the county name is the whole point of
        // the entry, and a lead tag alongside it turns "SC · Greenville" into
        // "SC · Gree…" in a 200px square. Two lines beats an ellipsis.
        "flex items-start gap-1.5 rounded px-1 py-0.5 leading-tight transition-colors hover:bg-surface-2",
        verbose ? "text-sm" : "text-[11px]",
        isLead ? "border-l-2 border-dashed border-border pl-1" : "",
      ].join(" ")}
    >
      <span
        aria-hidden
        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: saleTypeColor(auction.saleType) }}
      />
      {/* The name is one unbreakable unit; the lead tag wraps beneath it when
          the square is too narrow for both, rather than splitting "SC ·" from
          "Greenville". Truncation is the last resort, not the first. */}
      <span
        className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 ${
          cancelled ? "text-muted line-through" : ""
        }`}
      >
        <span className="max-w-full truncate">
          <span className="font-medium">{verbose ? stateName : auction.state}</span>
          <span className="text-muted"> · </span>
          {auction.countyName}
        </span>
        {isLead ? <LeadTag auction={auction} /> : null}
      </span>
      {verbose ? (
        <span className="tnum ml-auto shrink-0 pl-2 text-xs text-muted">
          {num(auction.lotCount)}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Names *why* an entry is not bidding inventory, in the space of one word.
 *
 * The date claim outranks the document kind: on a calendar, the square a thing
 * sits in is itself an assertion that the sale happens that day.
 */
function LeadTag({ auction }: { auction: CalendarAuctionRow }) {
  const label = !auction.saleDateConfirmed
    ? "projected"
    : auction.listingKind === "delinquent_list"
      ? "roll"
      : auction.listingKind === "lands_available"
        ? "lands"
        : "unverified";
  return (
    <span className="whitespace-nowrap rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wide text-muted">
      {label}
    </span>
  );
}

function MonthNav({ filters }: { filters: CalendarFilters }) {
  const prev = shiftMonth(filters.month, -1);
  const next = shiftMonth(filters.month, 1);
  return (
    <div className="mb-5 flex items-center gap-2">
      <Link
        href={calendarHref(filters, { month: prev })}
        {...STAY_PUT}
        aria-label={`Previous month, ${monthLabel(prev)}`}
        className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition-colors hover:border-accent hover:text-foreground"
      >
        ‹
      </Link>
      <Link
        href={calendarHref(filters, { month: next })}
        {...STAY_PUT}
        aria-label={`Next month, ${monthLabel(next)}`}
        className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition-colors hover:border-accent hover:text-foreground"
      >
        ›
      </Link>
      <h2 className="ml-1 text-lg font-semibold tracking-tight">{monthLabel(filters.month)}</h2>
      {filters.month === filters.currentMonth ? null : (
        <Link
          href={calendarHref(filters, { month: filters.currentMonth })}
          {...STAY_PUT}
          className="ml-2 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-foreground"
        >
          Today
        </Link>
      )}
    </div>
  );
}

function Filters({
  filters,
  facets,
}: {
  filters: CalendarFilters;
  facets: { states: CalendarFacet[]; saleTypes: CalendarFacet[]; platforms: CalendarFacet[] };
}) {
  return (
    <div className="mb-5 space-y-2.5 rounded-xl border border-border bg-surface-2/40 p-3">
      <FilterRow label="State">
        <Chip href={calendarHref(filters, { states: [] })} active={filters.states.length === 0}>
          All
        </Chip>
        {facets.states.map((f) => (
          <Chip
            key={f.value}
            href={calendarHref(filters, { states: toggle(filters.states, f.value) })}
            active={filters.states.includes(f.value)}
            title={STATE_NAMES[f.value] ?? f.value}
            count={f.count}
          >
            {f.value}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Auction type">
        <Chip
          href={calendarHref(filters, { saleTypes: [] })}
          active={filters.saleTypes.length === 0}
        >
          All
        </Chip>
        {facets.saleTypes.map((f) => (
          <Chip
            key={f.value}
            href={calendarHref(filters, { saleTypes: toggle(filters.saleTypes, f.value) })}
            active={filters.saleTypes.includes(f.value)}
            count={f.count}
            dot={saleTypeColor(f.value)}
          >
            {f.value}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Platform">
        <Chip
          href={calendarHref(filters, { platforms: [] })}
          active={filters.platforms.length === 0}
        >
          All
        </Chip>
        {facets.platforms.map((f) => (
          <Chip
            key={f.value}
            href={calendarHref(filters, { platforms: toggle(filters.platforms, f.value) })}
            active={filters.platforms.includes(f.value)}
            count={f.count}
          >
            {platformLabel(f.value)}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Show">
        <Chip href={calendarHref(filters, { includeLeads: false })} active={!filters.includeLeads}>
          Confirmed sales
        </Chip>
        <Chip
          href={calendarHref(filters, { includeLeads: true })}
          active={filters.includeLeads}
          title="Also show delinquent rolls, lands-available inventory, and sales sitting under a projected date"
        >
          + research leads
        </Chip>
        {hasActiveFilters(filters) ? (
          <Link
            href={calendarHref(filters, {
              states: [],
              saleTypes: [],
              platforms: [],
              includeLeads: false,
            })}
            {...STAY_PUT}
            className="ml-auto self-center text-xs text-muted underline hover:text-foreground"
          >
            Clear all
          </Link>
        ) : null}
      </FilterRow>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  href,
  active,
  children,
  count,
  title,
  dot,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  count?: number;
  title?: string;
  dot?: string;
}) {
  return (
    <Link
      href={href}
      {...STAY_PUT}
      title={title}
      // Links, not toggle buttons — `aria-current` is the right state here.
      aria-current={active ? "true" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-border bg-surface text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {dot ? (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      ) : null}
      {children}
      {count === undefined ? null : (
        <span className={`tnum ${active ? "opacity-70" : "opacity-60"}`}>{count}</span>
      )}
    </Link>
  );
}

function Legend({ types }: { types: string[] }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {types.map((t) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: saleTypeColor(t) }}
          />
          {t}
        </span>
      ))}
    </div>
  );
}
