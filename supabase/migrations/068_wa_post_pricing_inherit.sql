-- A post inherits the WhatsApp pricing default instead of snapshotting it.
--
-- Snapshotting at capture time meant changing the setting fixed only the shelves
-- posted after it: every shelf already on file kept the old method and had to be
-- corrected one at a time, which is the opposite of what a default is for.
--
-- NULL now means "whatever the WhatsApp setting says at the moment this shelf is
-- priced". The snapshot still happens — it just happens later, at naming, which
-- is the first moment the method turns into money. After that the post holds a
-- concrete method forever, because its products and orders exist and repricing
-- them would change what customers have been quoted.
--
-- The CHECK constraint needs no change: a CHECK over NULL evaluates to NULL,
-- which passes.
ALTER TABLE wa_posts ALTER COLUMN pricing_method DROP NOT NULL;
ALTER TABLE wa_posts ALTER COLUMN pricing_method DROP DEFAULT;

-- Existing shelves that were never named go back to inheriting. They are all
-- carrying whatever the default happened to be on the day they were captured,
-- which is exactly the stale value this change exists to stop honouring.
--
-- A deliberate per-post override on an unnamed shelf is lost here. That is
-- accepted: the overrides on file are indistinguishable from captured defaults,
-- and an unnamed shelf can be re-pointed in one click on its review page.
UPDATE wa_posts p
SET pricing_method = NULL
WHERE p.pricing_method IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM wa_slots s WHERE s.post_id = p.id AND s.product_id IS NOT NULL
  );
