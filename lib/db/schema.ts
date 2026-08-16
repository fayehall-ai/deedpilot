/**
 * DeedPilot database schema.
 *
 * Shape of the domain: a *county* holds *auctions*; an auction lists *lots*
 * (parcels); a lot accrues *valuations* (scraped enrichment) and
 * *deal analyses* (what the AI buddy concluded). Users build *bid sheets*
 * against an auction and track outcomes.
 *
 * The rules atlas deliberately lives in code (lib/atlas), not here — it is
 * authored, version-controlled research, and it powers statically generated
 * SEO pages. Only *observed* data (auctions, lots, prices) lives in Postgres.
 */

import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uuid,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const saleTypeEnum = pgEnum("sale_type", [
  "Tax Lien",
  "Tax Deed",
  "Redeemable Deed",
  "Hybrid",
]);

/** Where a sale is hosted. `county_site` covers one-off county portals/PDFs. */
export const platformEnum = pgEnum("platform", [
  "realtaxdeed", // RealAuction — most of Florida
  "realforeclose", // RealAuction foreclosure/tax product
  "govease",
  "bid4assets",
  "zeus",
  "lienhub",
  "grantstreet",
  "taxsaleinfo", // Title Check LLC — most of Michigan
  "mvba", // Texas delinquent-tax law firm sale lists
  "lgbs", // Linebarger Goggan Blair & Sampson — Texas
  "county_site",
  "in_person",
]);

export const auctionStatusEnum = pgEnum("auction_status", [
  "scheduled",
  "live",
  "closed",
  "cancelled",
  "postponed",
]);

/**
 * What happened to a parcel.
 *
 * ## `redeemed` here is the PRE-sale cure, not the statutory redemption
 *
 * These are two different events and the word is the same, which is exactly the
 * shape of confusion that inverted the Illinois model once already:
 *
 * - **This enum's `redeemed`** — the owner paid the delinquency *before* the
 *   sale, so the parcel never sold. Adapters set it when a county page says
 *   REDEEMED or PAID.
 * - **`p_redeem` in the copilot's simulator** — the owner reclaimed the
 *   property *from the buyer* during the statutory window after a sale. That is
 *   the return an investor in a redeemable-deed state is actually buying.
 *
 * The corpus already tripped over this and had to flag San Diego's 1,404 rows
 * as pre-sale cures that are explicitly *not* post-sale redemptions. Feeding
 * one into anything fitting the other rebuilds the Cook County bug with better
 * provenance: a redemption rate inflated by events that are not redemptions.
 *
 * The value is kept rather than renamed because three adapters write it and a
 * rename is a migration; what was missing was anywhere stating which event it
 * observes. Anything that fits a redemption rate must read post-sale outcomes
 * from the corpus, never this column.
 */
export const lotStatusEnum = pgEnum("lot_status", [
  "pending", // listed, not yet sold
  "sold",
  /** PRE-sale cure: owner paid before the sale. NOT a post-sale redemption. */
  "redeemed",
  "cancelled",
  "struck", // no bid; struck to the county/state
  /** Observed absence — the county stopped publishing it, reason unknown. */
  "withdrawn",
]);

export const planEnum = pgEnum("plan", ["free", "starter", "pro", "team"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
]);

export const ingestStatusEnum = pgEnum("ingest_status", [
  "running",
  "ok",
  "partial",
  "failed",
]);

/**
 * What kind of document the lots came from — the difference between "these
 * parcels are being sold on this date" and "these parcels owe money".
 *
 * Counties publish several superficially similar lists on the same page. Cobb
 * County GA links a Tax Sale List, a Delinquent Tax List, an Excess Funds list
 * and a booklet from one page; only the first is inventory. A crawler that
 * scores them alike ingests 2,825 delinquent taxpayers as an auction — which is
 * what happened, under a sale date the calendar invented.
 *
 * Recording which document was read makes that recoverable instead of
 * indistinguishable. Only `sale_list` is inventory a bidder can act on.
 */
export const listingKindEnum = pgEnum("listing_kind", [
  /** The county's published list for a specific, dated sale. Real inventory. */
  "sale_list",
  /**
   * Everyone delinquent on taxes. A superset of any eventual sale — most of
   * these owners pay before the levy. Useful as a lead list, never as lots.
   */
  "delinquent_list",
  /** Struck to the county / forfeited land inventory, available post-sale. */
  "lands_available",
  /** Read something parcel-shaped, could not establish which of the above. */
  "unknown",
]);

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/**
 * All 3,142 counties, seeded from the atlas. Exists in the DB (rather than
 * only in code) so auctions and lots can foreign-key to a real row and so
 * coverage/ingest state has somewhere to live.
 */
