-- Daily counters for the paid features on the public domain.
--
-- deedpilot.app is open without the site password, and three things on it
-- spend money per use: the address lookup (RealEstateAPI), Street View images
-- (Google) and AI briefs (xAI). Each is capped per visitor — keyed on a hash
-- of the IP, never the IP itself — and in total, per UTC day. See
-- lib/site-gate/daily-limit.ts.
CREATE TABLE IF NOT EXISTS daily_limits (
  key   text NOT NULL,
  day   date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
