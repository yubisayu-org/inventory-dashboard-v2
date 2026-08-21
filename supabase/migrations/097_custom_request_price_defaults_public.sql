-- Let the customer-facing estimate read the custom-request pricing settings.
--
-- The columns come from 090_custom_request_price_defaults.sql, which moved
-- 15/5000/0 out of code and into Settings so the formula can change without a
-- deploy. This adds only the grant the public estimate needs.
--
-- Three columns, not the row. The public estimate has no business reading the
-- Add Product defaults, the flat-fee ladder, or anything else here.
GRANT SELECT (custom_request_profit_pct, custom_request_operational_fee,
              custom_request_packing_fee)
  ON product_defaults TO catalogue_public;