export const counties = pgTable(
  "counties",
  {
    /** 5-digit FIPS — the canonical join key across the whole system. */
    fips: text("fips").primaryKey(),
    name: text("name").notNull(),
    state: text("state").notNull(),
    stateName: text("state_name").notNull(),
    population: integer("population"),
    /** True for the 5 states with parcel-level ingestion (FL/GA/TX/AZ/MI). */
    covered: boolean("covered").notNull().default(false),
    /** Which adapter services this county, when covered. */
    platform: platformEnum("platform"),
    /** Adapter-specific config: subdomain, portal URL, list page, selectors. */
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>(),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
  },
  (t) => [
    index("counties_state_idx").on(t.state),
    index("counties_covered_idx").on(t.covered),
  ],
);

// ---------------------------------------------------------------------------
// Auctions and lots
// ---------------------------------------------------------------------------

export const auctions = pgTable(
  "auctions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countyFips: text("county_fips")
      .notNull()
      .references(() => counties.fips),
    platform: platformEnum("platform").notNull(),
    saleType: saleTypeEnum("sale_type").notNull(),
    /** The platform's own id for this sale — half of the dedupe key. */
    externalId: text("external_id").notNull(),
    title: text("title"),
    saleDate: date("sale_date").notNull(),
    /**
     * True only when the county published this date for this sale. False when
     * `nextSaleWindows` projected it from the state's typical schedule.
     *
     * The projection exists so unresearched counties still get crawled rather
     * than skipped, which is right — but a projected date is a research lead,
     * not a date to drive to. Defaults to false so a source that never says
     * otherwise cannot be mistaken for a confirmed one.
     */
    saleDateConfirmed: boolean("sale_date_confirmed").notNull().default(false),
    /** Which published document the lots were read from. See `listingKindEnum`. */
    listingKind: listingKindEnum("listing_kind").notNull().default("unknown"),
    /** Local start time as published, e.g. "10:00 AM ET". Prose, not parsed. */
    startTime: text("start_time"),
    status: auctionStatusEnum("status").notNull().default("scheduled"),
    registrationDeadline: timestamp("registration_deadline", { withTimezone: true }),
    depositDeadline: timestamp("deposit_deadline", { withTimezone: true }),
    sourceUrl: text("source_url").notNull(),
    lotCount: integer("lot_count").notNull().default(0),
    /** Untouched payload from the source, for re-parsing without re-fetching. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    /**
     * When a still-future sale stopped appearing on its county's listing.
     *
     * Deliberately *not* `status = 'cancelled'`. A county publishes an absence,
     * not a reason — cancelled, postponed, moved to an archive page, or simply
     * dropped from a calendar that only shows the next sale are indistinguishable
     * from outside, and `status` stays adapter-owned so an adapter that reads a
     * real "CANCELLED" off the page keeps the only claim about cause.
     *
     * Cleared the moment the sale reappears, so this records a current condition
     * rather than a permanent verdict.
     */
    delistedAt: timestamp("delisted_at", { withTimezone: true }),
    /**
     * Operator corrections, which outrank the source.
     *
     * The third tier. `upsertLots` already distinguishes adapter-owned columns
     * (overwritten, because the source is authoritative) from enrichment-owned
     * ones (coalesced, so a re-ingest cannot erase paid API work). A person
     * correcting a wrong sale date is neither: without somewhere to put it, the
     * 02:00 upsert sets `sale_date` from `excluded.sale_date` and the fix is
     * gone by morning — an edit that appeared to work and undid itself.
     *
     * Keyed by column name in camelCase, values as JSON scalars. Only fields in
     * `OVERRIDABLE` may be written, and every value is validated against the
     * column's own domain before it lands, because these are read back through
     * a Postgres cast: an invalid enum string here would fail the upsert for
     * this auction on every future crawl.
     *
     * Deleting a key reverts to whatever the county publishes. Nothing is
     * destroyed, so a correction is always reversible to the source of truth.
     */
    operatorOverrides: jsonb("operator_overrides").$type<Record<string, unknown>>(),
    editedBy: text("edited_by"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auctions_source_key").on(t.countyFips, t.platform, t.externalId),
    index("auctions_date_idx").on(t.saleDate),
    index("auctions_county_date_idx").on(t.countyFips, t.saleDate),
    index("auctions_status_idx").on(t.status),
    // Every inventory-facing query filters on these two together.
    index("auctions_confirmed_idx").on(t.listingKind, t.saleDateConfirmed),
  ],
);

/**
 * A single parcel offered at an auction.
 *
 * Money is `numeric(14,2)` throughout — never float. Bids are compared,
 * summed, and shown to users deciding how to spend real money.
 */
