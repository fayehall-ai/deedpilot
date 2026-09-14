-- The half of a briefing script that is about the county, not the sale.
--
-- 815 upcoming sales sit in 523 counties, so 292 are a repeat visit to a county
-- already covered — Monmouth NJ holds nineteen in six weeks. Each regenerated
-- the statute, redemption, deed and submarket sections from scratch, and none of
-- those can differ between two sales in the same county under the same statute.
--
-- Paid for twice: once in model calls, and again in speech, because the audio
-- cache is keyed by each section's exact text and a model never writes the same
-- paragraph twice. Reusing the text makes the audio saving free.
--
-- Keyed per county AND sale type: a county running both a deed sale and a lien
-- sale is telling a bidder two different stories about what they are buying, and
-- the statute sections are exactly where those diverge.
CREATE TABLE IF NOT EXISTS cape_county_scripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_fips  text NOT NULL REFERENCES counties(fips),
  sale_type    text NOT NULL,
  inputs_hash  text NOT NULL,
  sections     jsonb NOT NULL,
  script_model text,
  used_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cape_county_scripts_key
  ON cape_county_scripts (county_fips, sale_type);
