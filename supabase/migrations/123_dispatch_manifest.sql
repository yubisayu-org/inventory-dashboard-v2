-- What was actually in each box.
--
-- `orders.unit_dispatch` and `orders.dispatch_receipt` have always carried two
-- different facts in the same two columns: "three units went in CJI-2607", and
-- "sepatu_kaca's three units are in CJI-2607". A box therefore appeared to OWN
-- customers.
--
-- That was survivable until arrival started reassigning units to whoever paid
-- first (migration-free, Aug 2026): the receipt now MOVES when a unit is served
-- out of a different box, so afterwards the row answers "who ended up served",
-- not "what was packed". Fine most days. Wrong exactly when it matters -- a box
-- goes missing, arrives short, or the courier disputes it, and the manifest as
-- packed is the thing you need.
--
-- So the manifest gets its own table and stops moving. `orders.dispatch_receipt`
-- keeps its current meaning and arrival goes on reassigning it.
--
-- One row per (box, product, dispatch event). A line dispatched in two batches
-- is two rows, which is what lets a part-filled line say when each part left.

CREATE TABLE IF NOT EXISTS dispatch_manifest (
  id            BIGSERIAL PRIMARY KEY,
  event         TEXT        NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  product_id    INTEGER     NOT NULL REFERENCES products(id),
  -- The box, as it is known to the courier. Renames are followed rather than
  -- kept: the working label ("Box 7", "Inaba") is what got typed while packing,
  -- and the tracking number is what anybody can look up afterwards.
  receipt       TEXT        NOT NULL,
  qty           INTEGER     NOT NULL CHECK (qty > 0),
  -- Whether these units belonged to somebody when they were packed. Surplus
  -- travels in the same parcel through excess_purchase and has no customer, so
  -- nothing on the orders side can ever answer for it -- without this, every
  -- box carrying surplus reads as short on the page built to settle exactly
  -- that question.
  source        TEXT        NOT NULL DEFAULT 'order'
                CHECK (source IN ('order', 'surplus')),
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reading a box is the whole point, and reading a trip is how the dispatch
-- document is built.
CREATE INDEX IF NOT EXISTS dispatch_manifest_receipt_idx
  ON dispatch_manifest (upper(receipt));
CREATE INDEX IF NOT EXISTS dispatch_manifest_event_idx
  ON dispatch_manifest (event, receipt);

COMMENT ON TABLE dispatch_manifest IS
  'What physically went in each box. Never rewritten when arrival reassigns a unit -- that moves orders.dispatch_receipt, which answers who was served.';
COMMENT ON COLUMN dispatch_manifest.source IS
  'order = somebody ordered it, so orders can say who was served. surplus = overbuy riding along, which nobody is owed.';
COMMENT ON COLUMN dispatch_manifest.qty IS
  'Units of this product that went into this box in one dispatch. Two batches into one box are two rows.';
