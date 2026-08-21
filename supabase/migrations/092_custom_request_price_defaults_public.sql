-- Let the customer-facing estimate read the custom-request pricing settings.
--
-- The columns themselves come from the catalogue-order-requests line's
-- 090_custom_request_price_defaults.sql, which moved 15/5000/0 out of code and
-- into Settings so the formula can change without a deploy. Added here guarded
-- so this branch is self-consistent on a fresh rebuild and whichever migration
-- runs second is a no-op rather than an error.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS custom_request_profit_pct numeric(6,2) NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS custom_request_operational_fee integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS custom_request_packing_fee integer NOT NULL DEFAULT 0;

-- Three columns only. The public estimate has no business reading the Add
-- Product defaults, the flat-fee ladder, or anything else on this row.
GRANT SELECT (custom_request_profit_pct, custom_request_operational_fee,
              custom_request_packing_fee)
  ON product_defaults TO catalogue_public;