export const lots = pgTable(
  "lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    countyFips: text("county_fips")
      .notNull()
      .references(() => counties.fips),

    /** The platform's item id. */
    externalId: text("external_id"),
    /**
     * Dedupe key within an auction: `parcelNumber ?? externalId`, computed by
     * the ingest runner. An explicit column rather than a unique index over
     * `parcel_number` directly, because Postgres treats NULLs as distinct —
     * a source that omits parcel numbers would silently insert duplicates on
     * every run.
     */
    dedupeKey: text("dedupe_key").notNull(),
    /** Sequence within the sale — what the auctioneer calls out. */
    lotNumber: text("lot_number"),
    /** County parcel/APN identifier — the join key to assessor data. */
    parcelNumber: text("parcel_number"),
    /** Tax deed application or court case number, where applicable. */
    caseNumber: text("case_number"),

    addressLine: text("address_line"),
    city: text("city"),
    zip: text("zip"),
    legalDescription: text("legal_description"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),

    openingBid: numeric("opening_bid", { precision: 14, scale: 2 }),
    assessedValue: numeric("assessed_value", { precision: 14, scale: 2 }),
    /** Total delinquent taxes driving the sale. */
    taxesOwed: numeric("taxes_owed", { precision: 14, scale: 2 }),

    landUse: text("land_use"),
    acreage: numeric("acreage", { precision: 12, scale: 4 }),
    buildingSqft: integer("building_sqft"),
    yearBuilt: integer("year_built"),
    ownerName: text("owner_name"),

    status: lotStatusEnum("status").notNull().default("pending"),
    soldAmount: numeric("sold_amount", { precision: 14, scale: 2 }),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    /** Surplus over the taxes owed — the excess-proceeds claim opportunity. */
    surplus: numeric("surplus", { precision: 14, scale: 2 }),

    sourceUrl: text("source_url"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lots_auction_dedupe_key").on(t.auctionId, t.dedupeKey),
    index("lots_auction_idx").on(t.auctionId),
    index("lots_county_idx").on(t.countyFips),
    index("lots_parcel_idx").on(t.countyFips, t.parcelNumber),
    index("lots_status_idx").on(t.status),
  ],
);

/**
 * Enrichment pulled from county assessor / GIS portals, kept separate from
 * the auction listing so a re-scrape of either side never clobbers the other.
 */
export const lotValuations = pgTable(
  "lot_valuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    /** Which portal this came from, e.g. "fl-pinellas-pao". */
    source: text("source").notNull(),
    taxYear: integer("tax_year"),
    assessedLand: numeric("assessed_land", { precision: 14, scale: 2 }),
    assessedImprovement: numeric("assessed_improvement", { precision: 14, scale: 2 }),
    assessedTotal: numeric("assessed_total", { precision: 14, scale: 2 }),
    marketValue: numeric("market_value", { precision: 14, scale: 2 }),
    /** Last arm's-length sale on record — the best free comp we get. */
    lastSaleAmount: numeric("last_sale_amount", { precision: 14, scale: 2 }),
    lastSaleDate: date("last_sale_date"),
    homestead: boolean("homestead"),
    zoning: text("zoning"),
    floodZone: text("flood_zone"),
    /*
     * Building characteristics.
     *
     * `PropertyProvider` has returned all four since it was written, and until
     * now the write path dropped them into `raw` because there was nowhere for
     * them to land — so every bed, bath and lot size this system ever paid for
     * is sitting in a JSON blob no query reads. They are columns because the
     * PropStream-shaped detail page selects on them and because "how many
     * bedrooms" should not require a jsonb path expression.
     *
     * Baths is numeric, not integer: half-baths are real and 1.5 is the value
     * every provider returns for them.
     */
    beds: integer("beds"),
    baths: numeric("baths", { precision: 4, scale: 1 }),
    lotSqft: integer("lot_sqft"),
    buildingSqft: integer("building_sqft"),
    yearBuilt: integer("year_built"),
    propertyType: text("property_type"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_valuations_lot_source_key").on(t.lotId, t.source),
    index("lot_valuations_lot_idx").on(t.lotId),
  ],
);

// ---------------------------------------------------------------------------
// Users, billing, entitlements
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plan: planEnum("plan").notNull().default("free"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_user_key").on(t.userId),
    index("subscriptions_stripe_idx").on(t.stripeSubscriptionId),
  ],
);

/**
 * Metered usage for plan limits (AI briefs on Starter, etc.), bucketed by
 * calendar month so a reset is a new row rather than a cron job.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "YYYY-MM" */
    period: text("period").notNull(),
    metric: text("metric").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.period, t.metric] })],
);

// ---------------------------------------------------------------------------
// User workspace: watchlists, bid sheets, AI output
// ---------------------------------------------------------------------------

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("watchlist_user_lot_key").on(t.userId, t.lotId),
    index("watchlist_user_idx").on(t.userId),
  ],
);

