-- Create payments table for tracking customer payments per event.

CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer   TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount     INTEGER NOT NULL DEFAULT 0,
  account    TEXT NOT NULL DEFAULT '',
  is_checked BOOLEAN NOT NULL DEFAULT FALSE,
  pay_date   TEXT NOT NULL DEFAULT '',
  remarks    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_payments_event_customer ON payments (event, lower(customer));
