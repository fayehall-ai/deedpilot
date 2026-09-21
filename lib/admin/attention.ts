import { sql } from "drizzle-orm";

/**
 * What needs a person, ranked, above everything else on the console.
 *
 * The page previously answered this only by being read end to end: fourteen
 * sections, all expanded, none saying whether it mattered. The number that
 * decides whether to open a stage was inside the stage.
 *
 * CAPE's board already ranks its components by how many packages each holds
 * back, so the reader starts where the work is. This is the same idea one level
 * up — across the whole pipeline rather than within one package.
 *
 * ## Why `blocked` and `attention` are different states
 *
 * `attention` is work this system can do and has not: a queue to drain, a plan
 * to run, a crawl that will happen tonight anyway. `blocked` is work only a
 * person can do — review a statute, write a label rule, buy a plan. Collapsing
 * them would put "tonight's tick will handle it" beside "nothing moves until
 * you decide", which is exactly the distinction an operator opens this page to
 * find.
 */

export interface AttentionItem {
  /** Ranked ascending — 0 first. */
  rank: number;
  state: "attention" | "blocked";
  label: string;
  /** What it unlocks, or what it costs to leave. */
  consequence: string;
  /** Where on the page to go. */
  stage: string;
}

async function conn() {
  const [{ db }] = await Promise.all([import("../db")]);
  return db;
}

export async function whatNeedsAttention(): Promise<AttentionItem[]> {
  const db = await conn();
  const items: AttentionItem[] = [];

  const [counts] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM run_jobs WHERE status = 'queued')::int          AS queued,
      (SELECT count(*) FROM run_jobs WHERE status = 'failed'
         AND coalesce(finished_at, created_at) > now() - interval '7 days'
         AND coalesce(last_error, '') NOT LIKE '%worker died on every attempt')::int AS failed,
      (SELECT count(*) FROM run_jobs WHERE status = 'failed'
         AND coalesce(finished_at, created_at) > now() - interval '7 days'
         AND last_error LIKE '%worker died on every attempt')::int          AS died,
      (SELECT count(*) FROM scout_findings WHERE status = 'pending'
         AND sale_date >= current_date)::int                                AS findings,
      (SELECT count(*) FROM auctions WHERE delisted_at IS NOT NULL)::int    AS delisted,
      (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id
         WHERE l.status = 'pending' AND a.sale_date < current_date)::int    AS past_sale_pending
  `)) as unknown as {
    queued: number;
    failed: number;
    died: number;
    findings: number;
    delisted: number;
    past_sale_pending: number;
  }[];

  /*
   * Statute coverage first, because it is the only item here that multiplies.
   * A county with no priceable state contributes crawled inventory and zero
   * usable inventory — Arkansas was 6,760 lots returning insufficient-data
   * until its entry landed.
   */
  const [{ STATUTE_PARAMS }, { ALL_COUNTIES }] = await Promise.all([
    import("../deal/statute"),
    import("../atlas"),
  ]);
  const priceable = new Set(Object.keys(STATUTE_PARAMS));
  const unpriceable = (await db.execute(sql`
    SELECT a.county_fips, count(*)::int lots FROM lots l JOIN auctions a ON a.id = l.auction_id
    WHERE l.status = 'pending' GROUP BY 1
  `)) as unknown as { county_fips: string; lots: number }[];

  let strandedLots = 0;
  const strandedStates = new Set<string>();
  for (const row of unpriceable) {
    const county = ALL_COUNTIES.find((c) => c.fips === row.county_fips);
    if (county && !priceable.has(county.state)) {
      strandedLots += row.lots;
      strandedStates.add(county.state);
    }
  }
  if (strandedLots > 0) {
    items.push({
      rank: 0,
      state: "blocked",
      label: `${strandedLots.toLocaleString()} crawled parcels cannot be priced`,
      consequence: `${[...strandedStates].sort().join(", ")} have inventory and no statutory parameters. Review a draft in proposals/ to unlock a whole state at once.`,
      stage: "Price",
    });
  }

  /*
   * Sales the Auction Scout found and would not add on its own. Blocked, not
   * attention: nothing does these but Ed, and a finding left long enough is a
   * sale that happens without anyone preparing for it.
   */
  if (counts.findings > 0) {
    items.push({
      rank: 0.5,
      state: "blocked",
      label: `${counts.findings} Auction Scout finding${counts.findings === 1 ? "" : "s"} waiting for you`,
      consequence: "Sales the Scout found but could not confirm on the county's own page. Approve or dismiss each one.",
      stage: "Discover",
    });
  }

  const [{ getPipelineConfig }, { enrichmentSpendThisWeek }] = await Promise.all([
    import("./pipeline-settings"),
    import("../property/enrich-pass"),
  ]);
  const config = await getPipelineConfig();
  const spent = await enrichmentSpendThisWeek();
  if (config.enrichEnabled && config.enrichWeeklyBudgetDollars > 0 && spent >= config.enrichWeeklyBudgetDollars * 100) {
    items.push({
      rank: 2.5,
      state: "attention",
      label: `This week's enrichment budget is spent ($${(spent / 100).toFixed(2)} of $${config.enrichWeeklyBudgetDollars})`,
      consequence: "Paid parcel lookups pause until Monday; the free county layers carry on. Raise it in Schedules.",
      stage: "Enrich",
    });
  }

  if (counts.failed > 0) {
    items.push({
      rank: 1,
      state: "attention",
      label: `${counts.failed} job${counts.failed === 1 ? "" : "s"} failed this week`,
      consequence: "A source has moved or a parser broke. Recent runs carries the error.",
      stage: "Crawl",
    });
  }

  /*
   * Kept apart from errors because the cause is different: nothing went wrong
   * in the job, it simply never finished inside a run — a research state that
   * takes longer than the function may live, or a platform timing out.
   */
  if (counts.died > 0) {
    items.push({
      rank: 1.5,
      state: "attention",
      label: `${counts.died} job${counts.died === 1 ? "" : "s"} never finished this week`,
      consequence: "The worker ran out of time on every attempt. Usually one oversized county or state; Recent runs lists them.",
      stage: "Crawl",
    });
  }

  /*
   * A parcel still `pending` after its sale date is stale in the way that
   * misleads: it renders as biddable for a sale that has happened.
   */
  if (counts.past_sale_pending > 0) {
    items.push({
      rank: 2,
      state: "attention",
      label: `${counts.past_sale_pending.toLocaleString()} parcels still listed after their sale date`,
      consequence: "Reconciliation runs when a county is next crawled; until then these show as biddable.",
      stage: "Observe",
    });
  }

  if (counts.queued > 0) {
    items.push({
      rank: 3,
      state: "attention",
      label: `${counts.queued.toLocaleString()} counties queued and not yet crawled`,
      consequence: "The dispatcher takes them every five minutes, or Work the queue now takes five immediately.",
      stage: "Crawl",
    });
  }

  if (counts.delisted > 0) {
    items.push({
      rank: 4,
      state: "attention",
      label: `${counts.delisted} sale${counts.delisted === 1 ? "" : "s"} dropped from a county calendar`,
      consequence: "Flagged, not cancelled — the county stopped publishing them. Check before telling a subscriber.",
      stage: "Observe",
    });
  }

  return items.sort((a, b) => a.rank - b.rank);
}
