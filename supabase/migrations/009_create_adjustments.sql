-- Adjustments table for extra fees / discounts (biaya lainnya) per customer per event.
-- Positive amount = extra charge, negative amount = discount.

CREATE TABLE adjustments (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer    TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX idx_adjustments_event_customer ON adjustments (event, lower(customer));
