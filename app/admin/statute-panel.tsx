import { Card, Callout } from "@/components/ui";
import { getStatuteCoverage, STALE_AFTER_MONTHS } from "@/lib/admin/statute-coverage";

/**
 * The statute atlas, as something you can read and click.
 *
 * ## Why the sources are links and the citation is not enough
 *
 * Every entry in `STATUTE_PARAMS` carries the statute it was read from and the
 * URLs it was verified against, and until now none of that reached a screen.
 * The console could name the seventeen states blocking 16,408 parcels and
 * offered nothing to act on — not which states were done, not when they were
 * checked, not what they cited. Re-verifying meant opening the source file.
 *
 * ## Why the gap is ranked and the covered list is too
 *
 * Both answer "where should the next day of research go", so both sort by
 * announced parcels. That is what picked Pennsylvania: 40,530 parcels against
 * Georgia's 421, from sale counts that looked comparable.
 */

function Stale({ months }: { months: number }) {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--warn)]">
      {months}mo — re-verify
    </span>
  );
}

/** A source URL shown as its host, because the full statute URL is unreadable. */
function SourceLink({ url }: { url: string }) {
  let label = url;
  try {
    label = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* Keep the raw string — a malformed source is still worth showing. */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="rounded bg-surface-2 px-1.5 py-0.5 text-xs underline underline-offset-2 hover:text-accent"
    >
      {label}
    </a>
  );
}

export async function StatutePanel() {
  const { covered, uncovered, unpriceableParcels, neverSeen } = await getStatuteCoverage();
  const stale = covered.filter((c) => c.stale);

  return (
    <div id="statutes" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Statute coverage</h2>
        <p className="mt-1 text-sm text-muted">
          The parameters the max-bid engine runs on. A state without an entry returns no price at
          all rather than a guessed one, so this list is the ceiling on what any subscriber can be
          told. Figures move with legislation — an entry older than {STALE_AFTER_MONTHS} months is
          flagged for re-reading, not assumed wrong.
        </p>
      </div>

      {stale.length > 0 && (
        <Callout tone="warn" title={`${stale.length} entr${stale.length === 1 ? "y" : "ies"} due for re-verification`}>
          {stale.map((s) => s.name).join(", ")} — re-read against the cited statute before trusting a
          computed max bid there.
        </Callout>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th className="py-1.5 pr-3">State</th>
                <th className="py-1.5 pr-3">Sale type</th>
                <th className="py-1.5 pr-3">Redemption</th>
                <th className="py-1.5 pr-3 text-right">Parcels held</th>
                <th className="py-1.5 pr-3">Checked</th>
                <th className="py-1.5 pr-3">Sources</th>
              </tr>
            </thead>
            <tbody>
              {covered.map((c) => (
                <tr key={c.state} className="border-b border-border/50 align-top last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap font-medium">
                    {c.state} <span className="text-xs font-normal text-muted">{c.name}</span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted">{c.saleType}</td>
                  <td className="py-2 pr-3 text-xs leading-snug text-muted">
                    {c.redemption}
                    <div className="mt-0.5">
                      {c.caveats} caveat{c.caveats === 1 ? "" : "s"}
                      {c.countyRatios > 0 ? ` · ${c.countyRatios} county ratios` : ""}
                    </div>
                  </td>
                  <td className="tnum py-2 pr-3 text-right whitespace-nowrap">
                    {c.parcels.toLocaleString()}
                    <div className="text-xs text-muted">
                      {c.sales} sale{c.sales === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted">
                    {c.asOf}
                    {c.stale ? (
                      <div className="mt-0.5">
                        <Stale months={c.monthsOld} />
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {c.sources.map((s) => (
                        <SourceLink key={s} url={s} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div>
        <h3 className="font-medium">
          {uncovered.length} state{uncovered.length === 1 ? "" : "s"} we have seen sales in with no
          statute
        </h3>
        <p className="mt-1 text-sm text-muted">
          {unpriceableParcels.toLocaleString()} upcoming announced parcels no max bid can be
          computed for. Ranked by every parcel we have ever seen in the state rather than only the
          upcoming ones, because tax sales are seasonal: Mississippi sells once a year in August and
          would otherwise read as empty for eleven months while being the largest gap here. States
          already researched and ruled out sort to the bottom with the reason, because they are a
          closed question rather than a queue item.
        </p>
      </div>

      <Card>
        {uncovered.length === 0 ? (
          <p className="text-sm text-muted">
            Every state holding upcoming inventory has statutory parameters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3">State</th>
                  <th className="py-1.5 pr-3 text-right">Upcoming parcels</th>
                  <th className="py-1.5 pr-3 text-right">Ever seen</th>
                  <th className="py-1.5 pr-3">Soonest</th>
                  <th className="py-1.5 pr-3">Last sale</th>
                </tr>
              </thead>
              <tbody>
                {uncovered.map((u) => (
                  <tr key={u.state} className="border-b border-border/50 align-top last:border-0">
                    <td className="py-1.5 pr-3 font-medium">
                      <span className="whitespace-nowrap">
                        {u.state} <span className="text-xs font-normal text-muted">{u.name}</span>
                      </span>
                      {u.deliberate ? (
                        <div className="mt-1 max-w-[34rem] text-xs font-normal leading-snug text-muted">
                          <span className="mr-1.5 rounded bg-surface-2 px-1.5 py-0.5 uppercase tracking-wide">
                            ruled out
                          </span>
                          {u.deliberate.summary}
                          <div className="mt-0.5">Unblocked by: {u.deliberate.unblockedBy}</div>
                        </div>
                      ) : null}
                    </td>
                    <td className="tnum py-1.5 pr-3 text-right">{u.parcels.toLocaleString()}</td>
                    <td className="tnum py-1.5 pr-3 text-right">
                      {u.seenParcels.toLocaleString()}
                      <div className="text-xs font-normal text-muted">
                        {u.seenSales} sale{u.seenSales === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="tnum py-1.5 pr-3 whitespace-nowrap text-xs text-muted">
                      {u.betweenSeasons ? (
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 uppercase tracking-wide">
                          between seasons
                        </span>
                      ) : (
                        (u.soonest ?? "—")
                      )}
                    </td>
                    <td className="tnum py-1.5 pr-3 whitespace-nowrap text-xs text-muted">
                      {u.lastSale ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {neverSeen.length > 0 && (
        <Callout
          tone="warn"
          title={`${neverSeen.length} state${neverSeen.length === 1 ? "" : "s"} we have never recorded a single sale in`}
        >
          {neverSeen.join(", ")} — these have no statutory parameters and no auctions in the
          database, so they cannot appear in the ranking above at all. Several of them run
          substantial tax sales. This is a gap in discovery rather than in research: finding the
          statute for a state we see no sales in would price nothing.
        </Callout>
      )}
    </div>
  );
}
