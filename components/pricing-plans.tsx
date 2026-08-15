/**
 * The plan table. Shared by `/pricing` and the home page so the two cannot
 * disagree about what a tier costs — `lib/billing/plans.ts` stays the single
 * source of truth for the limits themselves.
 */
import Link from "next/link";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";

export function PricingPlans({ heading = true }: { heading?: boolean }) {
  return (
    <>
      <header className="mb-10 max-w-2xl">
        {heading ? <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1> : null}
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
              /*
               * The featured plan was distinguished by a 1px accent border, which
               * is the least a design can do — beside three identical cards it
               * read as a rendering artefact rather than a recommendation. It now
               * lifts: an accent ring, a bloom beneath, and a step up the page.
               */
              className={`relative flex flex-col rounded-2xl border p-6 transition-transform ${
                featured
                  ? "border-accent/40 bg-surface shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent),0_18px_44px_-16px_color-mix(in_srgb,var(--accent)_55%,transparent)] lg:-mt-3 lg:pb-9"
                  : "border-border/70 bg-surface shadow-[var(--shadow-sm)] hover:border-border"
              }`}
            >
              {featured ? (
                <div className="mb-3 -mt-1 self-start rounded-full bg-accent px-3 py-1 text-[10px]
                                font-semibold uppercase tracking-[0.08em] text-accent-fg
                                shadow-[0_4px_14px_-4px_color-mix(in_srgb,var(--accent)_70%,transparent)]">
                  Most popular
                </div>
              ) : null}
              <h2 className="font-semibold">{plan.name}</h2>
              <div className="tnum mt-2 flex items-baseline gap-1">
                {/* The price is the thing being compared, so it should be the
                    largest thing on the card — it was the same size as a heading. */}
                <span className="text-4xl font-semibold tracking-[-0.02em]">${plan.price}</span>
                {plan.price > 0 ? <span className="text-sm text-muted">/month</span> : null}
              </div>
              <p className="mt-2 min-h-10 text-sm leading-relaxed text-muted">{plan.tagline}</p>

              <ul className="mt-5 flex-1 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    {/* A drawn check at a fixed size, not a glyph — the text tick
                        renders at a different weight in every font and sat
                        misaligned against its line. */}
                    <svg
                      aria-hidden
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span className="text-muted">{f}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.price === 0 ? "/atlas" : `/signup?plan=${plan.id}`}
                className={`mt-6 rounded-full px-4 py-2.5 text-center text-sm font-medium
                            transition-all active:scale-[0.98] ${
                  featured
                    ? "bg-accent text-accent-fg shadow-[0_10px_28px_-10px_color-mix(in_srgb,var(--accent)_75%,transparent)] hover:brightness-110"
                    : "border border-border/70 hover:border-accent/50 hover:bg-surface-2/60"
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
    </>
  );
}
