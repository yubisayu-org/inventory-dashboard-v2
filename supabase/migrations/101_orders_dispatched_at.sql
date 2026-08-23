-- When a parcel actually left, so the receiving list can say how long it has
-- been travelling.
--
-- updated_at cannot answer this: it moves whenever anything touches the row,
-- and checking in half a parcel is exactly such a touch. A box would appear to
-- reset its age at the moment you started receiving it, which is the moment
-- the age matters most.
--
-- Set once, when unit_dispatch is first written. Left alone afterwards: a
-- correction to the receipt or a partial arrival is not a second departure.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE excess_purchase ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.dispatched_at IS
  'When this line was dispatched. Set on first dispatch, never overwritten.';

-- Backfill from updated_at for lines already dispatched. Approximate by
-- definition — updated_at may have moved since — but better than every
-- existing parcel reading as dispatched today.
UPDATE orders
   SET dispatched_at = updated_at
 WHERE dispatched_at IS NULL
   AND COALESCE(unit_dispatch, 0) > 0;

UPDATE excess_purchase
   SET dispatched_at = updated_at
 WHERE dispatched_at IS NULL
   AND COALESCE(unit_dispatch, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_orders_dispatched_at
  ON orders (dispatched_at) WHERE dispatched_at IS NOT NULL;
