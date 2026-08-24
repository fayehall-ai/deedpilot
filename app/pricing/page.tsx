import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { PricingPlans } from "@/components/pricing-plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "The rules atlas is free. Parcel-level auction data, the max-bid engine, and the live co-pilot start at $49/month.",
};

export default function PricingPage() {
  return (
    <div className="shell py-band">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Pricing" }]} />
      <PricingPlans />
    </div>
  );
}