/** A user's plan for one auction: total budget plus per-lot ceilings. */
export const bidSheets = pgTable(
  "bid_sheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    name: text("name"),
    /** Hard ceiling across the whole sale — the co-pilot warns against it. */
    totalBudget: numeric("total_budget", { precision: 14, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bid_sheets_user_auction_key").on(t.userId, t.auctionId)],
);

export const bidSheetItems = pgTable(
  "bid_sheet_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bidSheetId: uuid("bid_sheet_id")
      .notNull()
      .references(() => bidSheets.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    /** The walk-away number. Never exceeded by the co-pilot's advice. */
    maxBid: numeric("max_bid", { precision: 14, scale: 2 }),
    priority: integer("priority").notNull().default(0),
    notes: text("notes"),
    /** What actually happened, filled in during or after the sale. */
    outcome: text("outcome"),
    wonAmount: numeric("won_amount", { precision: 14, scale: 2 }),
  },
  (t) => [
    uniqueIndex("bid_sheet_items_sheet_lot_key").on(t.bidSheetId, t.lotId),
    index("bid_sheet_items_sheet_idx").on(t.bidSheetId),
  ],
);

/**
 * A cached AI risk brief + max-bid recommendation for a lot.
 *
 * Keyed by lot and by an `inputsHash` of the deterministic inputs, so changing
 * your target margin or rehab assumption produces a new analysis instead of
 * silently reusing a stale one.
 */
export const dealAnalyses = pgTable(
  "deal_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    inputsHash: text("inputs_hash").notNull(),
    model: text("model").notNull(),
    /** Deterministic maths from lib/deal — not model output. */
    maxBid: numeric("max_bid", { precision: 14, scale: 2 }),
    arvEstimate: numeric("arv_estimate", { precision: 14, scale: 2 }),
    totalCosts: numeric("total_costs", { precision: 14, scale: 2 }),
    /** Structured hazards: surviving liens, redemption exposure, occupancy. */
    riskFlags: jsonb("risk_flags").$type<unknown[]>(),
    /** Markdown narrative from the model. */
    brief: text("brief"),
    inputs: jsonb("inputs").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deal_analyses_lot_inputs_key").on(t.lotId, t.inputsHash),
    index("deal_analyses_lot_idx").on(t.lotId),
  ],
);

// ---------------------------------------------------------------------------
// Ingestion observability
// ---------------------------------------------------------------------------

/**
 * One row per adapter run. Scraping 578 counties across 6 platforms breaks
 * constantly and silently; without this table a county that quietly stopped
 * returning lots looks identical to a county with no sale scheduled.
 */
export const ingestRuns = pgTable(
  "ingest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    countyFips: text("county_fips").references(() => counties.fips),
    status: ingestStatusEnum("status").notNull().default("running"),
    auctionsFound: integer("auctions_found").notNull().default(0),
    lotsFound: integer("lots_found").notNull().default(0),
    lotsChanged: integer("lots_changed").notNull().default(0),
    /** Rows the judge rejected — a spike here means the source layout moved. */
    rejected: integer("rejected").notNull().default(0),
    /** Field-level fixes on kept rows; rises the same way, without data loss. */
    repaired: integer("repaired").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
  },
  (t) => [
    index("ingest_runs_adapter_idx").on(t.adapter, t.startedAt),
    index("ingest_runs_county_idx").on(t.countyFips, t.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// Operations: the run queue, schedules, and registry overrides
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one queued piece of ingest work.
 *
 * `leased` exists because a Vercel function is capped at 300 seconds and a
 * full adapter pass takes ten minutes or more, so work must be claimed in
 * chunks by a dispatcher that may itself be killed mid-flight. A lease with an
 * expiry is what makes that safe: a worker that dies stops renewing, the lease
 * lapses, and the job returns to `queued` instead of sitting forever in a state
 * nobody reconciles.
 *
 * That failure is not hypothetical. `ingest_runs` currently holds 51 rows
 * stuck at `running` — tx-lgbs 29, mi-taxsaleinfo 17, generic-county 5, the
 * oldest from 31 July — because the runner writes `running` up front and only
 * resolves it on completion. Every one of those is a process that died.
 */
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "leased",
  "done",
  "failed",
  "cancelled",
]);

/**
 * Work waiting to be done, or recently done.
 *
 * One row per (adapter, county) chunk rather than per adapter: a county is the
 * unit that fits comfortably inside a function invocation, and it is also the
 * unit `runAdapter` already accepts via `countyFips`.
 */
export const runJobs = pgTable(
  "run_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    /** Null means "whatever counties the adapter discovers", bounded by limit. */
    countyFips: text("county_fips").references(() => counties.fips),
    limit: integer("limit"),
    dryRun: boolean("dry_run").notNull().default(false),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** Higher runs first. A hand-pressed "run now" outranks the nightly sweep. */
    priority: integer("priority").notNull().default(0),
    /** Who or what created this — an operator token, or a schedule id. */
    requestedBy: text("requested_by").notNull().default("system"),
    scheduleId: uuid("schedule_id"),
    /**
     * While held, no other dispatcher may claim this row. Renewed by the
     * worker; once it lapses the job is claimable again.
     */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    /* The dispatcher's claim query: pending work, best first. */
    index("run_jobs_claim_idx").on(t.status, t.priority, t.createdAt),
    index("run_jobs_adapter_idx").on(t.adapter, t.createdAt),
  ],
);

/**
 * A recurring instruction to enqueue work.
 *
 * Deliberately not a cron expression evaluated in the database: schedules here
 * are an interval plus an anchor, which is enough for "sweep this adapter
 * nightly" and cannot express a schedule nobody can reason about at 3am. The
 * dispatcher is what turns a due schedule into `run_jobs` rows.
 */
