-- The last day of a sale that runs longer than one.
--
-- `sale_date` is the day a sale opens, and stays the only date most rows have.
-- Online sales often run several days — Santa Clara's opens Oct 30 and closes
-- Nov 2 — and a calendar that shows one day either hides the sale's first
-- days (if it stores the close) or its last (if it stores the open). The
-- calendar draws a sale on every day from `sale_date` through this column.
--
-- Null means a one-day sale, or a source that gave no end. Never earlier than
-- the start: the check rejects a reversed pair rather than storing it.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS sale_end_date date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auctions_sale_end_after_start') THEN
    ALTER TABLE auctions
      ADD CONSTRAINT auctions_sale_end_after_start
      CHECK (sale_end_date IS NULL OR sale_end_date >= sale_date);
  END IF;
END $$;
