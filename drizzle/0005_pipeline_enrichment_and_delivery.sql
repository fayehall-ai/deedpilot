-- Settings for the two production lines that now run unattended.
--
-- enrich_*: the enrichment pass buys parcel data per request (RentCast, ATTOM,
-- BatchData). It stops at a weekly dollar figure Ed sets and falls back to the
-- free assessor layers for the rest of the week.
--
-- video_top_n: how many upcoming sales, largest by parcel count, get a rendered
-- briefing and a framework document delivered to Drive — "only the top ones",
-- as the last hand-made batch of sixteen was.
ALTER TABLE pipeline_settings ADD COLUMN IF NOT EXISTS enrich_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE pipeline_settings ADD COLUMN IF NOT EXISTS enrich_weekly_budget_dollars integer NOT NULL DEFAULT 20;
ALTER TABLE pipeline_settings ADD COLUMN IF NOT EXISTS video_top_n integer NOT NULL DEFAULT 16;
