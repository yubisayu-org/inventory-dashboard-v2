-- Align catalogue_posts with the naming the catalogue-order-requests line
-- settled on: the field is a title, not a caption.
--
-- Guarded rather than a bare RENAME because that branch carries its own
-- 086_catalogue_posts_caption_to_title.sql. Whichever lands first wins and the
-- other becomes a no-op, instead of the second one erroring on a column that
-- is already gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'catalogue_posts' AND column_name = 'caption'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'catalogue_posts' AND column_name = 'title'
  ) THEN
    ALTER TABLE catalogue_posts RENAME COLUMN caption TO title;
  END IF;
END
$$;
