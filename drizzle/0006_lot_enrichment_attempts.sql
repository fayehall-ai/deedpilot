-- When the enrichment pass last asked about a parcel.
--
-- A parcel no provider can match would otherwise be picked again on every tick
-- and paid for again every time. The pass stamps this before it asks, and skips
-- parcels asked within the last fortnight. Not written by crawls, so a re-crawl
-- cannot reset it.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS enrichment_attempted_at timestamptz;

-- The same, for the free geocoder: a parcel whose address it cannot place is
-- not offered to it again for a fortnight, so the pass reaches the addresses it
-- can place instead of re-asking about "0 UNKNOWN CHOCTAW" every ten minutes.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS geocode_attempted_at timestamptz;
