import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { AtlasStates } from "@/components/atlas-states";

export const metadata: Metadata = {
  title: "Tax sale atlas — all 50 states and 3,142 counties",
  description:
    "How tax lien, tax deed, and redeemable deed sales work in all 50 states and 3,142 counties: redemption periods, investor returns, governing statutes, and auction logistics.",
};

export default function AtlasPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Atlas" }]} />
      <AtlasStates />
    </div>
  );
}
