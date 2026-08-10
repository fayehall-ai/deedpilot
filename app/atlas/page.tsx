import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { AtlasExplorer } from "@/components/atlas-explorer";
import { AtlasStates } from "@/components/atlas-states";
import { STATE_PATHS } from "@/lib/atlas/geo";

export const metadata: Metadata = {
  title: "Tax sale atlas — all 50 states and 3,142 counties",
  description:
    "How tax lien, tax deed, and redeemable deed sales work in all 50 states and 3,142 counties: redemption periods, investor returns, governing statutes, and auction logistics.",
};

/**
 * The interactive atlas. Drilling national → state → county happens in place;
 * the routes underneath still exist for deep links, new tabs and crawlers,
 * which is what every shape's href points at.
 */
export default function AtlasPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Atlas" }]} />
      <h1 className="mb-4 text-3xl font-semibold tracking-tight">Tax sale atlas</h1>
      <AtlasExplorer states={STATE_PATHS} />
      <details className="group/states mt-10">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="transition-transform group-open/states:rotate-90">
            ›
          </span>
          Browse all 51 as a list
        </summary>
        <div className="mt-4">
          <AtlasStates heading={false} />
        </div>
      </details>
    </div>
  );
}
