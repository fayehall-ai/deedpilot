import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  COUNTY_DATA,
  STATE_NAMES,
  countySlug,
  getCounty,
  isCovered,
  resolveBySlug,
  stateSlug,
  toSaleType,
} from "@/lib/atlas";
import type { LinkRef } from "@/lib/atlas/types";
import { num } from "@/lib/format";
import { Breadcrumbs, Callout, Card, SaleTypeBadge } from "@/components/ui";
import { statuteFor } from "@/lib/deal/statute";

/**
 * Pre-render only the individually researched counties. The remaining ~3,000
 * inherit state defaults and render on demand — building 3,142 pages at deploy
 * time to say "see the state page" is a lot of build minutes for no content.
 */
export function generateStaticParams() {
  return Object.keys(COUNTY_DATA).flatMap((fips) => {
    const c = getCounty(fips);
    return c ? [{ state: stateSlug(c.state), county: countySlug(c.name) }] : [];
  });
}

export async function generateMetadata(
  props: PageProps<"/atlas/[state]/[county]">,
): Promise<Metadata> {
  const { state, county } = await props.params;
  const rule = resolveBySlug(state, county);
  if (!rule) return { title: "County not found" };
  const c = rule.county;
  return {
    title: `${c.name} County, ${c.state} tax sales — ${rule.type}`,
    description: `How tax sales work in ${c.name} County, ${c.stateName}: ${rule.type}, redemption ${rule.redemption}, ${rule.returns}.`,
  };
}

