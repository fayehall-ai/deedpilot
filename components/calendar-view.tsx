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
  getDefaultCalendarMonth,
  getNextCalendarDate,
  type CalendarAuctionRow,
  type CalendarFacet,
} from "@/lib/queries";
import { money, num, platformLabel, relativeDays, saleDate, saleTypeColor, parcelsShown } from "@/lib/format";
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
  /*
   * Resolved even when `?m=` is present: `calendarHref` compares against it to
   * decide whether to write the parameter at all, so a request that skipped the
   * lookup would emit a different URL for the same month than one that didn't.
   * It is a cached, filter-independent value, so this costs one memoised read.
   */
  const filters = parseCalendarFilters(
    params,
    today,
    props.basePath ?? "/calendar",
    await getDefaultCalendarMonth(),
  );

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
  // Parcels on offer, not parcels held: an imported sale contributes its
  // announced count, or the headline would read 0 for a month of real auctions.
  const lotTotal = inMonth.reduce((n, r) => n + parcelsShown(r).count, 0);
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
      <CalendarControls
        filters={filters}
        facets={facets}
        summary={
          inMonth.length === 0
            ? `No sales in ${monthLabel(filters.month)} matching these filters`
            : `${num(inMonth.length)} ${inMonth.length === 1 ? "sale" : "sales"} · ${num(countyTotal)} ${countyTotal === 1 ? "county" : "counties"} · ${num(lotTotal)} parcels`
        }
      />

      {typesInView.length > 0 ? <Legend types={typesInView} /> : null}

      {/*
        The month grid, from `xl` up.
        It used to appear at `lg` (1024px), where seven columns leave ~140px
        per day. Raising the type to a readable size made that a grid you can
        see but not read — county names truncated to a letter, "ANNOUNCED"
        wrapping under every row. 1024px is a tablet in landscape and a small
        laptop; the agenda below carries everything narrower, with full names.
      */}
      <div className="hidden xl:block">
        {/*
          A card, not a table.
          
          Hard borders at full strength on every cell made this read as a
          spreadsheet — which is accurate about the data and wrong about the
          product. Grid lines drop to a third strength so they separate without
          drawing, and the whole thing sits on elevation like the other surfaces.
        */}
        <div className="grid grid-cols-7 overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-[var(--shadow-md)]">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="border-b border-border/70 bg-surface-2/50 px-2 py-3 text-center text-xs font-semibold uppercase tracking-[0.12em] text-muted"
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
                  "min-h-44 border-border/40 p-2.5 transition-colors",
                  // A day is clickable in effect — its sales are — so it should
                  // acknowledge the cursor. Nothing here did before.
                  cell.inMonth ? "hover:bg-surface-2/40" : "",
                  // No right border on the last column, no bottom on the last row.
                  (i + 1) % 7 === 0 ? "" : "border-r",
                  i < weeks.flat().length - 7 ? "border-b" : "",
                  !cell.inMonth
                    ? "bg-surface-2/50"
                    : cell.isToday
                      ? "bg-gold/[0.12]"
                      : cell.isWeekend
                        ? "bg-surface-2/25"
                        : "",
                ].join(" ")}
              >
                <div className="mb-2 flex items-center justify-between gap-1">
                  <span
                    className={
                      cell.isToday
                        // Today is a fact, not a control — gold marks it, so it
                        // cannot be mistaken for the blue of an active filter.
                        // Sized in em so the disc grows with the numeral.
                        ? "grid h-[1.85em] w-[1.85em] place-items-center rounded-full bg-gold text-day text-ink shadow-[0_0_0_3px_color-mix(in_srgb,var(--gold)_28%,transparent)]"
                        : `text-day ${cell.inMonth ? "text-foreground" : "text-muted/50"}`
                    }
                  >
                    {cell.dayOfMonth}
                  </span>
                  {/* Lots, not sales — the number that says where the volume is.
                      A day with one 400-lot county outranks a day with four
                      counties selling three parcels each. */}
                  {sales.length > 0 ? (
                    <span
                      className="tnum text-xs font-semibold text-foreground"
                      title={`${num(dayParcels(sales).total)} parcels across ${num(sales.length)} ${sales.length === 1 ? "sale" : "sales"}${bidPhrase(
                        sumBids(sales),
                      )}${announcedPhrase(dayParcels(sales).announced)}`}
                    >
                      {num(dayParcels(sales).total)}
                    </span>
                  ) : null}
                </div>

                <ul className="space-y-1">
                  {groups.slice(0, MAX_PER_CELL).map((g) => (
                    <li key={g.key}>
                      <SaleEntry group={g} />
                    </li>
                  ))}
                </ul>

                {groups.length > MAX_PER_CELL ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer list-none px-1.5 py-0.5 text-cell font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                      +{groups.length - MAX_PER_CELL} more
                    </summary>
                    <ul className="mt-1 space-y-1">
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

      {/* The same days as an agenda, everywhere narrower than `xl`. A
          7-column grid on a phone or a small laptop is unreadable, and this
          is the view someone opens standing in a courthouse hallway. */}
      <div className="xl:hidden">
        {[...byDay.entries()].length === 0 ? null : (
          <div className="space-y-6">
            {[...byDay.entries()].map(([day, sales]) => (
              <section key={day}>
                <div className="mb-2.5 flex items-baseline gap-2 border-b border-border pb-2">
                  <h2 className="text-base font-semibold">{saleDate(day)}</h2>
                  <span className="text-sm text-muted">{relativeDays(day)}</span>
                  <span className="tnum ml-auto text-sm font-medium text-foreground">
                    {num(dayParcels(sales).total)} parcels
                  </span>
                </div>
                <ul className="space-y-1.5">
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
            Showing only published sale lists on county-published dates. Sale dates and parcel counts
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
  const standing = saleStanding(lead);
  const isLead = standing === "lead";

  return (
    <details className="group/entry">
      <summary
        title={`${county}, ${stateName} — ${num(group.sales.length)} separate ${lead.saleType} sales, ${num(group.lotTotal)} parcels total${announcedPhrase(group.announcedTotal)}${bidPhrase(group.bidTotal)}, ${platformLabel(lead.platform)}${
          group.cancelledCount ? ` (${num(group.cancelledCount)} cancelled)` : ""
        }`}
        className={[
          "flex cursor-pointer list-none items-start gap-2 rounded-md px-1.5 py-1 leading-snug transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden",
          verbose ? "text-base" : "text-cell",
          isLead ? "border-l-2 border-dashed border-border pl-1.5" : "",
        ].join(" ")}
      >
        <span
          aria-hidden
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
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
          <span className="tnum inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-surface-2 px-1 text-[0.85em] text-muted">
            ×{group.sales.length}
            <span aria-hidden className="transition-transform group-open/entry:rotate-90">
              ›
            </span>
          </span>
          {showLeadTag(standing, verbose) ? <LeadTag auction={lead} standing={standing} /> : null}
          {/* A cancellation must be visible without opening the group — the one
              thing collapsing rows could otherwise bury. */}
          {group.cancelledCount > 0 && !group.allCancelled ? (
            <span className="whitespace-nowrap text-[0.85em] uppercase tracking-wide text-warn">
              {num(group.cancelledCount)} cancelled
            </span>
          ) : null}
        </span>
        {verbose ? <Totals lots={group.lotTotal} bids={group.bidTotal} /> : null}
      </summary>

      <ul className="mt-0.5 space-y-0.5 border-l border-border pl-2 ml-2">
        {group.sales.map((a, i) => {
          const cancelled = a.status === "cancelled" || a.status === "postponed";
          return (
            <li key={a.id}>
              <Link
                href={`/auctions/${a.id}`}
                title={`${a.title ?? county} — ${num(parcelsShown(a).count)} parcels${
                  parcelsShown(a).announced ? " announced, list not yet fetched" : ""
                }${bidPhrase(sumBids([a]))}${cancelled ? `, ${a.status}` : ""}`}
                className={`flex items-baseline gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2 ${
                  verbose ? "text-base" : "text-cell"
                }`}
              >
                <span
                  className={`min-w-0 flex-1 truncate ${cancelled ? "text-muted line-through" : ""}`}
                >
                  {/* Falls back to an ordinal when the county publishes no
                      distinguishing title — never an unlabelled row. */}
                  {group.labels[i] ?? `Sale ${i + 1}`}
                </span>
                <AnnouncedCount sale={a} />
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
  const standing = saleStanding(auction);
  const isLead = standing === "lead";
  const cancelled = auction.status === "cancelled" || auction.status === "postponed";

  return (
    <Link
      href={`/auctions/${auction.id}`}
      title={`${county}, ${stateName} — ${auction.saleType}, ${num(parcelsShown(auction).count)} parcels${bidPhrase(
        sumBids([auction]),
      )}, ${platformLabel(auction.platform)}`}
      className={[
        // Wraps rather than truncates: the county name is the whole point of
        // the entry, and a lead tag alongside it turns "SC · Greenville" into
        // "SC · Gree…" in a 200px square. Two lines beats an ellipsis.
        "flex items-start gap-2 rounded-md px-1.5 py-1 leading-snug transition-colors hover:bg-surface-2",
        verbose ? "text-base" : "text-cell",
        isLead ? "border-l-2 border-dashed border-border pl-1.5" : "",
      ].join(" ")}
    >
      <span
        aria-hidden
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
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
        {showLeadTag(standing, verbose) ? <LeadTag auction={auction} standing={standing} /> : null}
      </span>
      {verbose ? <Totals lots={parcelsShown(auction).count} bids={sumBids([auction])} /> : null}
    </Link>
  );
}

/**
 * What a sale is worth looking at, in the agenda's right-hand column.
 *
 * Two numbers rather than one because they answer different questions: lots is
 * how much there is to work through, opening bids is whether it is worth the
 * drive. The grid squares stay lots-only — a second figure still will not fit
 * next to a county name — and the bid total hangs off the tooltip there.
 *
 * "lots" is spelled out now that the column carries two figures; a bare pair of
 * numbers side by side gives no clue which is which.
 */
function Totals({ lots, bids }: { lots: number; bids: number | null }) {
  return (
    <span className="ml-auto shrink-0 pl-2 text-right text-sm text-muted">
      <span className="tnum whitespace-nowrap">{num(lots)} parcels</span>
      {bids === null ? null : (
        <>
          <span aria-hidden> · </span>
          <span className="tnum whitespace-nowrap">{money(bids, { compact: true })}</span>
        </>
      )}
    </span>
  );
}

/**
 * Opening bids across a set of sales, or null when none published any.
 *
 * Mirrors `groupSalesByCounty`'s `bidTotal` for the callers that hold loose
 * rows rather than a group — and drops nulls before the cast for the same
 * reason it does: `Number(null)` is 0, and a missing bid sheet must not be
 * able to claim every parcel opens free.
 */
/**
 * How much to trust a row, in the two ways it can fall short.
 *
 * A *lead* is something that may not be a sale at all: a projected date, or a
 * delinquent roll parsed as though it were inventory. It gets the dashed border
 * because it might evaporate.
 *
 * An *announced* sale is not that. Its date is county-published and its
 * existence is not in doubt; what is missing is the parcel list. Imported rows
 * carry `listing_kind = 'unknown'` — honestly, since no document has been read
 * for them — and the old test keyed on that alone, so every imported sale would
 * have rendered as "unverified" behind a dashed border. That is a stronger
 * claim against them than the data supports, and it would have made a freshly
 * imported calendar look broken.
 */
function saleStanding(a: {
  listingKind: string;
  saleDateConfirmed: boolean;
  lotCount: number;
  announcedParcelCount?: number | null;
}): "inventory" | "announced" | "lead" {
  if (!a.saleDateConfirmed) return "lead";
  if (a.listingKind === "sale_list" && a.lotCount > 0) return "inventory";
  if (parcelsShown(a).announced && parcelsShown(a).count > 0) return "announced";
  return a.listingKind === "sale_list" ? "inventory" : "lead";
}

/**
 * Whether a standing-tag belongs on this row.
 *
 * In the month grid, "announced" applies to most of the imported calendar —
 * rendering it as a badge wraps every county name onto two lines and then
 * truncates the name anyway. The dotted underline on nested precinct counts
 * and the tooltip already carry that fact. The agenda has the width, so it
 * still shows the word. Leads (projected / roll / lands) stay visible in both:
 * those are the rows that might not be a sale at all.
 */
function showLeadTag(
  standing: "inventory" | "announced" | "lead",
  verbose: boolean,
): standing is "announced" | "lead" {
  if (standing === "inventory") return false;
  if (standing === "announced") return verbose;
  return true;
}

function sumBids(sales: CalendarAuctionRow[]): number | null {
  const present = sales
    .map((s) => s.totalOpeningBids)
    .filter((v): v is string => v !== null && v !== "")
    .map(Number)
    .filter(Number.isFinite);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** "$1.2M in opening bids", or nothing — a tooltip should not trail into "—". */
function bidPhrase(total: number | null): string {
  return total === null ? "" : `, ${money(total, { compact: true })} in opening bids`;
}

/**
 * Parcels on a day, and how many of them are only announced.
 *
 * The grid now has room for the number itself. An announced sale still cannot
 * carry a badge there — a second word would wrap the row — so the distinction
 * moves into the tooltip and into the dotted underline below.
 */
function dayParcels(sales: CalendarAuctionRow[]): { total: number; announced: number } {
  let total = 0;
  let announced = 0;
  for (const a of sales) {
    const p = parcelsShown(a);
    total += p.count;
    if (p.announced) announced += p.count;
  }
  return { total, announced };
}

/** Tooltip clause naming the announced share, or nothing when there is none. */
function announcedPhrase(announced: number): string {
  return announced > 0 ? ` \u00b7 ${num(announced)} announced, list not yet fetched` : "";
}

/**
 * A sale's parcel count, marked when it is the county's claim rather than ours.
 *
 * A dotted underline rather than a badge or a colour: a badge would wrap the
 * row and a colour would collide with the sale-type legend. The underline is
 * the conventional "there is more to know here" affordance.
 */
function AnnouncedCount({
  sale,
}: {
  sale: { lotCount: number; announcedParcelCount?: number | null };
}) {
  const p = parcelsShown(sale);
  if (!p.announced) return <span className="tnum shrink-0 pl-1 font-medium text-muted">{num(p.count)}</span>;
  return (
    <span
      className="tnum shrink-0 pl-1 font-medium text-muted underline decoration-dotted underline-offset-2"
      title={`${num(p.count)} parcels announced by the county — the parcel list has not been fetched yet`}
    >
      {num(p.count)}
    </span>
  );
}

/**
 * Names *why* an entry is not bidding inventory, in the space of one word.
 *
 * The date claim outranks the document kind: on a calendar, the square a thing
 * sits in is itself an assertion that the sale happens that day.
 */
function LeadTag({
  auction,
  standing,
}: {
  auction: CalendarAuctionRow;
  standing: "announced" | "lead";
}) {
  const label =
    standing === "announced"
      ? "announced"
      : !auction.saleDateConfirmed
        ? "projected"
        : auction.listingKind === "delinquent_list"
          ? "roll"
          : auction.listingKind === "lands_available"
            ? "lands"
            : "unverified";
  /*
   * `em`, not a tier. This badge annotates rows of two different sizes: the
   * month grid (`text-cell`) and the mobile list (`text-base`). Pinned at an
   * absolute 9px it was right in the old 11px grid and unreadable on a phone.
   * Sized against its parent it stays one step under whatever it annotates.
   */
  return (
    <span className="whitespace-nowrap rounded bg-surface-2 px-1 text-[0.8em] font-medium uppercase tracking-wide text-muted">
      {label}
    </span>
  );
}

/**
 * Month navigation, the state filter, and everything else — in three lines.
 *
 * The previous version stacked four labelled chip rows inside a bordered panel
 * above the grid. On the home page that put ~330px of chrome between the
 * heading and the first sale, which is backwards: the calendar is the thing
 * people came for and the filters are how they narrow it once.
 *
 * So the month and the month's totals share one line, the state chips — far
 * and away the most-used filter — sit unlabelled on the next, and auction
 * type, platform and the leads toggle fold into a disclosure.
 *
 * The disclosure opens itself whenever one of those filters is on. A hidden
 * active filter is the reason a page shows fewer sales than someone expects
 * with no visible cause, and it is worth the extra line to never do that.
 */
function CalendarControls({
  filters,
  facets,
  summary,
}: {
  filters: CalendarFilters;
  facets: { states: CalendarFacet[]; saleTypes: CalendarFacet[]; platforms: CalendarFacet[] };
  summary: string;
}) {
  const prev = shiftMonth(filters.month, -1);
  const next = shiftMonth(filters.month, 1);
  const secondaryActive =
    filters.saleTypes.length > 0 || filters.platforms.length > 0 || filters.includeLeads;

  return (
    <div className="mb-5 space-y-3">
      {/* Month, and what is in it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          {/*
            Was 28px square holding a text chevron at body size — under the 44px
            a finger expects, and visually so light it read as decoration beside
            the month name rather than the control that changes it. Now 40px,
            with a drawn chevron at a real stroke weight, on a surface that looks
            pressable.
          */}
          <Link
            href={calendarHref(filters, { month: prev })}
            {...STAY_PUT}
            aria-label={`Previous month, ${monthLabel(prev)}`}
            className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-surface
                       text-foreground shadow-[var(--shadow-sm)] transition-all
                       hover:border-accent hover:text-accent active:scale-95"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <Link
            href={calendarHref(filters, { month: next })}
            {...STAY_PUT}
            aria-label={`Next month, ${monthLabel(next)}`}
            className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-surface
                       text-foreground shadow-[var(--shadow-sm)] transition-all
                       hover:border-accent hover:text-accent active:scale-95"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
          </Link>
        </div>
        <h3 className="text-2xl font-semibold tracking-tight">{monthLabel(filters.month)}</h3>
        {filters.month === filters.currentMonth ? null : (
          <Link
            href={calendarHref(filters, { month: filters.currentMonth })}
            {...STAY_PUT}
            className="rounded-md border border-border px-2.5 py-1 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
          >
            Today
          </Link>
        )}
        <span className="tnum ml-auto text-base text-muted">{summary}</span>
      </div>

      {/* The filter people actually reach for. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip href={calendarHref(filters, { states: [] })} active={filters.states.length === 0}>
          All states
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
        {hasActiveFilters(filters) ? (
          <Link
            href={calendarHref(filters, {
              states: [],
              saleTypes: [],
              platforms: [],
              includeLeads: false,
            })}
            {...STAY_PUT}
            className="ml-1 text-sm text-muted underline hover:text-foreground"
          >
            Clear all
          </Link>
        ) : null}
      </div>

      <details open={secondaryActive} className="group/filters">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="transition-transform group-open/filters:rotate-90">
            ›
          </span>
          Type, platform &amp; leads
          {secondaryActive ? (
            <span className="rounded-full bg-gold px-1.5 text-xs font-medium text-ink">on</span>
          ) : null}
        </summary>

        <div className="mt-2 space-y-2 border-l border-border pl-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              href={calendarHref(filters, { saleTypes: [] })}
              active={filters.saleTypes.length === 0}
            >
              All types
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
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              href={calendarHref(filters, { platforms: [] })}
              active={filters.platforms.length === 0}
            >
              All platforms
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
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              href={calendarHref(filters, { includeLeads: false })}
              active={!filters.includeLeads}
            >
              Confirmed sales
            </Chip>
            <Chip
              href={calendarHref(filters, { includeLeads: true })}
              active={filters.includeLeads}
              title="Also show delinquent rolls, lands-available inventory, and sales sitting under a projected date"
            >
              + research leads
            </Chip>
          </div>
        </div>
      </details>
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
      /*
       * Filters are the most-used control on this page and were 20px tall with
       * a hairline border — smaller than the text beside them and easy to miss.
       * Taller, with the active state carrying a bloom so the current filter is
       * obvious from across the page rather than on inspection.
       *
       * Gold, because "which filter am I on" is the single fact this row exists
       * to report, and gold is now what the page uses to say "this one".
       */
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm
                  font-medium transition-all active:scale-[0.97] ${
        active
          ? "border-gold bg-gold text-ink shadow-[0_4px_14px_-4px_color-mix(in_srgb,var(--gold)_70%,transparent)]"
          : "border-border/70 bg-surface text-muted hover:border-accent/50 hover:bg-surface-2/60 hover:text-foreground"
      }`}
    >
      {dot ? (
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: dot }} />
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
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted">
      {types.map((t) => (
        <span key={t} className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: saleTypeColor(t) }}
          />
          {t}
        </span>
      ))}
    </div>
  );
}
