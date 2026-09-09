/**
 * The atlas index — sale type per state and the way into 1,010 researched
 * counties.
 *
 * Shared by `/atlas` and the home page. Only the state grid collapses into a
 * section: the 1,010 county pages beneath it stay real routes, because they
 * are the SEO surface and no amount of scrolling substitutes for a URL a
 * search engine can index.
 */
import Link from "next/link";
import {
  STATE_DATA,
  STATE_NAMES,
  TYPE_COLORS,
  TYPE_DESCRIPTIONS,
  countiesInState,
  researchedCountCount,
  stateSlug,
  isCovered,
  toSaleType,
} from "@/lib/atlas";
import { num } from "@/lib/format";
import { SaleTypeBadge } from "@/components/ui";

export function AtlasStates({
  heading = true,
  intro = true,
}: {
  heading?: boolean;
  /** The explanatory paragraph and type legend. Off where a map already says it. */
  intro?: boolean;
}) {
  const states = Object.keys(STATE_DATA).sort((a, b) =>
    (STATE_NAMES[a] ?? a).localeCompare(STATE_NAMES[b] ?? b),
  );

  const totalResearched = states.reduce((n, s) => n + researchedCountCount(s), 0);

  return (
    <>
      {intro ? (
      <header className="mb-8 max-w-3xl">
        {heading ? (
          <h1 className="text-3xl font-semibold tracking-tight">Tax sale atlas</h1>
        ) : null}
        <p className="mt-2 leading-relaxed text-muted">
          How tax-defaulted property is sold in every U.S. state and county — sale type, redemption
          period, investor return, and governing statute. {num(totalResearched)} counties have been
          individually researched with auction logistics, surviving-lien analysis, and quiet-title
          guidance; the rest inherit their state&apos;s defaults, and we label which is which on
          every page.
        </p>
      </header>
      ) : null}

      {intro ? (
      <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(TYPE_COLORS) as (keyof typeof TYPE_COLORS)[]).map((t) => (
          <div key={t} className="rounded-xl border border-border bg-surface p-4">
            <SaleTypeBadge type={t} />
            <p className="mt-2 text-xs leading-relaxed text-muted">{TYPE_DESCRIPTIONS[t]}</p>
          </div>
        ))}
      </section>
      ) : null}

      {intro ? <h2 className="mb-3 text-lg font-semibold">States</h2> : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {states.map((s) => {
          const rule = STATE_DATA[s];
          const researched = researchedCountCount(s);
          const total = countiesInState(s).length;

          return (
            <Link
              key={s}
              href={`/atlas/${stateSlug(s)}`}
              className="group flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium group-hover:text-accent">
                    {STATE_NAMES[s] ?? s}
                  </span>
                  {isCovered(s) ? (
                    <span className="rounded bg-accent px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-fg">
                      Live auctions
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5">
                  <SaleTypeBadge type={toSaleType(rule.type)} />
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {num(total)} counties
                  {researched > 0 ? ` · ${num(researched)} researched` : ""}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
