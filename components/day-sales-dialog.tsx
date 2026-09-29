"use client";

/**
 * The day's full sale list, as a popup.
 *
 * The month grid used to dump leftover counties into a `<details>` inside the
 * square. Opening "+9 more" stretched that cell — and every other Wednesday
 * with it — which is the opposite of a calendar you can scan. USTLA keeps the
 * grid still and opens a window. Same move: the cell stays four rows tall,
 * and the rest of the day is a dialog at body size, not 11px.
 */
import { useEffect, useId, useRef } from "react";
import Link from "next/link";
import { money, num, saleTypeColor } from "@/lib/format";

export type DaySaleRow = {
  id: string;
  stateName: string;
  countyName: string;
  saleType: string;
  lots: number;
  announced: boolean;
  cancelled: boolean;
  standingLabel: string | null;
  label: string | null;
  bids: number | null;
};

export function DaySalesDialog({
  dateIso,
  extraCount,
  saleCount,
  parcelCount,
  rows,
}: {
  dateIso: string;
  extraCount: number;
  saleCount: number;
  parcelCount: number;
  rows: DaySaleRow[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  function open() {
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  /*
   * Closed when the calendar goes away, not only when someone presses ×.
   *
   * `showModal()` makes everything outside the dialog inert. Picking a sale
   * navigates without closing it, and the router keeps the calendar mounted
   * but hidden for the back button — so the modal stayed open, invisible, and
   * every link on the sale page it led to was dead until a reload. Hiding a
   * kept route runs effect cleanup, so this closes it on the way out.
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => dialog?.close();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="mt-1 w-full rounded-md px-1.5 py-1 text-left text-cell font-medium text-accent
                   hover:bg-surface-2 hover:text-accent"
      >
        +{num(extraCount)} more
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="m-auto w-[min(56rem,calc(100vw-2rem))] max-h-[min(52rem,90dvh)] overflow-hidden
                   rounded-3xl border border-border/70 bg-surface p-0 text-foreground
                   shadow-[var(--shadow-md)] outline-none
                   backdrop:bg-ink/50 backdrop:backdrop-blur-[2px]
                   open:flex open:flex-col"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          ) {
            close();
          }
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div>
            <h2 id={titleId} className="text-3xl font-semibold tracking-tight">
              {longSaleDate(dateIso)}
            </h2>
            <p className="tnum mt-1.5 text-xl text-muted">
              {num(saleCount)} {saleCount === 1 ? "sale" : "sales"} · {num(parcelCount)} parcels
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-surface
                       text-foreground shadow-[var(--shadow-sm)] transition-all
                       hover:border-accent hover:text-accent active:scale-95"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/auctions/${row.id}`}
                onClick={close}
                className={[
                  "flex items-start gap-4 rounded-lg px-4 py-3.5 text-2xl leading-snug transition-colors hover:bg-surface-2",
                  row.cancelled ? "text-muted line-through" : "",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className="mt-2.5 h-3.5 w-3.5 shrink-0 rounded-full"
                  style={{ background: saleTypeColor(row.saleType) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{row.stateName}</span>
                  <span className="text-muted"> · </span>
                  {row.countyName}
                  {row.label ? (
                    <>
                      <span className="text-muted"> · </span>
                      {row.label}
                    </>
                  ) : null}
                  {row.standingLabel ? (
                    <span className="ml-2 inline-block rounded bg-surface-2 px-1.5 align-middle text-base font-medium uppercase tracking-wide text-muted">
                      {row.standingLabel}
                    </span>
                  ) : null}
                </span>
                <span className="ml-auto shrink-0 pl-4 text-right text-xl text-muted">
                  <span
                    className={`tnum whitespace-nowrap ${
                      row.announced ? "underline decoration-dotted underline-offset-2" : ""
                    }`}
                    title={
                      row.announced
                        ? `${num(row.lots)} parcels announced by the county — the parcel list has not been fetched yet`
                        : undefined
                    }
                  >
                    {num(row.lots)} parcels
                  </span>
                  {row.bids === null ? null : (
                    <>
                      <span aria-hidden> · </span>
                      <span className="tnum whitespace-nowrap">{money(row.bids, { compact: true })}</span>
                    </>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}

/** "Wednesday, September 9, 2026" — UTC, same as every other sale date here. */
function longSaleDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