export default async function CountyPage(props: PageProps<"/atlas/[state]/[county]">) {
  const { state, county } = await props.params;
  const rule = resolveBySlug(state, county);
  if (!rule) notFound();

  const c = rule.county;
  const statute = statuteFor(c.state);
  const inherited = new Set(rule.inherited);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Breadcrumbs
        items={[
          { href: "/atlas", label: "Atlas" },
          { href: `/atlas/${stateSlug(c.state)}`, label: c.stateName },
          { label: `${c.name} County` },
        ]}
      />

      <header className="mb-6">
        <h1 className="text-section font-semibold">
          {c.name} County, {STATE_NAMES[c.state] ?? c.state}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SaleTypeBadge type={toSaleType(rule.type)} />
          {c.population ? (
            <span className="text-xs text-muted">{num(c.population)} residents</span>
          ) : null}
          {isCovered(c.state) ? (
            <Link
              href={`/auctions?state=${c.state}`}
              className="rounded-full border border-accent px-3 py-0.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
            >
              Live auctions →
            </Link>
          ) : null}
        </div>
      </header>

      {rule.isStateDefault ? (
        <div className="mb-6">
          <Callout tone="warn" title="Showing state-level defaults">
            {c.name} County has not been individually researched. Everything below is{" "}
            {c.stateName}&apos;s statewide rule, which is a reasonable starting point but not a
            substitute for the county&apos;s own procedures — auction platform, deposit rules, and
            sale calendar in particular vary county by county. Confirm with the county before
            registering.
          </Callout>
        </div>
      ) : rule.asOf ? (
        <p className="mb-6 text-xs text-muted">
          County research last verified {rule.asOf}. Office holders, platforms, and deposit rules
          change — re-confirm anything time-sensitive.
        </p>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Field label="Sale type" inherited={inherited.has("type")}>
          {rule.type}
        </Field>
        <Field label="Redemption period" inherited={inherited.has("redemption")}>
          {rule.redemption}
        </Field>
        <Field label="Investor return" inherited={inherited.has("returns")}>
          {rule.returns}
        </Field>
        <Field label="Governing statute" inherited={inherited.has("statute")}>
          {rule.statute}
        </Field>
      </div>

      {rule.notes ? (
        <div className="mb-6">
          <Card>
            <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">
              Notes {inherited.has("notes") ? <Inherited /> : null}
            </h2>
            <p className="text-sm leading-relaxed">{rule.notes}</p>
          </Card>
        </div>
      ) : null}

      {(rule.auctionFormat || rule.auctionPlatform || rule.auctionFrequency || rule.depositRules) && (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-semibold">Auction logistics</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {rule.auctionFormat ? <Field label="Format">{rule.auctionFormat}</Field> : null}
            {rule.auctionFrequency ? <Field label="Frequency">{rule.auctionFrequency}</Field> : null}
            {rule.auctionPlatform ? (
              <Field label="Platform">
                <LinkOrText link={rule.auctionPlatform} />
              </Field>
            ) : null}
            {rule.depositRules ? <Field label="Deposit rules">{rule.depositRules}</Field> : null}
          </div>
        </section>
      )}

      {(rule.survivingLiens || rule.quietTitle) && (
        <section className="mb-6 space-y-3">
          <h2 className="text-lg font-semibold">Title risk</h2>
          {rule.survivingLiens ? (
            <Callout tone="danger" title="Liens that survive the sale">
              {rule.survivingLiens}
            </Callout>
          ) : null}
          {rule.quietTitle ? (
            <Callout tone="warn" title="Quiet title">
              {rule.quietTitle}
            </Callout>
          ) : null}
        </section>
      )}

      {statute ? (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-semibold">Deal maths for {c.stateName}</h2>
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Assessment ratio</dt>
                <dd className="tnum">{statute.assessmentRatio}× of market value</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Typical quiet title</dt>
                <dd className="tnum">
                  ${statute.quietTitle.typicalLow.toLocaleString()}–$
                  {statute.quietTitle.typicalHigh.toLocaleString()} ·{" "}
                  {statute.quietTitle.typicalMonths} mo
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Recording and transfer</dt>
                <dd className="tnum">${statute.closingCosts.toLocaleString()}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted">
              {statute.assessmentBasis}
            </p>
          </Card>
        </section>
      ) : null}

      {(rule.taxCollector || rule.clerkOfCourt || rule.propertyAppraiser || rule.gisMap) && (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-semibold">Offices and records</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["Tax collector", rule.taxCollector],
                ["Clerk of court", rule.clerkOfCourt],
                ["Property appraiser", rule.propertyAppraiser],
                ["GIS / parcel map", rule.gisMap],
              ] as const
            )
              .filter(([, l]) => l)
              .map(([label, l]) => (
                <Card key={label}>
                  <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
                  <div className="mt-1 text-sm">
                    <LinkOrText link={l!} />
                  </div>
                  {l!.phone ? (
                    <div className="tnum mt-0.5 text-xs text-muted">{l!.phone}</div>
                  ) : null}
                </Card>
              ))}
          </div>
        </section>
      )}

      {rule.growthNeighborhoods?.length ? (
        <section className="mb-6">
          <h2 className="mb-1 text-lg font-semibold">Areas trending up</h2>
          <p className="mb-3 text-xs text-muted">
            Directional read from dated market analysis — not a guarantee, and not a substitute for
            your own comps.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {rule.growthNeighborhoods.map((g) => (
              <Card key={g.name}>
                <div className="font-medium">{g.name}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{g.why}</p>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {rule.sources?.length ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Sources</h2>
          <ul className="space-y-1 text-xs">
            {rule.sources.map((s) => (
              <li key={s}>
                <a
                  href={s}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-muted underline hover:text-foreground"
                >
                  {s}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Inherited() {
  return (
    <span
      title="Inherited from the state default, not verified for this county"
      className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted"
    >
      state default
    </span>
  );
}

function Field({
  label,
  inherited,
  children,
}: {
  label: string;
  inherited?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">
        {label}
        {inherited ? <Inherited /> : null}
      </h2>
      <div className="text-sm leading-relaxed">{children}</div>
    </Card>
  );
}

function LinkOrText({ link }: { link: LinkRef }) {
  return link.url ? (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline hover:opacity-80"
    >
      {link.label} ↗
    </a>
  ) : (
    <span>{link.label}</span>
  );
}
