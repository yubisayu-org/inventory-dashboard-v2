-- The customer-facing copy of a shelf, and the archiving of the original.
--
-- Two files per shelf from here: the 3000px JPEG the owner reads price tags
-- from, and a 2250px AVIF at about a fifth the bytes for anyone browsing the
-- catalogue. The AVIF is what survives a closed trip.

-- Where the catalogue copy lives, in the public bucket. Empty until one has
-- been written, which is every shelf captured before this migration.
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS view_path TEXT NOT NULL DEFAULT '';

-- Set when the 3000px original has been deleted. The row stays, the catalogue
-- copy stays, and the screens that need the original degrade rather than fail.
--
-- Deliberately per trip rather than per named SKU: a live trip can always take
-- another claim, and /rekap, slot crops, the catalogue and the matcher that
-- places a late reply all read the original.
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN wa_posts.view_path IS 'AVIF catalogue copy in the public bucket, or empty.';
COMMENT ON COLUMN wa_posts.archived_at IS 'When the full-size original was deleted. Null while it exists.';
