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
  const { covered, uncovered, unpriceableParcels } = await getStatuteCoverage();
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
          {uncovered.length} state{uncovered.length === 1 ? "" : "s"} holding inventory with no
          statute
        </h3>
        <p className="mt-1 text-sm text-muted">
          {unpriceableParcels.toLocaleString()} announced parcels no max bid can be computed for.
          Ranked by what is at stake, so the next state to research is the top row — that is how
          Pennsylvania was chosen.
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
                  <th className="py-1.5 pr-3 text-right">Announced parcels</th>
                  <th className="py-1.5 pr-3 text-right">Sales</th>
                  <th className="py-1.5 pr-3">Soonest</th>
                </tr>
              </thead>
              <tbody>
                {uncovered.map((u) => (
                  <tr key={u.state} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium">
                      {u.state} <span className="text-xs font-normal text-muted">{u.name}</span>
                    </td>
                    <td className="tnum py-1.5 pr-3 text-right">{u.parcels.toLocaleString()}</td>
                    <td className="tnum py-1.5 pr-3 text-right text-muted">{u.sales}</td>
                    <td className="tnum py-1.5 pr-3 whitespace-nowrap text-xs text-muted">
                      {u.soonest ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
