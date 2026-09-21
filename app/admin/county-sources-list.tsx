import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { countySources } from "@/lib/db/schema";
import { getCounty } from "@/lib/atlas";
import { disableCountySource } from "./county-source-actions";

/** The list pages recorded at runtime — by Ed here, or by the Auction Scout. */
export async function CountySourcesList() {
  const rows = await db
    .select()
    .from(countySources)
    .where(eq(countySources.enabled, true))
    .orderBy(desc(countySources.updatedAt))
    .limit(50);
  if (rows.length === 0) return <p className="text-sm text-muted">None recorded yet.</p>;
  return (
    <ul className="divide-y divide-border/60 text-sm">
      {rows.map((r) => {
        const c = getCounty(r.countyFips);
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="w-40 shrink-0 font-medium">{c ? `${c.name}, ${c.state}` : r.countyFips}</span>
            <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate underline">
              {r.url}
            </a>
            <span className="text-xs text-faint">{r.origin === "operator" ? `added by ${r.addedBy}` : "found by the Auction Scout"}</span>
            <form action={disableCountySource}>
              <input type="hidden" name="id" value={r.id} />
              <button type="submit" className="rounded-lg border border-border px-2 py-0.5 text-xs hover:border-accent">
                Disable
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
