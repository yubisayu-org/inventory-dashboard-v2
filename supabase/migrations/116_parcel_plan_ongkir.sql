-- What the parcels really cost, and who decided it.
--
-- adjustments.auto marks a row the system owns. The reconciler reads and
-- writes only its own, because the owner has been doing this by hand for
-- months and one of her nine discounts is worded exactly like the system's.
-- Matching on the description would rewrite it and say nothing.
ALTER TABLE adjustments ADD COLUMN auto boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN adjustments.auto IS
  'True when the parcel-plan reconciler owns this row. Never set by hand.';

-- Who chose the shipping plan. A staff-recorded merge that looks like the
-- customer's own invites her to change it, undoing a parcel already packed.
ALTER TABLE customer_shipping_prefs
  ADD COLUMN set_by text NOT NULL DEFAULT 'customer';

ALTER TABLE customer_shipping_prefs
  ADD CONSTRAINT customer_shipping_prefs_set_by_check
  CHECK (set_by IN ('customer', 'shop'));

-- What the courier actually charged, when it disagreed with the estimate.
-- NULL means it did not, which is most parcels and needs nothing recorded.
-- weight_estimation already holds CEIL(kg) -- billed kilos, not grams -- so
-- this is a whole number off the receipt.
ALTER TABLE shipments ADD COLUMN weight_charged integer;

COMMENT ON COLUMN shipments.weight_charged IS
  'Kilos the courier billed, when that differed from weight_estimation. NULL means it did not.';

-- Finding the reconciler's rows for one customer is the hot path: it runs on
-- every arrival, every mark, and every press.
CREATE INDEX IF NOT EXISTS idx_adjustments_auto
  ON adjustments (event, customer) WHERE auto;
