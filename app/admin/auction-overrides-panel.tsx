import { Card } from "@/components/ui";
import { listOverriddenAuctions } from "@/lib/admin/auction-overrides";
import { OVERRIDABLE } from "@/lib/admin/auction-override-fields";
import { clearAuctionOverrides, saveAuctionOverride } from "./run-actions";

const button =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90";
const input = "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm";
const ghost =
  "rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-danger hover:text-danger";

/**
 * Auction corrections.
 *
 * Deliberately shows what is *currently* corrected rather than offering a
 * search: the risk this panel manages is a correction nobody remembers making.
 * An override outranks the county on every future crawl, so a stale one is a
 * subscriber being shown a date the county has since changed and we are
 * ignoring.
 *
 * The auction id is entered by hand for now. That is the seam the per-county
 * page closes — from there, correcting a sale is a button next to the sale
 * rather than a UUID someone has to go and find.
 */
export async function AuctionOverridesPanel() {
  const overridden = await listOverriddenAuctions(50);
  const fields = Object.keys(OVERRIDABLE);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Auction corrections</h2>
        <p className="mt-1 text-sm text-muted">
          Written to <code className="font-mono text-xs">operator_overrides</code>, never to the
          column. The crawler sets <code className="font-mono text-xs">sale_date</code> and its
          neighbours from the source on every run, so a correction stored anywhere else is reverted
          by the next crawl — silently, and overnight. Clearing a field returns it to whatever the
          county publishes.
        </p>
      </div>

      <Card>
        <form action={saveAuctionOverride} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Auction id</span>
            <input name="auctionId" required placeholder="uuid" className={`${input} w-72 font-mono text-xs`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Field</span>
            <select name="field" className={input} defaultValue="saleDate">
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Value (empty clears)</span>
            <input name="value" placeholder="2026-09-01" className={`${input} w-48`} />
          </label>
          <button type="submit" className={button}>
            Save correction
          </button>
        </form>
        <p className="mt-2 text-xs text-muted">
          Values are checked against the column&rsquo;s own domain before they are stored — an
          out-of-range enum would otherwise fail this auction&rsquo;s ingest on every future crawl.
        </p>
      </Card>

      {overridden.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">County</th>
                  <th className="py-2 pr-3">Sale date</th>
                  <th className="py-2 pr-3">Corrections</th>
                  <th className="py-2 pr-3">By</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {overridden.map((a) => (
                  <tr key={a.id} className="border-b border-border/50 align-top last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{a.countyFips}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{a.saleDate}</td>
                    <td className="py-2 pr-3">
                      <ul className="space-y-0.5">
                        {Object.entries(a.overrides).map(([field, value]) => (
                          <li key={field} className="font-mono text-xs">
                            {field} = {JSON.stringify(value)}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-1 font-mono text-[0.65rem] text-muted">{a.id}</div>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted">{a.editedBy ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <form action={clearAuctionOverrides}>
                        <input type="hidden" name="auctionId" value={a.id} />
                        <button type="submit" className={ghost}>
                          Clear all
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}
