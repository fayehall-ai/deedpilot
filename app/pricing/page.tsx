import type { Metadata } from "next";
import Link from "next/link";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";
import { Breadcrumbs } from "@/components/ui";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "The rules atlas is free. Parcel-level auction data, the max-bid engine, and the live co-pilot start at $49/month.",
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Pricing" }]} />

      <header className="mb-10 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="mt-2 leading-relaxed text-muted">
          The rules atlas and the auction calendar are free, permanently. You pay when you want
          parcel-level inventory and the tools that tell you what to bid.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-4">
        {PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const featured = id === "pro";
          return (
            <div
              key={id}
              className={`flex flex-col rounded-xl border p-6 ${
                featured ? "border-accent bg-surface shadow-sm" : "border-border bg-surface"
              }`}
            >
              {featured ? (
                <div className="mb-3 -mt-1 self-start rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-fg">
                  Most popular
                </div>
              ) : null}
              <h2 className="font-semibold">{plan.name}</h2>
              <div className="tnum mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-semibold">${plan.price}</span>
                {plan.price > 0 ? <span className="text-sm text-muted">/month</span> : null}
              </div>
              <p className="mt-2 min-h-10 text-sm leading-relaxed text-muted">{plan.tagline}</p>

              <ul className="mt-5 flex-1 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden className="text-accent">
                      ✓
                    </span>
                    <span className="text-muted">{f}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.price === 0 ? "/atlas" : `/signup?plan=${plan.id}`}
                className={`mt-6 rounded-lg px-4 py-2.5 text-center text-sm font-medium ${
                  featured
                    ? "bg-accent text-accent-fg hover:opacity-90"
                    : "border border-border hover:border-accent"
                }`}
              >
                {plan.price === 0 ? "Explore the atlas" : `Start with ${plan.name}`}
              </Link>
            </div>
          );
        })}
      </div>

      <p className="mt-8 max-w-2xl text-xs leading-relaxed text-muted">
        Parcel-level coverage currently means Florida, Georgia, Texas, Arizona, and Michigan. If you
        bid somewhere else, the atlas is free and useful — but Starter and above will not have
        inventory for you yet. We would rather tell you that now than take the subscription.
      </p>
    </div>
  );
}
