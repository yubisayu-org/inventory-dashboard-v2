-- SKU slots, and buying recorded against individual claims.
--
-- Two changes that belong together.
--
-- A shelf item that three people want in 90 and two want in 95 is two things to
-- pick up, two products at naming, and two lines on the shopping list. So size
-- moves out of the claim's free text and onto the slot, and a position on the
-- photograph can now carry more than one slot.
--
-- And `bought` moves from the slot onto the claim. The owner reacts to a
-- customer's message with a tick as the item goes in the basket, which says
-- exactly WHO got one — strictly more than a count does. The stepper in the shop
-- still records a bare number, but it now spends that number across the claims
-- by payment priority rather than storing it somewhere else. One field, two ways
-- in, nothing to reconcile.

-- Working name. Not the product name: naming a slot creates a product and the
-- orders behind it, which is a much later and much heavier act. This exists so a
-- list can say "Brown Bear Set" instead of "Slot 4" while shopping.
ALTER TABLE wa_slots ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

-- Empty means "nobody said a size", which is a real and common state, not a
-- missing value. Those claims group together and the owner splits them by hand
-- if it turns out to matter.
ALTER TABLE wa_slots ADD COLUMN IF NOT EXISTS size TEXT NOT NULL DEFAULT '';

-- How many of THIS claim were obtained. Zero until something says otherwise.
ALTER TABLE wa_claims ADD COLUMN IF NOT EXISTS obtained INTEGER NOT NULL DEFAULT 0;

-- Carry the old per-slot tallies onto the claims before the column goes, so a
-- database that already has counts does not lose them. Spread by claim id,
-- which is arrival order — the same tie-break compareOrderPriority falls back to.
DO $$
DECLARE
  slot RECORD;
  claim RECORD;
  remaining INTEGER;
  give INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wa_slots' AND column_name = 'bought'
  ) THEN
    RETURN;
  END IF;

  FOR slot IN SELECT id, bought FROM wa_slots WHERE bought > 0 LOOP
    remaining := slot.bought;
    FOR claim IN
      SELECT id, quantity FROM wa_claims
      WHERE slot_id = slot.id AND state <> 'rejected'
      ORDER BY id ASC
    LOOP
      EXIT WHEN remaining <= 0;
      give := LEAST(claim.quantity, remaining);
      UPDATE wa_claims SET obtained = give WHERE id = claim.id;
      remaining := remaining - give;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE wa_slots DROP COLUMN IF EXISTS bought;

-- One slot per position per size. Without this a re-cluster that produced two
-- sizes at the same centre could write two rows that later match each other
-- when bought/product are carried forward.
CREATE INDEX IF NOT EXISTS idx_wa_slots_post_size ON wa_slots (post_id, size);
