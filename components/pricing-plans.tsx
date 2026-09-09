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
        {heading ? <h1 className="text-section font-semibold">Pricing</h1> : null}
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
               * The recommendation is gold, not blue.
               *
               * Blue was doing two jobs — "you can act on this" and "this is the
               * notable one" — so a featured card and an active filter competed
               * for the same meaning. Splitting them: blue stays interaction
               * (links, buttons, current filter), gold marks the one thing on a
               * surface worth noticing. Gold is also simply what a recommendation
               * has looked like for a very long time.
               *
               * The button below stays blue, because pressing it is an action.
               */
              className={`relative flex flex-col rounded-2xl border p-6 transition-transform ${
                featured
                  ? "border-gold/50 bg-surface shadow-[0_0_0_1px_color-mix(in_srgb,var(--gold)_55%,transparent),0_18px_44px_-16px_color-mix(in_srgb,var(--gold)_60%,transparent)] lg:-mt-3 lg:pb-9"
                  : "border-border/70 bg-surface shadow-[var(--shadow-sm)] hover:border-border"
              }`}
            >
              {featured ? (
                <div className="mb-3 -mt-1 self-start rounded-full bg-gold px-3 py-1 text-xs
                                font-semibold uppercase tracking-[0.08em] text-ink
                                shadow-[0_4px_14px_-4px_color-mix(in_srgb,var(--gold)_80%,transparent)]">
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
                    ? "bg-gold text-ink font-semibold shadow-[0_10px_28px_-10px_color-mix(in_srgb,var(--gold)_85%,transparent)] hover:brightness-105"
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
