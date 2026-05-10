-- Functional indexes matching the lower(replace(customer, '@', '')) query pattern
-- used by lookupCustomerDetail, getInvoiceForCustomer payment/adjustment aggregations,
-- and other lookups. Without these, queries fall back to sequential scans and
-- can hit Postgres statement_timeout on tables of moderate size.

CREATE INDEX IF NOT EXISTS idx_customers_instagram_normalized
  ON customers (lower(replace(instagram_id, '@', '')));

CREATE INDEX IF NOT EXISTS idx_payments_customer_normalized
  ON payments (lower(replace(customer, '@', '')));

CREATE INDEX IF NOT EXISTS idx_adjustments_customer_normalized
  ON adjustments (lower(replace(customer, '@', '')));