export const runSchedules = pgTable(
  "run_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    /** Minutes between enqueues. 1440 is nightly. */
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    /** Counties per enqueue, so one schedule cannot flood the queue. */
    limit: integer("limit"),
    enabled: boolean("enabled").notNull().default(true),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_schedules_adapter_key").on(t.adapter)],
);

/**
 * Operator overrides on the code-held source registry.
 *
 * The registries in `lib/ingest/adapters/*` remain the baseline; this table
 * only ever overlays them. Keeping the baseline in git means a URL that was
 * verified by hand still carries its verification in the commit that added it,
 * while an operator can correct a moved page without a deploy.
 */
export const sourceOverrides = pgTable(
  "source_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    countyFips: text("county_fips")
      .notNull()
      .references(() => counties.fips),
    /** Null keeps the registry URL and only changes `enabled`. */
    url: text("url"),
    /** False removes the county from the adapter's bindings without deleting it. */
    enabled: boolean("enabled").notNull().default(true),
    note: text("note"),
    updatedBy: text("updated_by").notNull().default("admin"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_overrides_key").on(t.adapter, t.countyFips)],
);

/**
 * Operator overrides on access policy.
 *
 * `lib/ingest/policy.ts` holds the reviewed decisions and their reasoning, and
 * remains the baseline. This table exists because the operator asked to change
 * decisions without a deploy; `reason` is `notNull` on purpose, so loosening a
 * host's access always leaves a written justification next to it. The decision
 * to stay off a host is the kind that is expensive to get wrong — USTLA and
 * the Georgia Press Association are both blocked by terms rather than by
 * robots — so every change is recorded rather than merely applied.
 */
/**
 * The Auction Scout research prompt, editable from the console.
 *
 * In the database rather than in the source because the prompt IS the product
 * here: it is the standing brief for what a report must cover, and it changes
 * when the desk's priorities change — a new state, a new platform, a source
 * that stopped publishing. Requiring a deploy to add "scan every county in
 * Georgia" would mean the brief lives in someone's chat history instead of in
 * the thing that runs.
 *
 * One row, id `default`. Absent means nobody has edited it and the built-in
 * brief applies, so a fresh deployment is not a broken one.
 */
export const scoutPrompts = pgTable("scout_prompts", {
  id: text("id").primaryKey(),
  template: text("template").notNull(),
  updatedBy: text("updated_by").notNull().default("admin"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policyOverrides = pgTable(
  "policy_overrides",
  {
    host: text("host").primaryKey(),
    decision: text("decision").notNull(),
    minDelayMs: integer("min_delay_ms").notNull().default(5000),
    reason: text("reason").notNull(),
    updatedBy: text("updated_by").notNull().default("admin"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Every write the console makes, kept whether or not anyone reads it. */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail"),
    actor: text("actor").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_audit_created_idx").on(t.createdAt)],
);

export type County = typeof counties.$inferSelect;
export type Auction = typeof auctions.$inferSelect;
export type NewAuction = typeof auctions.$inferInsert;
export type Lot = typeof lots.$inferSelect;
export type NewLot = typeof lots.$inferInsert;
export type LotValuation = typeof lotValuations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type DealAnalysis = typeof dealAnalyses.$inferSelect;
export type IngestRun = typeof ingestRuns.$inferSelect;
export type RunJob = typeof runJobs.$inferSelect;
export type NewRunJob = typeof runJobs.$inferInsert;
export type RunSchedule = typeof runSchedules.$inferSelect;
export type SourceOverride = typeof sourceOverrides.$inferSelect;
export type PolicyOverride = typeof policyOverrides.$inferSelect;
export type ScoutPrompt = typeof scoutPrompts.$inferSelect;

/**
 * Append-only record of what each crawl saw.
 *
 * Every other table holds *current* state: `upsertLots` overwrites
 * `opening_bid` from the source on each run, so a parcel moving from $14,000 to
 * $16,200 leaves only the second number, and a parcel that vanishes leaves no
 * trace it was ever listed. The crawler observes a great deal and remembers
 * almost none of it.
 *
 * This is one row per parcel per crawl. It costs an insert and no extra fetch,
 * and it is the only dataset here that **self-labels**: "on run R, at time T,
 * from URL U, this parcel was present with opening bid X" carries no unstated
 * semantics, so it clears the Archivist's admission rule by construction. That
 * is precisely what the imported 92k-row corpus could not do — `redeemed=False`
 * as a schema default was read as an observed non-redemption and pinned
 * Illinois at p_redeem = 0.02.
 *
 * What it makes computable, none of which exists today: pre-sale attrition
 * curves per county, opening-bid drift, re-offer chains across sales, measured
 * `publishLeadDays`, and per-county re-crawl intervals to replace the fixed
 * 7/3/1.
 *
 * Never updated, never deleted by the pipeline. A correction is a new row.
 */
export const lotObservations = pgTable(
  "lot_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    countyFips: text("county_fips").notNull(),
    /** The crawl that saw it, so an observation can be traced to its run. */
    runId: uuid("run_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * True when this crawl returned the parcel; false when the row is recording
     * that it was absent. An absence is an observation and the single most
     * valuable one here — it is what an attrition curve is made of.
     */
    present: boolean("present").notNull().default(true),
    status: lotStatusEnum("status").notNull(),
    openingBid: numeric("opening_bid", { precision: 14, scale: 2 }),
    /** Days from this observation to the sale. Negative after the sale. */
    daysToSale: integer("days_to_sale"),
    sourceUrl: text("source_url"),
  },
  (t) => [
    index("lot_observations_lot_idx").on(t.lotId, t.observedAt),
    index("lot_observations_auction_idx").on(t.auctionId, t.observedAt),
    /* Attrition is asked per county over time; this is the shape of that query. */
    index("lot_observations_county_idx").on(t.countyFips, t.observedAt),
  ],
);

export type LotObservation = typeof lotObservations.$inferSelect;

/**
 * Operator-tunable pipeline cadence.
 *
 * These numbers were hardcoded in three places — the plan cap in the dispatcher
 * route, the weekly day and state count in `scout-jobs`, the cooldown in
 * `research-day` — which meant changing how hard the pipeline runs was a deploy.
 * That is the wrong shape for the one setting most likely to need changing at
 * short notice: the crawl cap exists to stop the queue outgrowing what a tick
 * can drain, and the right value moves the moment the dispatcher cadence does.
 *
 * One row, id `default`, same pattern as `scout_prompts`. Absent means the
 * built-in defaults apply, so a fresh deployment is not a broken one.
 */
export const pipelineSettings = pgTable("pipeline_settings", {
  id: text("id").primaryKey(),
  /** Master switch for calendar-driven crawling. */
  crawlEnabled: boolean("crawl_enabled").notNull().default(true),
  /**
   * Counties queued per dispatcher tick.
   *
   * Sized to what one tick drains — measured 3.0s median, p90 8.1s, against a
   * 195-second claiming budget. Raising it past that grows the queue rather
   * than the throughput, because `enqueue` does not dedupe across days.
   */
  crawlMaxTasks: integer("crawl_max_tasks").notNull().default(50),
  /** Master switch for the standing research pass. */
  researchEnabled: boolean("research_enabled").notNull().default(true),
  /** Three-letter weekday at the desk, e.g. `Sun`. */
  researchWeekday: text("research_weekday").notNull().default("Sun"),
  /** States queued per weekly pass. Each is a paid searched call of 1-2 minutes. */
  researchStates: integer("research_states").notNull().default(4),
  /** Days that must pass before another pass may queue. Guards double-firing. */
  researchCooldownDays: integer("research_cooldown_days").notNull().default(6),
  updatedBy: text("updated_by").notNull().default("admin"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PipelineSettings = typeof pipelineSettings.$inferSelect;

/**
 * Every call that costs money, in the units the vendor bills.
 *
 * Nothing recorded spend before this, and unrecorded usage cannot be recovered
 * — a searched call that ran last Tuesday is gone. So this stores what was
 * *consumed* (exact, from the provider's own response) rather than a dollar
 * figure, and the money is computed at read time against rates the operator
 * sets. Vendor pricing changes and contracts differ; a price baked into a row
 * is wrong the moment either does, and silently.
 *
 * `operation` is what the call was for, not which function made it — "why did
 * this week cost more" is answered by purpose (research, PDF extraction,
 * property enrichment), never by call site.
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** `xai`, `anthropic`, `attom`, `rentcast`, `batchdata`. */
    provider: text("provider").notNull(),
    /** Model id where one applies, e.g. `grok-4.5`. Null for REST lookups. */
    model: text("model"),
    /** `scout-research`, `pdf-extract`, `cartographer`, `brief`, `enrich`. */
    operation: text("operation").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Billed web searches — the dominant cost of a research pass. */
    searchCalls: integer("search_calls"),
    /** REST lookups, for the per-request property APIs. */
    requests: integer("requests"),
    /** What it was about, so spend can be attributed to a state or county. */
    countyFips: text("county_fips"),
    note: text("note"),
  },
  (t) => [
    index("api_usage_at_idx").on(t.at),
    index("api_usage_op_idx").on(t.operation, t.at),
  ],
);

export type ApiUsage = typeof apiUsage.$inferSelect;

/**
 * Property lookups already answered, keyed by a normalised address.
 *
 * A searched lookup costs a Tavily call plus an extraction and takes about
 * twenty seconds. The same address asked twice should cost once — and on a
 * public search box the same address WILL be asked twice, because the parcels
 * people look up are the ones on a listing everybody is reading.
 *
 * Keyed on `address_key` rather than the raw string so that trailing
 * punctuation, casing and doubled spaces do not each buy their own row. The
 * normaliser is deliberately conservative — see `normaliseAddress` — because
 * over-normalising two different properties into one key is a wrong answer,
 * while under-normalising is only a wasted call.
 */
export const propertyLookups = pgTable(
  "property_lookups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Normalised key. Unique — one row per property, refreshed in place. */
    addressKey: text("address_key").notNull().unique(),
    /** Exactly what the reader typed, for display and for debugging the key. */
    queryText: text("query_text").notNull(),
    /** The validated `SearchedProperty`, as returned. */
    result: jsonb("result").notNull(),
    /** URLs actually read, so a cached answer still shows its sources. */
    citations: jsonb("citations").notNull(),
    /**
     * Whether the lookup found the property. Stored as a column rather than
     * read out of `result` because misses expire far sooner than hits, and the
     * expiry query should not have to open the document to find out which it is.
     */
    found: boolean("found").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** How many times this row was served instead of a fresh search. */
    hits: integer("hits").notNull().default(0),
  },
  (t) => [index("property_lookups_fetched_idx").on(t.fetchedAt)],
);

export type PropertyLookup = typeof propertyLookups.$inferSelect;

// ---------------------------------------------------------------------------
// Site intel — what surrounds a parcel, and what that does to its value
// ---------------------------------------------------------------------------

/**
 * Which way a signal cuts.
 *
 * Deliberately three values and not a number. A railroad 111m away is bad and
 * a park 200m away is good, but "how bad" in dollars is a question the data
 * cannot answer and the model is not allowed to — see `lib/deal/maxbid.ts` and
 * the division it protects. Direction plus distance is what we actually know,
 * and it is enough for the only job this serves: telling a bidder what is out
 * there before they drive four hours to look at it.
 */
export const signalDirectionEnum = pgEnum("signal_direction", [
  "negative",
  "positive",
  "neutral",
]);

/**
 * How much attention a signal deserves, not how many dollars it costs.
 *
 * `high` means a reasonable buyer would want to know before bidding — an active
 * rail mainline at the property line, an electrical substation next door, a
 * parcel inside a special flood hazard area, no public road touching the
 * boundary. `low` is context that colours a picture without changing a decision.
 */
export const signalSeverityEnum = pgEnum("signal_severity", ["high", "medium", "low"]);

/**
 * One observed fact about a parcel's surroundings.
 *
 * ## Why this is a table and not more columns on `lot_valuations`
 *
 * A valuation is one row per provider holding one opinion of a parcel's worth.
 * Surroundings are not like that: a single lot in an industrial corridor
 * produced eleven rail features, three power features, four industrial
 * land-use polygons and three streams inside 600 metres, and the count is
 * unbounded — a parcel next to a rail yard has dozens. Columns cannot hold a
 * list, and the list is the point.
 *
 * ## Why distance is stored per feature
 *
 * "Near a railroad" is not a fact; "111 metres from the UP Houston East Belt
 * Subdivision" is. The first is a judgement someone else has to re-derive and
 * cannot check. The second is what the reader wants and what makes the claim
 * falsifiable — they can open a map and see whether we are right.
 *
 * Distances are metres from the parcel's location as we know it, which is a
 * centroid for most parcels and a polygon edge where the cadastre published
 * one. `distanceBasis` records which, because a 111m centroid distance on a
 * forty-acre parcel may be zero metres from the boundary, and a reader
 * comparing two lots deserves to know the measurement changed meaning.
 */
export const lotSignals = pgTable(
  "lot_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    /**
     * Dotted taxonomy — `rail.mainline`, `power.substation`, `flood.zone`,
     * `landuse.industrial`, `access.road`, `terrain.elevation`,
     * `neighborhood.income`. Dotted rather than an enum because the vocabulary
     * grows every time a new layer is added, and a `pgEnum` would make each
     * addition a migration.
     */
    kind: text("kind").notNull(),
    /** Which fetcher produced it: `osm`, `fema`, `usgs`, `census`, `cadastre`. */
    source: text("source").notNull(),
    /**
     * A stable identity for this feature within its source, so a re-run updates
     * the row rather than inserting a duplicate. OSM's `way/12345`, FEMA's zone
     * for the point, `elevation` for a scalar. Without it, a nightly refresh
     * would multiply every parcel's signal count by the number of nights.
     */
    featureKey: text("feature_key").notNull(),

    direction: signalDirectionEnum("direction").notNull(),
    severity: signalSeverityEnum("severity").notNull(),
    /** What to call it on screen — "UP Houston East Belt Subdivision". */
    label: text("label").notNull(),
    /** Why it matters, in a sentence, written by code and never by a model. */
    note: text("note"),

    distanceM: integer("distance_m"),
    /** `centroid` or `boundary` — see the note above on what a distance means. */
    distanceBasis: text("distance_basis"),
    /** Scalar payload where the signal is a measurement: elevation, income, BFE. */
    value: numeric("value", { precision: 14, scale: 2 }),
    /** Categorical payload: a FEMA zone code, a zoning string. */
    valueText: text("value_text"),

    /** The source's own record, kept so a mapping bug is repairable for free. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_signals_identity_key").on(t.lotId, t.source, t.featureKey),
    /* The lot page's query: everything about this parcel, worst first. */
    index("lot_signals_lot_idx").on(t.lotId, t.severity),
    /* "Which lots sit near a rail line" — the screen this whole table exists for. */
    index("lot_signals_kind_idx").on(t.kind, t.distanceM),
  ],
);

export type LotSignal = typeof lotSignals.$inferSelect;

/**
 * What has been fetched for a parcel, from where, and when it went stale.
 *
 * The scheduler's whole job is choosing the next parcel to enrich, and it
 * cannot do that from `lot_signals` alone: a parcel with no rows is
 * indistinguishable from a parcel that was checked and genuinely has nothing
 * near it. Rural inventory makes that distinction constantly — most of these
 * parcels are meant to have no substation next door — and without this table
 * the loop would re-fetch every empty parcel forever and never reach a new one.
 *
 * A miss is therefore recorded as loudly as a hit, which is the same lesson
 * `ProviderUnavailableError` exists to enforce one layer up: not knowing and
 * knowing there is nothing are different states, and only one of them is a
 * fact about the property.
 */
export const lotIntelRuns = pgTable(
  "lot_intel_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    /** Matches `lot_signals.source`. One row per lot per source. */
    source: text("source").notNull(),
    /**
     * `ok` — answered, whether or not it found anything.
     * `empty` — answered, nothing within radius. A real result.
     * `failed` — could not be asked. Retried; never treated as an answer.
     * `skipped` — preconditions absent, e.g. no coordinates to query with.
     */
    status: text("status").notNull(),
    /** How many signals this fetch wrote. Zero is meaningful — see `empty`. */
    signalCount: integer("signal_count").notNull().default(0),
    error: text("error"),
    durationMs: integer("duration_ms"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_intel_runs_key").on(t.lotId, t.source),
    /* The scheduler's query: oldest first, per source. */
    index("lot_intel_runs_stale_idx").on(t.source, t.fetchedAt),
  ],
);

export type LotIntelRun = typeof lotIntelRuns.$inferSelect;

// ---------------------------------------------------------------------------
// CAPE Component Seven — produced education and video artifacts
// ---------------------------------------------------------------------------

/**
 * What has actually been produced for a county package, and from which inputs.
 *
 * ## Why the artifacts are recorded rather than detected
 *
 * `lib/cape/components.ts` reports Component Seven's four items — script,
 * audio, slide plan, video — and it must not answer by looking for files. A
 * file on a laptop is not evidence a package was produced, and a file that
 * exists for a *previous* version of the facts is worse than none: it would
 * report a narration as done while it described a sale date that has since been
 * confirmed, or a statute that has since been entered.
 *
 * So production is a row, and the row carries `inputsHash` — the identity of
 * the computed package the script was written from. When the package changes,
 * the hash changes, and the artifacts are stale by construction rather than by
 * anyone remembering to check.
 *
 * ## Why the script is stored and the media are paths
 *
 * The script is the reviewable artifact and the thing a person edits, so it
 * lives in the database where it can be read, diffed and corrected. Audio and
 * video are large binaries; the row records where they are and how big, and the
 * bytes live on disk. There is no blob storage configured in this project, and
 * inventing one here would be a deployment decision smuggled into a feature.
 */
export const capeProductions = pgTable(
  "cape_productions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),

    /**
     * Identity of the computed CAPE package this was written from.
     *
     * The staleness test, and the reason regenerating 152 packages does not
     * re-bill for speech: unchanged inputs mean the existing audio is still
     * correct. See `scriptInputsHash`.
     */
    inputsHash: text("inputs_hash").notNull(),

    /** The narration script and slide plan, as validated by `CapeScriptSchema`. */
    script: jsonb("script").$type<Record<string, unknown>>(),
    scriptModel: text("script_model"),
    /**
     * Figures the narration spoke that were not in the facts.
     *
     * Empty is the pass. Stored rather than merely logged because it is a
     * quality signal Component Nine reads: a script that invented a number is
     * not releasable, and the reviewer needs to know which number.
     */
    unsupportedFigures: jsonb("unsupported_figures").$type<string[]>(),

    slidePlanCount: integer("slide_plan_count"),
    audioPath: text("audio_path"),
    audioDurationSec: numeric("audio_duration_sec", { precision: 10, scale: 2 }),
    /** Billed unit for speech synthesis, kept so spend is attributable. */
    audioCharacters: integer("audio_characters"),
    videoPath: text("video_path"),
    videoDurationSec: numeric("video_duration_sec", { precision: 10, scale: 2 }),
    videoBytes: bigint("video_bytes", { mode: "number" }),

    /** `pending` · `script` · `audio` · `video` · `failed` — how far it got. */
    stage: text("stage").notNull().default("pending"),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One production per auction, replaced in place as it advances.
    uniqueIndex("cape_productions_auction_key").on(t.auctionId),
    index("cape_productions_stage_idx").on(t.stage, t.updatedAt),
  ],
);

export type CapeProduction = typeof capeProductions.$inferSelect;
