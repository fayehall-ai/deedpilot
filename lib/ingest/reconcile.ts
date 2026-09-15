/**
 * Reconcile parcels that have left a county's list.
 *
 * `upsertLots` uses `onConflictDoUpdate`, which only touches rows present in
 * the incoming batch. A parcel pulled from the sale list — the owner paid, a
 * bankruptcy stay landed, the county found a title defect — is simply absent
 * from the next crawl, so its row keeps `status = 'pending'` and a subscriber
 * is still shown a walk-away price for something that is no longer for sale.
 *
 * Measured before this existed: 38 auctions whose `lot_count` disagreed with
 * their own row count, 67 phantom parcels, and `redeemed` / `withdrawn` present
 * in `lotStatusEnum` with zero rows carrying either.
 *
 * ## Why `withdrawn` and never `redeemed`
 *
 * The county publishes an absence, not a reason. Owner paid, payment plan,
 * bankruptcy stay, title defect, clerical error, land-bank transfer — all
 * identical from outside. `withdrawn` records what was observed; `redeemed`
 * would assert a cause nobody saw, which is the same move that let 70,109
 * Cook County schema defaults be read as observed non-redemptions.
 *
 * An adapter that reads an explicit "REDEEMED" or "PAID" status off the page
 * may assert it — that is an observation. Nothing here infers it.
 *
 * ## Why the retention guard exists
 *
 * The dangerous failure is not missing a withdrawal, it is inventing one. If a
 * selector breaks and a page yields 3 parcels instead of 300, an unguarded
 * sweep withdraws 297 real ones — and `judge.ts` already states the principle:
 * discarding a real parcel to keep the dataset tidy costs the subscriber a deal.
 *
 * So reconciliation runs only on a clean `ok` county run, and only when enough
 * of the previously-known set survived. A refusal is logged and counted rather
 * than silently skipped, because a county that trips the guard is either
 * shedding parcels unusually fast or has moved its markup, and both are worth
 * someone's attention.
 */

import { and, eq, gte, isNotNull, isNull, lt, notLike, sql } from "drizzle-orm";
import { IMPORT_ID_SQL_PATTERN } from "../import/provenance";
import type { Platform } from "./types";

/*
 * `db` and the schema are imported lazily inside the functions that touch them.
 * `shouldReconcile` is the function that can destroy real inventory, and its
 * test must be able to import this module without a DATABASE_URL — a top-level
 * `import { db }` pulls in the connection at module load and makes the guard
 * untestable in isolation. Same lazy-import shape used for undici in
 * `lib/ai/providers.ts` and for the scout backlog in `scripts/scout.ts`.
 */
async function conn() {
  const [{ db }, { lots }] = await Promise.all([import("../db"), import("../db/schema")]);
  return { db, lots };
}

/**
 * Fraction of the previously-known parcels that must still be present before
 * absences are believed.
 *
 * Deliberately loose. Counties genuinely shed parcels in the days before a
 * sale — that is the event this whole module exists to record — so a tight
 * threshold would refuse exactly the observations worth having. What it is
 * sized to catch is structural breakage, where a parse returns a token handful
 * of rows rather than a plausibly smaller list.
 */
export const MIN_RETENTION = 0.5;

export type ReconcileDecision =
  | { reconcile: true; reason: string }
  | { reconcile: false; reason: string };

export interface ReconcileInput {
  /** Lots accepted from this crawl. */
  seen: number;
  /** Previously-known pending lots that this crawl did not return. */
  absent: number;
  /** The county run's status at the point of reconciliation. */
  status: "ok" | "partial" | "failed" | "blocked";
}

/**
 * Decide whether absences are evidence. Pure, so the guard is testable without
 * a database — which matters, because this is the function that can destroy
 * real inventory.
 */
export function shouldReconcile(input: ReconcileInput): ReconcileDecision {
  const { seen, absent, status } = input;

  if (status !== "ok") {
    return {
      reconcile: false,
      reason: `run status ${status} — absence is not evidence when part of the crawl failed`,
    };
  }
  if (absent === 0) return { reconcile: false, reason: "nothing absent" };
  if (seen === 0) {
    return { reconcile: false, reason: "crawl returned no parcels — treated as breakage, not a cleared sale" };
  }

  const prior = seen + absent;
  const retention = seen / prior;
  if (retention < MIN_RETENTION) {
    return {
      reconcile: false,
      reason:
        `retention ${(retention * 100).toFixed(0)}% (${seen}/${prior}) below ` +
        `${MIN_RETENTION * 100}% — refusing to withdraw ${absent} parcel(s) on a suspect parse`,
    };
  }
  return {
    reconcile: true,
    reason: `retention ${(retention * 100).toFixed(0)}% (${seen}/${prior}) — withdrawing ${absent} absent parcel(s)`,
  };
}

/** A DB-side timestamp, so the cutoff cannot drift from `lastSeenAt` by clock skew. */
export async function nowFromDb(): Promise<Date> {
  const { db } = await conn();
  const rows = (await db.execute(sql`SELECT now() AS t`)) as unknown as { t: Date }[];
  return new Date(rows[0].t);
}

/**
 * Count the pending parcels this crawl did not return.
 *
 * Only `pending` rows count. A lot already `sold`, `redeemed` or `struck` has a
 * disposition somebody observed, and an absence must never overwrite one.
 */
export async function countAbsent(auctionId: string, cutoff: Date): Promise<number> {
  const { db, lots } = await conn();
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lots)
    .where(and(eq(lots.auctionId, auctionId), eq(lots.status, "pending"), lt(lots.lastSeenAt, cutoff)))) as {
    n: number;
  }[];
  return rows[0]?.n ?? 0;
}

