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

export const lotStatusEnum = pgEnum("lot_status", [
  "pending", // listed, not yet sold
  "sold",
  "redeemed", // owner paid before the sale
  "cancelled",
  "struck", // no bid; struck to the county/state
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
