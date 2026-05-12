-- Classify excess_purchase rows by why they exist:
--   'overbuy'       — we intentionally bought more than orders demanded (default; existing rows)
--   'overship'      — supplier shipped extras of the correct SKU
--   'wrong_product' — supplier shipped a different SKU; expected_item tracks what we ordered
ALTER TABLE excess_purchase
  ADD COLUMN reason        TEXT NOT NULL DEFAULT 'overbuy',
  ADD COLUMN expected_item TEXT;

CREATE INDEX idx_excess_reason ON excess_purchase (reason);
