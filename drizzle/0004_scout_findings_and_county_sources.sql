-- Auction Scout findings a person has to look at, and crawl sources found at
-- runtime rather than committed.
--
-- scout_findings: the AI research writes a sale straight into the calendar only
-- when it is confirmed against the county's own page. Everything else — a
-- platform listing, a date the model could not confirm, a date that disagrees
-- with the calendar by a day or two, a county it could not place — waits here
-- for Ed. One row per state, county and date: the weekly research finding the
-- same sale again refreshes the row rather than adding another.
CREATE TABLE IF NOT EXISTS scout_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid REFERENCES run_jobs(id) ON DELETE SET NULL,
  state       text NOT NULL,
  county      text NOT NULL,
  county_key  text NOT NULL,
  sale_date   date NOT NULL,
  finding     jsonb NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  outcome     text,
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scout_findings_key ON scout_findings (state, county_key, sale_date);
CREATE INDEX IF NOT EXISTS scout_findings_status ON scout_findings (status);

-- county_sources: a county's own property-list page, found by the Scout (or
-- entered by an operator), merged into the Prospector's registry at runtime.
-- The registry is a committed file and changes only with a redeploy; a list the
-- Scout finds on Sunday should be crawlable on Sunday.
CREATE TABLE IF NOT EXISTS county_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_fips text NOT NULL REFERENCES counties(fips),
  url         text NOT NULL,
  kind        text NOT NULL DEFAULT 'listing',
  origin      text NOT NULL,
  note        text,
  enabled     boolean NOT NULL DEFAULT true,
  added_by    text NOT NULL DEFAULT 'system',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS county_sources_key ON county_sources (county_fips, url);
