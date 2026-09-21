"use server";

/**
 * Pointing the crawler at a county's own list, from the console.
 *
 * Two hundred upcoming sales sat in counties no crawler covered, because
 * nothing had recorded where those counties publish — Clayton, GA among them,
 * its October list a PDF on its own site the whole time. The Auction Scout
 * records such pages as it finds them; this is the same thing done by hand,
 * for when Ed already knows the page. It writes a `county_sources` row, which
 * the crawler reads on its next pass without a deploy, and queues that
 * county's crawl straight away.
 */
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit, enqueue, liveJob } from "@/lib/admin/queue";
import { db } from "@/lib/db";
import { countySources, runJobs } from "@/lib/db/schema";
import { findCountyByName, getCounty } from "@/lib/atlas";
import { recordCountySource, primeCountySources } from "@/lib/ingest/county-sources";
import { buildAdapterIndex } from "@/lib/scout";

export interface CountySourceOutcome {
  ok: boolean;
  message: string;
}

export async function addCountySource(
  _prev: CountySourceOutcome | null,
  formData: FormData,
): Promise<CountySourceOutcome> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorised." };
  const where = String(formData.get("county") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();

  /* "13063", or "Clayton, GA" / "Clayton County GA". */
  const byFips = /^\d{5}$/.test(where) ? getCounty(where) : null;
  const m = /^(.+?)[,\s]+([A-Za-z]{2})$/.exec(where);
  const county = byFips ?? (m ? findCountyByName(m[2].toUpperCase(), m[1].replace(/\s+county$/i, "").trim()) : null);
  if (!county) return { ok: false, message: `Could not find the county "${where}". Use its FIPS code, or "Name, ST".` };
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, message: "The list address must start with http:// or https://." };

  /*
   * A county a dedicated adapter owns is crawled from that adapter's own
   * configuration; a generic crawl beside it would file the same sale twice.
   */
  const owner = (await buildAdapterIndex({ refresh: true }))[county.fips];
  if (owner && owner !== "generic-county") {
    return {
      ok: false,
      message: `${county.name}, ${county.state} is crawled by the ${owner} adapter, which reads its own configuration. Use "Source overrides" below to change the page it reads, or ask a developer to add the page to that adapter.`,
    };
  }

  const actor = await currentActor();
  const outcome = await recordCountySource({
    countyFips: county.fips,
    url,
    origin: "operator",
    addedBy: actor,
    note: `added on the console by ${actor}`,
  });
  if (outcome.startsWith("refused")) return { ok: false, message: `Not added — ${outcome.slice("refused: ".length)}.` };

  await primeCountySources({ force: true });
  const [busy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runJobs)
    .where(and(eq(runJobs.countyFips, county.fips), liveJob));
  if (!Number(busy?.n)) {
    await enqueue({ adapter: "generic-county", countyFips: county.fips, priority: 10, requestedBy: `operator:${actor}` });
  }
  await audit("county_source.added", county.fips, { url, outcome }, actor);
  revalidatePath("/admin");
  return {
    ok: true,
    message:
      `${outcome === "added" ? "Added" : "Already on file"}: ${county.name}, ${county.state}. ` +
      (Number(busy?.n) ? "A crawl for this county is already queued." : "Its crawl is queued and runs within five minutes."),
  };
}

export async function disableCountySource(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const id = String(formData.get("id") ?? "");
  await db.update(countySources).set({ enabled: false, updatedAt: new Date() }).where(eq(countySources.id, id));
  await audit("county_source.disabled", id, {}, await currentActor());
  revalidatePath("/admin");
}
