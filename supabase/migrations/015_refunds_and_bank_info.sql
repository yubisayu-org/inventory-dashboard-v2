-- Bank account info for refund processing (stored on customer, reused across refunds)
ALTER TABLE customers
  ADD COLUMN bank_name           TEXT NOT NULL DEFAULT '',
  ADD COLUMN bank_account_number TEXT NOT NULL DEFAULT '',
  ADD COLUMN bank_account_holder TEXT NOT NULL DEFAULT '';

-- Refund tracking table
CREATE TABLE refunds (
  id              SERIAL PRIMARY KEY,
  event           TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer        TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reason          TEXT NOT NULL DEFAULT 'overpayment',
  -- 'overpayment' | 'unavailable' | 'shipping_loss' | 'damaged' | 'goodwill' | 'other'
  refund_amount   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'awaiting_bank_info' | 'ready_to_refund' | 'refunded' | 'applied_to_next_order' | 'cancelled'

  -- Snapshot of bank info used at time of transfer (in case customer updates details later)
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_account_holder TEXT NOT NULL DEFAULT '',
  transfer_reference  TEXT NOT NULL DEFAULT '',

  -- Link to the negative payment row once executed
  payment_id  INTEGER REFERENCES payments(id) ON DELETE SET NULL,

  -- Optional link to specific order line (for service-failure refunds)
  order_id       INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  affected_units INTEGER NOT NULL DEFAULT 0,

  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_refunds_event_customer ON refunds (event, lower(customer));
CREATE INDEX idx_refunds_status ON refunds (status);
CREATE INDEX idx_refunds_customer ON refunds (lower(customer));
