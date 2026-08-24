import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { CalendarSkeleton } from "@/components/skeleton";
import { CalendarView } from "@/components/calendar-view";

export const metadata: Metadata = {
  title: "Tax sale calendar",
  description:
    "Every tracked tax deed, tax lien, and redeemable deed sale on a month calendar, filterable by state, auction type, and platform. Each day links to the counties selling that day.",
};

export const unstable_instant = {
  prefetch: "runtime",
  // Every filter this page encodes in the URL, in the two states that matter:
  // the bare month a nav click produces, and a fully-filtered view. Validation
  // walks both, so a Suspense boundary that blocks only once filters are on
  // cannot slip through.
  samples: [
    { searchParams: { m: null, state: null, type: null, platform: null, leads: null } },
    { searchParams: { m: "2026-09", state: "MI", type: "deed", platform: "taxsaleinfo", leads: "1" } },
  ],
};

/**
 * The dedicated calendar route.
 *
 * The grid itself is `<CalendarView>`, shared with the home page — only the
 * page chrome differs. Everything below the heading streams in behind the
 * boundary, so a click paints immediately.
 */
export default function CalendarPage(props: PageProps<"/calendar">) {
  return (
    <div className="mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Calendar" }]} />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tax sale calendar</h1>
        </div>
        <Link
          href="/auctions"
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
        >
          List view
        </Link>
      </header>
      <Suspense fallback={<CalendarSkeleton />}>
        <CalendarView searchParams={props.searchParams} basePath="/calendar" />
      </Suspense>
    </div>
  );
}
