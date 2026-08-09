import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { AuctionListSkeleton } from "@/components/skeleton";
import { AuctionsList } from "@/components/auctions-list";

export const metadata: Metadata = {
  title: "Upcoming tax sale auctions",
  description:
    "Every upcoming tax deed, tax lien, and redeemable deed auction we track, with lot counts and opening bids.",
};

export const unstable_instant = {
  prefetch: "runtime",
  // The samples are the entry points validation walks. Both matter: the bare
  // list is what the nav links to, and `?state=` is what every filter chip
  // produces, so a boundary that blocks only when a filter is on would
  // otherwise ship unnoticed.
  samples: [{ searchParams: { state: null } }, { searchParams: { state: "MI" } }],
};

/**
 * The dedicated auctions route. The list itself is `<AuctionsList>`, shared
 * with the home page; only the chrome differs.
 */
export default function AuctionsPage(props: PageProps<"/auctions">) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Auctions" }]} />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Upcoming auctions</h1>
        <Link
          href="/calendar"
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
        >
          Calendar view
        </Link>
      </header>
      <Suspense fallback={<AuctionListSkeleton />}>
        <AuctionsList searchParams={props.searchParams} basePath="/auctions" />
      </Suspense>
    </div>
  );
}
