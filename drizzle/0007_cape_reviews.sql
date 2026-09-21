-- Ed's verdicts on briefing scripts.
--
-- They used to live in the proofreading artifact's own storage, where nothing
-- in production could read them. Here, a "needs a change" note becomes part of
-- that sale's script inputs: the script is rewritten with the note handed to
-- the narrator as a confirmed correction, and its video re-rendered and
-- replaced in Drive.
CREATE TABLE IF NOT EXISTS cape_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id  uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  verdict     text NOT NULL,
  note        text,
  script_hash text,
  reviewer    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cape_reviews_auction ON cape_reviews (auction_id, created_at);
