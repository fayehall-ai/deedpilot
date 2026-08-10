import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { AtlasMap } from "@/components/atlas-map";
import { AtlasStates } from "@/components/atlas-states";

export const metadata: Metadata = {
  title: "Tax sale atlas — all 50 states and 3,142 counties",
  description:
    "How tax lien, tax deed, and redeemable deed sales work in all 50 states and 3,142 counties: redemption periods, investor returns, governing statutes, and auction logistics.",
};

/**
 * The top of the drill-down: national map → a state's counties → one county.
 *
 * Each step is a route rather than client state, which is what lets the 1,010
 * researched county pages stay indexable and linkable.
 */
export default function AtlasPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Atlas" }]} />
      <section className="mb-8 rounded-xl border border-border bg-surface p-4">
        <AtlasMap />
      </section>
      <AtlasStates />
    </div>
  );
}