/** Mark the absent parcels withdrawn. Returns how many rows moved. */
export async function withdrawAbsent(auctionId: string, cutoff: Date): Promise<number> {
  const { db, lots } = await conn();
  const moved = await db
    .update(lots)
    .set({ status: "withdrawn" })
    .where(and(eq(lots.auctionId, auctionId), eq(lots.status, "pending"), lt(lots.lastSeenAt, cutoff)))
    .returning({ id: lots.id });
  return moved.length;
}

/**
 * Flag still-future sales that a county has stopped publishing, and un-flag any
 * that came back.
 *
 * The same bug as absent parcels, one level up: `upsertAuction` only touches
 * auctions in the batch, so a sale that vanishes from the county's calendar sits
 * at `status = 'scheduled'` until its date passes.
 *
 * Three things make this more dangerous than the parcel case, and each has a
 * guard:
 *
 * - **Blast radius.** Hiding an auction hides all its parcels, so this writes
 *   `delistedAt` rather than `status`, and the flag clears the moment the sale
 *   reappears.
 * - **Adapters that only publish the next sale.** A calendar showing one sale at
 *   a time makes every other sale look delisted. Only sales still in the future
 *   are considered, and only when the crawl returned at least one auction.
 * - **A parse failure returns nothing**, which would delist a county's whole
 *   calendar. `seenAuctions === 0` refuses outright.
 * - **Rows the crawl was never looking at.** An imported announcement comes
 *   from an uploaded calendar, not from the county's page, so a crawl not
 *   seeing it says nothing about whether the county still intends to sell.
 *   Reconciling it against a source that never carried it marked 212 of 570
 *   imported sales as delisted on the first pass — every one still scheduled.
 *   This column means the county published an absence; there was no county and
 *   no absence, so imported rows are excluded outright.
 * - **Another platform's sales.** Scoped by county alone, a run of one adapter
 *   delisted sales it had never looked at: a RealAuction capture of Marion's 16
 *   September sale marked the county's own `county_site` sale delisted, because
 *   nothing in that crawl had touched it. An adapter can only report an absence
 *   from the source it actually reads, so `platform` narrows this to that
 *   source. A county that genuinely moves platform stops being delisted here,
 *   which is the right trade: the new platform's rows appear, and a sale that
 *   really has gone is a person's call rather than an inference from a crawl
 *   that was never watching it.
 */
export async function reconcileCountyAuctions(opts: {
  countyFips: string;
  /** Only this source's sales. See the header. */
  platform: Platform;
  cutoff: Date;
  seenAuctions: number;
  status: "ok" | "partial" | "failed" | "blocked";
}): Promise<{ delisted: number; relisted: number; skippedReason: string | null }> {
  if (opts.status !== "ok") {
    return { delisted: 0, relisted: 0, skippedReason: null };
  }
  if (opts.seenAuctions === 0) {
    return {
      delisted: 0,
      relisted: 0,
      skippedReason: "crawl returned no auctions — refusing to delist the county's whole calendar",
    };
  }

  const { db } = await conn();
  const { auctions } = await import("../db/schema");
  const today = new Date().toISOString().slice(0, 10);

  /*
   * Drizzle's comparison helpers rather than raw `sql` templates: the postgres
   * driver refuses to bind a JS Date inside a raw template and fails at encode
   * time with a type error that names no column. `lib/admin/queue.ts` carries
   * the same warning, and this hit it anyway — `gte`/`lt`/`isNull` encode the
   * Date correctly and read better besides.
   */
  const gone = await db
    .update(auctions)
    .set({ delistedAt: sql`now()` })
    .where(
      and(
        eq(auctions.countyFips, opts.countyFips),
        eq(auctions.platform, opts.platform),
        gte(auctions.saleDate, today),
        lt(auctions.lastSeenAt, opts.cutoff),
        isNull(auctions.delistedAt),
        // Only rows a crawl could have seen. See the header.
        notLike(auctions.externalId, IMPORT_ID_SQL_PATTERN),
      ),
    )
    .returning({ id: auctions.id });

  // A sale that came back is no longer delisted. Without this the flag would be
  // a one-way door, and a county that briefly dropped a page would stay wrong.
  const back = await db
    .update(auctions)
    .set({ delistedAt: null })
    .where(
      and(
        eq(auctions.countyFips, opts.countyFips),
        eq(auctions.platform, opts.platform),
        gte(auctions.lastSeenAt, opts.cutoff),
        isNotNull(auctions.delistedAt),
        notLike(auctions.externalId, IMPORT_ID_SQL_PATTERN),
      ),
    )
    .returning({ id: auctions.id });

  return { delisted: gone.length, relisted: back.length, skippedReason: null };
}

export interface ReconcileResult {
  withdrawn: number;
  /** Set when the guard refused, so the refusal is visible rather than silent. */
  skippedReason: string | null;
}

/**
 * Reconcile one auction's parcels against what this crawl returned.
 *
 * `cutoff` must be taken *before* the lots upsert — every parcel the crawl
 * returned has its `lastSeenAt` moved past it, so whatever still sits behind it
 * is precisely the set the county stopped publishing.
 */
export async function reconcileAuction(opts: {
  auctionId: string;
  cutoff: Date;
  seen: number;
  status: "ok" | "partial" | "failed" | "blocked";
}): Promise<ReconcileResult> {
  const absent = await countAbsent(opts.auctionId, opts.cutoff);
  const decision = shouldReconcile({ seen: opts.seen, absent, status: opts.status });

  if (!decision.reconcile) {
    return { withdrawn: 0, skippedReason: absent > 0 ? decision.reason : null };
  }

  const withdrawn = await withdrawAbsent(opts.auctionId, opts.cutoff);
  return { withdrawn, skippedReason: null };
}
